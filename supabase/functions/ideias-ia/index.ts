// ideias-ia (JWT admin). Chave de IA só no secret ANTHROPIC_API_KEY.
//  {modo:"gerar"}                         -> 10 ideias a partir da voz, dos melhores posts e das perguntas dos comentários
//  {modo:"tema", tema}                    -> 10 ideias sobre um tema
//  {modo:"variacoes", media_id}           -> 10 variações de um post que bombou
//  {modo:"roteiro", titulo, descricao?, formato?} -> 1 roteiro em 5 cenas
//  {modo:"voz"}                           -> 3 legendas curtas pra testar a voz
//  {modo:"carrossel", titulo, descricao?, slides?} -> textos dos slides de um carrossel
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";
import { blocoVoz, carregarMarca, carregarVoz, iaJSON, semTravessao } from "../_shared/ia.ts";

const PALAVRAS_POR_SEGUNDO = 2.5;

const CENAS = ["gancho", "contexto", "virada", "prova", "cta"] as const;
const SCHEMA_ROTEIRO = {
  type: "object", additionalProperties: false, required: [...CENAS],
  properties: Object.fromEntries(CENAS.map((c) => [c, { type: "string" }])),
};
const SCHEMA_IDEIA = {
  type: "object", additionalProperties: false,
  required: ["titulo", "gancho", "formato", "objetivo", "por_que", "tags", "roteiro"],
  properties: {
    titulo: { type: "string" },
    gancho: { type: "string" },
    formato: { type: "string", enum: ["reel", "carrossel", "story", "foto", "live"] },
    objetivo: { type: "string", enum: ["crescer", "engajar", "vender"] },
    por_que: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    roteiro: SCHEMA_ROTEIRO,
  },
};
const SCHEMA_LISTA = {
  type: "object", additionalProperties: false, required: ["ideias"],
  properties: { ideias: { type: "array", items: SCHEMA_IDEIA } },
};

type Roteiro = Record<(typeof CENAS)[number], string>;
type Ideia = { titulo: string; gancho: string; formato: string; objetivo: string; por_que: string; tags: string[]; roteiro: Roteiro };

const palavras = (t: string) => String(t || "").trim().split(/\s+/).filter(Boolean).length;
function comDuracao(r: Roteiro) {
  const n = CENAS.reduce((s, c) => s + palavras(r[c]), 0);
  return { ...r, palavras: n, duracao_s: Math.round(n / PALAVRAS_POR_SEGUNDO) };
}

async function melhoresPosts(db: SupabaseClient, n = 8) {
  for (const d of [90, 30, 0, 7]) {
    const { data } = await db.from("ig_insights_cache").select("payload").eq("days", d).maybeSingle();
    const posts = data?.payload?.posts;
    if (posts?.length) {
      return [...posts].sort((a: { reach: number }, b: { reach: number }) => (Number(b.reach) || 0) - (Number(a.reach) || 0))
        .slice(0, n).map((p: Record<string, unknown>) => ({
          id: p.id, formato: p.formato, legenda: String(p.caption ?? "").slice(0, 300), alcance: p.reach, views: p.views,
          salvamentos: p.saved, compartilhamentos: p.shares, comentarios: p.comments, retencao_s: p.retencao_s,
        }));
    }
  }
  return [];
}

async function perguntasDoPublico(db: SupabaseClient, n = 20) {
  const { data } = await db.from("ig_commenter_cache").select("payload").eq("id", "atual").maybeSingle();
  const temas = (data?.payload?.temas ?? []).map((t: { tema: string; resumo: string }) => `${t.tema}: ${t.resumo}`);
  const perg = (data?.payload?.perguntas ?? []).slice(0, n).map((p: { texto: string }) => p.texto.slice(0, 200));
  return { temas, perguntas: perg };
}

const REGRAS_IDEIAS =
  "Regras: exatamente 10 ideias. Pelo menos 5 com objetivo crescer ou engajar e no máximo 2 com objetivo vender. " +
  "O gancho é a primeira frase falada, literal, que prende nos 2 primeiros segundos. " +
  "Roteiro em 5 cenas curtas pra falar em câmera (gancho, contexto, virada, prova, cta); a cena gancho repete o gancho. " +
  "Fala normal tem 2,5 palavras por segundo: um reel bom tem de 20 a 45 segundos (50 a 110 palavras no total). " +
  "por_que: 1 frase dizendo por que essa ideia deve funcionar com esse público. tags: 1 a 3 palavras curtas.";

