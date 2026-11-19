// ig-comments (JWT admin)
//  {acao:"atualizar"}  -> baixa os comentários dos últimos 30 posts e analisa EM SEGUNDO PLANO
//                         (responde na hora com status "processando"; a tela fica olhando ig_commenter_cache)
//  {acao:"responder", comment_id, texto} -> responde no próprio comentário (POST /{comment_id}/replies)
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";
import { blocoVoz, carregarMarca, carregarVoz, iaJSON, semTravessao, temIA } from "../_shared/ia.ts";
import { graph } from "../_shared/instagram.ts";

type Comentario = { id: string; text: string; timestamp: string; username: string; respondido: boolean; respostas: number };

const PERGUNTA = /\?|^(como|qual|quais|quanto|quando|onde|por ?que|pq|cad[eê]|tem|voc[eê]s? (tem|faz|vende)|d[aá] pra|serve|funciona)\b/i;

async function baixarComentarios(db: SupabaseClient, minhaConta: string) {
  const r = await graph(db, "/me/media?fields=id,caption,timestamp,permalink,comments_count&limit=30");
  if (!r.ok) throw new Error("A Meta não devolveu os posts: " + (r.json?.error?.message ?? r.status));
  const posts = (r.json.data ?? []) as { id: string; caption?: string; timestamp: string; permalink: string; comments_count?: number }[];

  for (const p of posts) {
    const todos: Comentario[] = [];
    if (p.comments_count) {
      let url = `/${p.id}/comments?fields=id,text,timestamp,username,from,replies{username,text}&limit=50`;
      for (let pagina = 0; pagina < 6 && url; pagina++) {
        const c = await graph(db, url);
        if (!c.ok) break;
        for (const x of c.json.data ?? []) {
          const autor = x.username ?? x.from?.username ?? "";
          if (autor.toLowerCase() === minhaConta) continue; // ignora os meus
          const respostas = x.replies?.data ?? [];
          todos.push({
            id: x.id, text: x.text ?? "", timestamp: x.timestamp, username: autor,
            respondido: respostas.some((rr: { username?: string }) => String(rr.username ?? "").toLowerCase() === minhaConta),
            respostas: respostas.length,
          });
        }
        url = c.json.paging?.next ?? "";
      }
    }
    await db.from("ig_post_comments").upsert({
      media_id: p.id, comentarios: todos, n: todos.length, post_ts: p.timestamp, permalink: p.permalink,
      caption: (p.caption ?? "").slice(0, 300), updated_at: new Date().toISOString(),
    }, { onConflict: "media_id" });
  }
  return posts.length;
}

