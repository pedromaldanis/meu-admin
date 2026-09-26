// Envio pela Resend + placeholders + remetente. Usado por send-bulk-email e pelo robô.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const RE_EMAIL = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
export const emailValido = (e: string) => RE_EMAIL.test(e) && !e.includes("..");

export type Destinatario = { email: string; nome?: string | null; [campo: string]: unknown };
export type Remetente = { from: string; replyTo: string };
export type Resultado = { ok: boolean; id?: string; erro?: string; cota?: boolean };

export const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Remetente vem da tabela configuracoes (editável no painel). */
export async function carregarRemetente(db: SupabaseClient): Promise<Remetente> {
  const { data } = await db.from("configuracoes").select("chave, valor")
    .in("chave", ["remetente_nome", "remetente_email", "reply_to"]);
  const c = Object.fromEntries((data ?? []).map((l) => [l.chave, l.valor]));
  const nome = (c.remetente_nome || "Pedro Maldanis").replace(/[<>"]/g, "");
  const email = c.remetente_email || "pedro@pedromaldanis.com.br";
  return { from: `${nome} <${email}>`, replyTo: c.reply_to || email };
}

/**
 * Troca {{nome}} pelo PRIMEIRO nome, {{nome_completo}}, {{email}} e qualquer
 * {{campo}} extra que vier no destinatário. Placeholder sem valor vira vazio.
 */
export function aplicar(texto: string, d: Destinatario): string {
  const completo = String(d.nome ?? "").trim();
  const primeiro = completo.split(/\s+/)[0] ?? "";
  const valores: Record<string, string> = {
    nome: primeiro ? primeiro[0].toUpperCase() + primeiro.slice(1).toLowerCase() : "",
    nome_completo: completo,
    email: d.email,
  };
  for (const [k, v] of Object.entries(d)) {
    if (!(k in valores) && v != null && typeof v !== "object") valores[k] = String(v);
  }
  return texto.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    const v = valores[k] ?? "";
    // No HTML, escapa o valor pra ninguém injetar tag pelo nome
    return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  });
}

export function montarPayload(rem: Remetente, d: Destinatario, assunto: string, html: string) {
  const assuntoFinal = aplicar(assunto, d).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return {
    from: rem.from,
    to: [d.email],
    reply_to: rem.replyTo,
    subject: assuntoFinal,
    html: aplicar(html, d),
    headers: {
      "List-Unsubscribe": `<mailto:${rem.replyTo}?subject=SAIR>`,
    },
  };
}

function lerErro(status: number, j: Record<string, unknown> | null): Resultado {
  const nome = String(j?.name ?? "");
  const msg = String(j?.message ?? `HTTP ${status}`);
  const cota = /quota/i.test(nome) || /quota/i.test(msg);
  return { ok: false, erro: `${nome ? nome + ": " : ""}${msg}`.slice(0, 500), cota };
}

/** Um e-mail (POST /emails). Tenta de novo se tomar rate limit. */
export async function enviarUm(apiKey: string, payload: unknown): Promise<Resultado> {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => null);
    if (r.ok) return { ok: true, id: j?.id };
    if (r.status === 429 && !/quota/i.test(JSON.stringify(j))) {
      await espera(1000 * (tentativa + 1));
      continue;
    }
    return lerErro(r.status, j);
  }
  return { ok: false, erro: "rate_limit_exceeded: muitas tentativas" };
}

/** Lote de até 100 (POST /emails/batch). Devolve um resultado por item, na mesma ordem. */
export async function enviarLote(apiKey: string, payloads: unknown[]): Promise<{ resultados: Resultado[] } | { falhouLote: Resultado }> {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payloads),
    });
    const j = await r.json().catch(() => null);
    if (r.ok) {
      const ids: { id: string }[] = j?.data ?? [];
      return { resultados: payloads.map((_, i) => ({ ok: true, id: ids[i]?.id })) };
    }
    if (r.status === 429 && !/quota/i.test(JSON.stringify(j))) {
      await espera(1000 * (tentativa + 1));
      continue;
    }
    return { falhouLote: lerErro(r.status, j) };
  }
  return { falhouLote: { ok: false, erro: "rate_limit_exceeded: muitas tentativas" } };
}
