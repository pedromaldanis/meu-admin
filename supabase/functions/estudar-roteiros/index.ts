// estudar-roteiros (JWT admin). Roda EM SEGUNDO PLANO e grava em ia_resultados (chave "estudo_roteiros").
// 1) extrai a estrutura de cada roteiro da biblioteca (gancho literal, tipo de gancho, desenvolvimento, CTA, expressões)
// 2) cruza tudo: assuntos em alta, linguagem que prende, padrões de gancho e 5 roteiros novos no MEU assunto
//    reaproveitando a estrutura, não o conteúdo.
//  {ids?: [...]} -> estuda só esses (senão, os 15 mais recentes prontos)
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";
import { blocoVoz, carregarMarca, carregarVoz, iaJSON, semTravessao, temIA } from "../_shared/ia.ts";

const CHAVE = "estudo_roteiros";
const MAX_ROTEIROS = 15;
const MAX_CHARS = 6000; // por transcrição (vídeos muito longos entram só com o começo)
const CENAS = ["gancho", "contexto", "virada", "prova", "cta"];

const SCHEMA_ANALISE = {
  type: "object", additionalProperties: false, required: ["analises"],
  properties: {
    analises: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "gancho", "tipo_gancho", "desenvolvimento", "cta", "expressoes", "assunto"],
      properties: {
        id: { type: "string" }, gancho: { type: "string" }, tipo_gancho: { type: "string" },
        desenvolvimento: { type: "string" }, cta: { type: "string" },
        expressoes: { type: "array", items: { type: "string" } }, assunto: { type: "string" },
      } } },
  },
};
const SCHEMA_SINTESE = {
  type: "object", additionalProperties: false,
  required: ["assuntos_em_alta", "linguagem_que_prende", "padroes_de_gancho", "roteiros_novos"],
  properties: {
    assuntos_em_alta: { type: "array", items: { type: "string" } },
    linguagem_que_prende: { type: "array", items: { type: "string" } },
    padroes_de_gancho: { type: "array", items: { type: "object", additionalProperties: false, required: ["padrao", "exemplo"],
      properties: { padrao: { type: "string" }, exemplo: { type: "string" } } } },
    roteiros_novos: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["titulo", "estrutura_base", "roteiro"],
      properties: {
        titulo: { type: "string" }, estrutura_base: { type: "string" },
        roteiro: { type: "object", additionalProperties: false, required: CENAS,
          properties: Object.fromEntries(CENAS.map((c) => [c, { type: "string" }])) },
      } } },
  },
};

async function estudar(db: SupabaseClient, ids: string[] | null) {
  const marcar = (campos: Record<string, unknown>) =>
    db.from("ia_resultados").upsert({ chave: CHAVE, ...campos, updated_at: new Date().toISOString() });
  try {
    let q = db.from("roteiros").select("id, titulo, perfil, de_quem, transcricao, analise").eq("status", "pronto");
    if (ids?.length) q = q.in("id", ids);
    const { data } = await q.order("created_at", { ascending: false }).limit(MAX_ROTEIROS);
    const lista = (data ?? []).filter((r: { transcricao: string }) => r.transcricao?.trim());
    if (!lista.length) throw new Error("Nenhum roteiro transcrito ainda. Transcreva pelo menos 1 vídeo.");

    const marca = await carregarMarca(db);
    const voz = await carregarVoz(db);
    const sistema = blocoVoz(marca, voz) + "\nVocê estuda roteiros de vídeos curtos e responde só com o JSON pedido.";

    // 1) Estrutura de cada um (só os que ainda não têm análise)
    const faltam = lista.filter((r: { analise: unknown }) => !r.analise);
    if (faltam.length) {
      const texto = faltam.map((r: { id: string; titulo: string; perfil: string; transcricao: string }) =>
        `### id=${r.id}${r.perfil ? ` (@${r.perfil})` : ""}${r.titulo ? ` ${r.titulo}` : ""}\n${r.transcricao.slice(0, MAX_CHARS)}`).join("\n\n");
      const a = await iaJSON<{ analises: { id: string }[] }>({
        sistema,
        prompt: `Transcrições:\n\n${texto}\n\nPra cada uma (use o id exatamente como veio): gancho literal (a primeira frase), ` +
          "tipo de gancho (ex.: pergunta, promessa, polêmica, erro comum, número, história), desenvolvimento (1 ou 2 frases sobre como o vídeo avança), " +
          "CTA (literal, ou \"sem CTA\"), até 5 expressões que prendem, e o assunto em poucas palavras.",
        schema: SCHEMA_ANALISE, esforco: "low",
      });
      for (const an of semTravessao(a.analises)) {
        if (faltam.some((r: { id: string }) => r.id === an.id)) await db.from("roteiros").update({ analise: an }).eq("id", an.id);
      }
    }

    // 2) Cruzamento
    const { data: atual } = await db.from("roteiros").select("id, perfil, de_quem, analise").in("id", lista.map((r: { id: string }) => r.id));
    const analises = (atual ?? []).filter((r: { analise: unknown }) => r.analise);
    const s = await iaJSON<Record<string, unknown>>({
      sistema,
      prompt: `Estruturas dos roteiros estudados:\n${JSON.stringify(analises)}\n\n` +
        "Cruze tudo e devolva: assuntos em alta (até 6), linguagem que prende (até 8 itens, com exemplos literais), " +
        "padrões de gancho (até 6, cada um com 1 exemplo literal) e 5 roteiros novos NO MEU ASSUNTO (pilares da minha voz), " +
        "reaproveitando a ESTRUTURA dos que funcionaram, nunca o conteúdo. Em cada roteiro novo diga qual estrutura usou. " +
        "Roteiro em 5 cenas curtas (gancho, contexto, virada, prova, cta), de 25 a 45 segundos (2,5 palavras por segundo).",
      schema: SCHEMA_SINTESE, esforco: "medium",
    });
    await marcar({ status: "pronto", payload: { ...semTravessao(s), estudados: analises.length, gerado_em: new Date().toISOString() }, erro: null });
  } catch (e) {
    console.error(e);
    await marcar({ status: "erro", erro: e instanceof Error ? e.message.slice(0, 400) : "erro" });
  }
}

servir(async (req) => {
  const { db } = await exigirAdmin(req);
  if (!temIA()) throw new HttpError(400, "Falta a chave de IA. Configure o secret ANTHROPIC_API_KEY no Supabase (veja ⚙️ Configurações).");
  const b = await req.json().catch(() => ({}));
  const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, MAX_ROTEIROS) : null;
  await db.from("ia_resultados").upsert({ chave: CHAVE, status: "processando", erro: null, updated_at: new Date().toISOString() });
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(estudar(db, ids));
  return json({ ok: true, status: "processando" });
});