async function analisar(db: SupabaseClient) {
  const marca = await carregarMarca(db);
  const minhaConta = marca.instagram.toLowerCase();
  await db.from("ig_commenter_cache").upsert({ id: "atual", status: "processando", erro: null, updated_at: new Date().toISOString() });
  try {
    const nPosts = await baixarComentarios(db, minhaConta);
    const { data: linhas } = await db.from("ig_post_comments").select("*").order("post_ts", { ascending: false }).limit(30);
    const todos = (linhas ?? []).flatMap((l: { media_id: string; permalink: string; caption: string; comentarios: Comentario[] }) =>
      (l.comentarios ?? []).map((c) => ({ ...c, media_id: l.media_id, permalink: l.permalink, post: l.caption })));

    // Contas feitas em código (a IA não inventa número)
    const fas = new Map<string, number>();
    for (const c of todos) if (c.username) fas.set(c.username, (fas.get(c.username) ?? 0) + 1);
    const topFas = [...fas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([username, n]) => ({ username, comentarios: n }));
    const perguntas = todos.filter((c) => !c.respondido && PERGUNTA.test(c.text.trim()))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 80);

    let temas: { tema: string; resumo: string; exemplos: string[]; quantidade: number }[] = [];
    let perguntasIA: { comment_id: string; por_que: string; sugestao_resposta: string }[] = [];
    let semIA = null;
    if (!temIA()) {
      semIA = "Sem chave de IA: mostrando só as contas (top fãs e perguntas). Configure ANTHROPIC_API_KEY pra ver os temas.";
    } else if (todos.length) {
      const voz = await carregarVoz(db);
      const amostra = todos.slice(0, 400).map((c) => `- @${c.username}: ${c.text.replace(/\s+/g, " ").slice(0, 220)}`).join("\n");
      const listaPerg = perguntas.map((c) => `[${c.id}] @${c.username}: ${c.text.replace(/\s+/g, " ").slice(0, 220)}`).join("\n");
      const r = await iaJSON<{ temas: typeof temas; perguntas: typeof perguntasIA }>({
        sistema: blocoVoz(marca, voz) + "\nVocê analisa comentários do Instagram. Seja concreto e curto.",
        prompt: `Comentários recentes (${todos.length} no total, amostra abaixo):\n${amostra}\n\n` +
          `Perguntas ainda sem resposta (id entre colchetes):\n${listaPerg || "(nenhuma)"}\n\n` +
          "1) Agrupe os comentários em até 8 temas mais falados (tema curto, resumo de 1 frase, até 3 exemplos literais, quantidade aproximada).\n" +
          "2) Das perguntas sem resposta, escolha as até 15 mais importantes de responder (dúvida real, que vira conteúdo ou venda). " +
          "Pra cada uma devolva o comment_id exatamente como veio, por que importa (1 frase) e uma sugestão de resposta curta na voz da marca.",
        schema: {
          type: "object", additionalProperties: false, required: ["temas", "perguntas"],
          properties: {
            temas: { type: "array", items: { type: "object", additionalProperties: false, required: ["tema", "resumo", "exemplos", "quantidade"],
              properties: { tema: { type: "string" }, resumo: { type: "string" }, exemplos: { type: "array", items: { type: "string" } }, quantidade: { type: "integer" } } } },
            perguntas: { type: "array", items: { type: "object", additionalProperties: false, required: ["comment_id", "por_que", "sugestao_resposta"],
              properties: { comment_id: { type: "string" }, por_que: { type: "string" }, sugestao_resposta: { type: "string" } } } },
          },
        },
      });
      temas = semTravessao(r.temas);
      perguntasIA = semTravessao(r.perguntas);
    }

    const destaque = new Map(perguntasIA.map((p) => [p.comment_id, p]));
    const payload = {
      posts: nPosts, comentarios: todos.length, temas, top_fas: topFas, aviso: semIA,
      perguntas: perguntas.map((c) => ({
        comment_id: c.id, username: c.username, texto: c.text, timestamp: c.timestamp, permalink: c.permalink, post: c.post,
        destaque: destaque.has(c.id), por_que: destaque.get(c.id)?.por_que ?? null, sugestao: destaque.get(c.id)?.sugestao_resposta ?? null,
      })).sort((a, b) => Number(b.destaque) - Number(a.destaque)),
    };
    await db.from("ig_commenter_cache").upsert({ id: "atual", status: "pronto", payload, erro: null,
      generated_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    await db.from("ig_commenter_cache").upsert({ id: "atual", status: "erro",
      erro: e instanceof Error ? e.message.slice(0, 400) : "erro", updated_at: new Date().toISOString() });
  }
}

servir(async (req) => {
  const { db } = await exigirAdmin(req);
  const body = await req.json().catch(() => ({}));

  if (body.acao === "responder") {
    const id = String(body.comment_id ?? "").trim();
    const texto = String(body.texto ?? "").trim();
    if (!/^\d+$/.test(id) || !texto) throw new HttpError(400, "Falta o comentário ou o texto da resposta.");
    const r = await graph(db, `/${id}/replies`, { method: "POST", body: JSON.stringify({ message: texto.slice(0, 2000) }) });
    if (!r.ok) throw new HttpError(502, "O Instagram não aceitou a resposta: " + (r.json?.error?.message ?? r.status));
    // Marca como respondida no cache, pra sair da lista
    const { data: c } = await db.from("ig_commenter_cache").select("payload").eq("id", "atual").maybeSingle();
    if (c?.payload?.perguntas) {
      c.payload.perguntas = c.payload.perguntas.filter((p: { comment_id: string }) => p.comment_id !== id);
      await db.from("ig_commenter_cache").update({ payload: c.payload }).eq("id", "atual");
    }
    return json({ ok: true, id: r.json.id });
  }

  // Atualizar: responde já e trabalha em segundo plano
  const { data: atual } = await db.from("ig_commenter_cache").select("status, updated_at").eq("id", "atual").maybeSingle();
  if (atual?.status === "processando" && Date.now() - new Date(atual.updated_at).getTime() < 5 * 60e3) {
    return json({ ok: true, status: "processando" });
  }
  await db.from("ig_commenter_cache").upsert({ id: "atual", status: "processando", erro: null, updated_at: new Date().toISOString() });
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(analisar(db));
  return json({ ok: true, status: "processando" });
});
