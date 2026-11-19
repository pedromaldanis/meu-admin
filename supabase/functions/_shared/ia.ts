// IA do painel (Claude, da Anthropic). A chave fica SÓ no secret ANTHROPIC_API_KEY.
// Toda resposta vem em JSON validado por schema (structured outputs).
import Anthropic from "npm:@anthropic-ai/sdk@1.5.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HttpError } from "./auth.ts";

export const MODELO_IA = "claude-opus-5-5";

export function temIA(): boolean {
  return !!Deno.env.get("ANTHROPIC_API_KEY")?.trim();
}

let cliente: Anthropic | null = null;
function ia(): Anthropic {
  const chave = Deno.env.get("ANTHROPIC_API_KEY")?.trim();
  if (!chave) throw new HttpError(400, "Falta a chave de IA. Configure o secret ANTHROPIC_API_KEY no Supabase (veja ⚙️ Configurações).");
  if (!cliente) cliente = new Anthropic({ apiKey: chave });
  return cliente;
}

/**
 * Pede uma resposta em JSON que segue o schema.
 * O schema precisa ter additionalProperties:false e required em todo objeto.
 */
export async function iaJSON<T>(opts: {
  sistema: string;
  prompt: string;
  schema: Record<string, unknown>;
  max?: number;
  esforco?: "low" | "medium" | "high";
}): Promise<T> {
  let resp;
  try {
    // deno-lint-ignore no-explicit-any
    const params: any = {
      model: MODELO_IA,
      max_tokens: opts.max ?? 16000,
      system: opts.sistema,
      messages: [{ role: "user", content: opts.prompt }],
      output_config: { effort: opts.esforco ?? "medium", format: { type: "json_schema", schema: opts.schema } },
      // Se o modelo recusar por política, a própria API tenta de novo num modelo reserva
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    resp = await ia().beta.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(400, "A chave de IA (ANTHROPIC_API_KEY) foi recusada. Confira se copiou inteira.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new HttpError(400, "A chave de IA não tem permissão pra esse modelo.");
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "A IA está no limite de uso agora. Tente de novo em 1 minuto.");
    if (e instanceof Anthropic.BadRequestError) throw new HttpError(400, "A IA recusou o pedido: " + e.message.slice(0, 200));
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `A IA respondeu com erro ${e.status}. Tente de novo.`);
    throw e;
  }
  if (resp.stop_reason === "refusal") throw new HttpError(422, "A IA não quis responder esse pedido. Tente reformular.");
  if (resp.stop_reason === "max_tokens") throw new HttpError(502, "A resposta da IA ficou grande demais e cortou. Tente pedir menos itens.");
  const texto = resp.content.filter((b: { type: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("");
  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new HttpError(502, "A IA devolveu um formato inesperado. Tente de novo.");
  }
}

// ---------------------------------------------------------------------
// Voz e identidade da marca, pra todo prompt sair "na minha voz"
// ---------------------------------------------------------------------
export type Voz = {
  tom: string | null; expressoes: string[]; evitar: string[]; publico: string | null;
  pilares: string[]; exemplos: string[]; objetivos: string[];
};

export async function carregarMarca(db: SupabaseClient): Promise<{ nome: string; instagram: string }> {
  const { data } = await db.from("configuracoes").select("chave, valor").in("chave", ["nome_exibicao", "instagram_usuario"]);
  const m = new Map((data ?? []).map((r: { chave: string; valor: string }) => [r.chave, r.valor]));
  return { nome: m.get("nome_exibicao") || "o criador", instagram: String(m.get("instagram_usuario") || "").replace(/^@/, "") };
}

export async function carregarVoz(db: SupabaseClient): Promise<Voz | null> {
  const { data } = await db.from("perfil_voz").select("*").eq("id", 1).maybeSingle();
  return (data as Voz | null) ?? null;
}

export function blocoVoz(marca: { nome: string; instagram: string }, v: Voz | null): string {
  const l = (xs?: string[]) => (xs ?? []).filter(Boolean).join("; ") || "(não informado)";
  const ex = (v?.exemplos ?? []).filter(Boolean).slice(0, 6).map((t, i) => `Exemplo ${i + 1}:\n${t}`).join("\n\n");
  return [
    `Você escreve como ${marca.nome}${marca.instagram ? ` (@${marca.instagram} no Instagram)` : ""}, em português do Brasil.`,
    `Tom de voz: ${v?.tom || "(não informado: use um tom direto, próximo e sem enrolação)"}`,
    `Expressões que costuma usar: ${l(v?.expressoes)}`,
    `Evitar: ${l(v?.evitar)}`,
    `Público: ${v?.publico || "(não informado)"}`,
    `Pilares de conteúdo: ${l(v?.pilares)}`,
    `Objetivos, em ordem de prioridade: ${l(v?.objetivos)}`,
    ex ? `Textos reais pra copiar o jeito de escrever (o jeito, não o assunto):\n${ex}` : "",
    "Regras fixas: nunca use travessão (—) nem meia-risca; use vírgula, dois pontos ou ponto. Frases curtas. Nada de clichê de IA (\"no mundo de hoje\", \"descubra\", \"jornada\", \"desbloqueie\").",
  ].filter(Boolean).join("\n");
}

/** Remove travessões que escapem da IA, pra regra valer sempre. */
export function semTravessao<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\s*[—–]\s*/g, ", ") as unknown as T;
  if (Array.isArray(v)) return v.map(semTravessao) as unknown as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, semTravessao(x)])) as T;
  }
  return v;
}