servir(async (req) => {
  const { db } = await exigirAdmin(req);
  const b = await req.json().catch(() => ({}));
  const modo = String(b.modo ?? "gerar");
  const marca = await carregarMarca(db);
  const voz = await carregarVoz(db);
  const sistema = blocoVoz(marca, voz) + "\nVocê é roteirista de conteúdo pra Instagram. Responda só com o JSON pedido.";

  if (modo === "gerar" || modo === "tema" || modo === "variacoes") {
    let contexto = "";
    let origem = "ia";
    if (modo === "gerar") {
      const [top, pub] = await Promise.all([melhoresPosts(db), perguntasDoPublico(db)]);
      contexto = `Posts que mais deram certo (com números):\n${JSON.stringify(top)}\n\n` +
        `Temas mais falados nos comentários:\n${pub.temas.join("\n") || "(sem dados)"}\n\n` +
        `Perguntas do público ainda sem resposta:\n${pub.perguntas.join("\n") || "(sem dados)"}\n\n` +
        "Gere 10 ideias novas que aproveitem o que já funcionou e respondam o que o público pergunta.";
      if (pub.perguntas.length) origem = "comentarios";
    } else if (modo === "tema") {
      const tema = String(b.tema ?? "").trim();
      if (!tema) throw new HttpError(400, "Escreva um tema.");
      contexto = `Tema pedido: ${tema.slice(0, 500)}\nGere 10 ideias diferentes entre si sobre esse tema, com ângulos variados.`;
    } else {
      const { data } = await db.from("ig_insights_cache").select("payload").in("days", [0, 90, 30, 7]);
      const post = (data ?? []).flatMap((x: { payload: { posts?: Record<string, unknown>[] } }) => x.payload?.posts ?? [])
        .find((p: Record<string, unknown>) => p.id === b.media_id);
      if (!post) throw new HttpError(400, "Não achei esse post nos dados. Atualize a aba 📊 Instagram e tente de novo.");
      contexto = `Post que bombou:\n${JSON.stringify(post)}\n\n` +
        "Gere 10 variações desse post: mesmo motivo de ter funcionado, ângulos, ganchos ou formatos diferentes. Não repita o mesmo texto.";
    }
    const r = await iaJSON<{ ideias: Ideia[] }>({ sistema, prompt: `${contexto}\n\n${REGRAS_IDEIAS}`, schema: SCHEMA_LISTA, esforco: "medium" });
    const ideias = semTravessao(r.ideias).slice(0, 10).map((i) => ({ ...i, origem, roteiro: comDuracao(i.roteiro) }));
    return json({ ok: true, ideias });
  }

  if (modo === "roteiro") {
    const titulo = String(b.titulo ?? "").trim();
    if (!titulo) throw new HttpError(400, "A ideia precisa de um título.");
    const r = await iaJSON<Roteiro>({
      sistema,
      prompt: `Ideia: ${titulo}\n${b.descricao ? `Descrição: ${String(b.descricao).slice(0, 1500)}\n` : ""}Formato: ${b.formato ?? "reel"}\n\n` +
        "Escreva o roteiro em 5 cenas curtas pra falar em câmera (gancho, contexto, virada, prova, cta). " +
        "O gancho é a primeira frase, literal. Fala normal tem 2,5 palavras por segundo; mire entre 25 e 45 segundos.",
      schema: SCHEMA_ROTEIRO, max: 4000, esforco: "medium",
    });
    return json({ ok: true, roteiro: comDuracao(semTravessao(r)) });
  }

  if (modo === "voz") {
    const r = await iaJSON<{ legendas: string[] }>({
      sistema,
      prompt: "Escreva 3 legendas curtas de Instagram (de 2 a 5 frases cada), sobre 3 pilares diferentes, pra eu ver se soam como eu. Sem hashtag.",
      schema: { type: "object", additionalProperties: false, required: ["legendas"], properties: { legendas: { type: "array", items: { type: "string" } } } },
      max: 3000, esforco: "low",
    });
    return json({ ok: true, legendas: semTravessao(r.legendas).slice(0, 3) });
  }

  if (modo === "carrossel") {
    const titulo = String(b.titulo ?? "").trim();
    if (!titulo) throw new HttpError(400, "Diga sobre o que é o carrossel.");
    const n = Math.min(Math.max(Number(b.slides) || 7, 3), 10);
    const r = await iaJSON<{ slides: { modelo: string; titulo: string; texto: string; itens: string[] }[] }>({
      sistema,
      prompt: `Carrossel sobre: ${titulo}\n${b.descricao ? `Contexto: ${String(b.descricao).slice(0, 1500)}\n` : ""}` +
        `Escreva ${n} slides. O primeiro é a capa (modelo "capa": título grande com o gancho, até 10 palavras, e um texto curto de apoio). ` +
        'Os do meio usam modelo "texto" (título curto + até 35 palavras) ou "lista" (título + 3 a 5 itens curtos). ' +
        "O último fecha com uma chamada pra ação (salvar, comentar ou seguir). Em slide que não é lista, itens vem vazio.",
      schema: {
        type: "object", additionalProperties: false, required: ["slides"],
        properties: { slides: { type: "array", items: { type: "object", additionalProperties: false, required: ["modelo", "titulo", "texto", "itens"],
          properties: { modelo: { type: "string", enum: ["capa", "texto", "lista"] }, titulo: { type: "string" }, texto: { type: "string" },
            itens: { type: "array", items: { type: "string" } } } } } },
      },
      max: 6000, esforco: "medium",
    });
    return json({ ok: true, slides: semTravessao(r.slides) });
  }

  throw new HttpError(400, "Modo desconhecido.");
});
