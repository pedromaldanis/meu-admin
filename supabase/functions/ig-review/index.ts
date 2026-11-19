// ig-review (--no-verify-jwt: cron das 11h com x-sched-key, ou botão do painel com JWT de admin)
// Os números são contados aqui em código; a IA só interpreta e devolve 5 blocos curtos.
// Guarda em ig_review_cache (dia, review, facts).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { exigirAdminOuSched, json, servir } from "../_shared/auth.ts";
import { blocoVoz, carregarMarca, carregarVoz, iaJSON, semTravessao, temIA } from "../_shared/ia.ts";

const FUSO = "America/Sao_Paulo";
const DIA = 86_400_000;
const diaSP = (d: number | Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));

type Linha = { id: string; caption: string; formato: string; timestamp: string; views: number | null; reach: number | null;
  likes: number | null; comments: number | null; shares: number | null; saved: number | null; interacoes: number; retencao_s: number | null; engajamento: number | null };

async function cacheFresco(db: SupabaseClient, days: number) {
  const { data } = await db.from("ig_insights_cache").select("payload, generated_at").eq("days", days).maybeSingle();
  if (data && Date.now() - new Date(data.generated_at).getTime() < 6 * 3600e3) return data.payload;
  // Recalcula chamando a ig-insights com a chave do robô
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ig-insights`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-sched-key": Deno.env.get("SCHED_SECRET") ?? "" },
    body: JSON.stringify({ days }),
  }).then((x) => x.json()).catch(() => null);
  return r?.payload ?? data?.payload ?? null;
}

const gancho = (c: string) => String(c || "").split(/\n|(?<=[.!?])\s/)[0].slice(0, 160);
const resumoPost = (l: Linha) => ({
  data: diaSP(new Date(l.timestamp)), formato: l.formato, gancho: gancho(l.caption), views: l.views, alcance: l.reach,
  curtidas: l.likes, comentarios: l.comments, compartilhamentos: l.shares, salvamentos: l.saved,
  engajamento_pct: l.engajamento, retencao_media_s: l.retencao_s,
});

function montarFatos(p7: Record<string, any>, p30: Record<string, any> | null, pTudo: Record<string, any> | null) {
  const hoje = Date.now();
  const ontem = diaSP(hoje - DIA);
  const posts7: Linha[] = p7?.posts ?? [];
  const deOntem = posts7.filter((l) => diaSP(new Date(l.timestamp)) === ontem);
  const ord = [...posts7].sort((a, b) => (Number(b.reach) || 0) - (Number(a.reach) || 0));
  const serie30: { dia: string; v: number }[] = p30?.serie?.alcance ?? [];
  const soma = (de: number, ate: number) => serie30.filter((p) => p.dia >= diaSP(hoje - de * DIA) && p.dia < diaSP(hoje - ate * DIA)).reduce((s, p) => s + p.v, 0);
  const semana = soma(7, 0), anterior = soma(14, 7);
  return {
    dia: diaSP(hoje), ontem,
    alcance_ontem: (p7?.serie?.alcance ?? []).find((x: { dia: string }) => x.dia === ontem)?.v ?? null,
    posts_ontem: deOntem.map(resumoPost),
    semana: {
      cards: p7?.cards ?? {},
      alcance_somado_dia_a_dia: semana || null,
      alcance_semana_anterior: anterior || null,
      variacao_pct: anterior ? Math.round(((semana - anterior) / anterior) * 1000) / 10 : null,
      posts: posts7.length,
    },
    melhores_da_semana: ord.slice(0, 3).map(resumoPost),
    piores_da_semana: ord.length > 3 ? ord.slice(-2).map(resumoPost) : [],
    melhores_horarios: ((p30?.posts?.length ?? 0) >= 6 ? p30?.horarios : pTudo?.horarios ?? [])
      .filter((h: { posts: number }) => h.posts >= 2).slice(0, 4),
    // Sem post na semana, a IA ainda compara com os últimos posts publicados
    ultimos_posts: posts7.length ? [] : ((p30?.posts?.length ? p30.posts : pTudo?.posts) ?? []).slice(0, 6).map(resumoPost),
    dias_sem_postar: (() => {
      const ult = (pTudo?.posts ?? p30?.posts ?? [])[0]?.timestamp;
      return ult ? Math.floor((hoje - new Date(ult).getTime()) / DIA) : null;
    })(),
  };
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["funcionou", "nao_funcionou", "ganchos", "horarios", "acoes"],
  properties: {
    funcionou: { type: "array", items: { type: "string" } },
    nao_funcionou: { type: "array", items: { type: "string" } },
    ganchos: { type: "array", items: { type: "string" } },
    horarios: { type: "string" },
    acoes: { type: "array", items: { type: "string" } },
  },
};

servir(async (req) => {
  const { db } = await exigirAdminOuSched(req);
  const [p7, p30] = await Promise.all([cacheFresco(db, 7), cacheFresco(db, 30)]);
  const dia = diaSP(Date.now());
  if (!p7) {
    const erro = "Ainda não consegui ler os números do Instagram. Clique em Atualizar na Visão geral.";
    await db.from("ig_review_cache").upsert({ dia, review: null, facts: {}, erro }, { onConflict: "dia" });
    return json({ ok: false, erro });
  }
  const { data: tudo } = await db.from("ig_insights_cache").select("payload").eq("days", 0).maybeSingle();
  const facts = montarFatos(p7, p30, tudo?.payload ?? null);

  if (!temIA()) {
    const erro = "Sem chave de IA (ANTHROPIC_API_KEY). Os números do dia estão abaixo; a interpretação aparece quando a chave for configurada.";
    await db.from("ig_review_cache").upsert({ dia, review: null, facts, erro }, { onConflict: "dia" });
    return json({ ok: false, erro, facts });
  }

  const marca = await carregarMarca(db);
  const voz = await carregarVoz(db);
  try {
    const review = semTravessao(await iaJSON<Record<string, unknown>>({
      sistema: blocoVoz(marca, voz) +
        "\nVocê faz a revisão diária do Instagram. Use SÓ os números recebidos; não invente dado. " +
        "Fale direto com a pessoa (você), sem enrolação, como um sócio que olhou os números de manhã.",
      prompt: `Números (JSON, já contados):\n${JSON.stringify(facts)}\n\n` +
        "Devolva 5 blocos curtos:\n" +
        "- funcionou: até 3 itens, cada um citando o número que prova.\n" +
        "- nao_funcionou: até 3 itens, com número.\n" +
        "- ganchos: até 3 ganchos (primeira frase) que seguraram, entre aspas, e o porquê em poucas palavras.\n" +
        "- horarios: 1 ou 2 frases sobre os melhores horários (se tiver pouco dado, diga).\n" +
        "- acoes: exatamente 3 ações pra hoje, começando por verbo, específicas.",
      schema: SCHEMA,
      max: 4000,
      esforco: "low",
    }));
    await db.from("ig_review_cache").upsert({ dia, review, facts, erro: null }, { onConflict: "dia" });
    return json({ ok: true, review, facts });
  } catch (e) {
    const erro = e instanceof Error ? e.message : "Erro na IA.";
    await db.from("ig_review_cache").upsert({ dia, review: null, facts, erro }, { onConflict: "dia" });
    return json({ ok: false, erro, facts });
  }
});
