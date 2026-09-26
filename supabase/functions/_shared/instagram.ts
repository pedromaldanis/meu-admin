// Tudo que fala com a API do Instagram (graph.instagram.com) + o freio + o envio de passos.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const IG_API = "https://graph.instagram.com/v21.0";
export const ROTULO_AUTOMATICO = "(mensagem automática 🤖)";
const JANELA_MS = 24 * 3600 * 1000;

export type Botao = { title: string; next?: string; url?: string };
export type Passo = {
  id: string;
  message?: string;
  buttons?: Botao[];
  assets?: string[];
  delay?: { value: number; unit: "s" | "min" | "h"; next: string } | null;
  collect?: { field: "email" | "telefone"; next?: string } | null;
};
export type Automacao = {
  id: string; nome: string; active: boolean; trigger_type: string; keyword: string | null; match_any: boolean;
  media_ids: string[]; public_reply: string | null; public_reply_variants: string[];
  ask_message: string | null; ask_button: string | null; flow: { steps: Passo[] };
};
export type Lead = {
  id: string; ig_user_id: string; username: string | null; interactions: number; last_inbound_at: string | null;
  expecting: { field: string; next?: string; automation_id: string; ate: string } | null; [k: string]: unknown;
};
export type Destino = { id: string } | { comment_id: string };
export type EnvioResultado = { ok: boolean; mid?: string; erro?: string; rateLimit?: boolean; janela?: boolean; freio?: boolean };

// ---------------------------------------------------------------------
// Token: o renovado (Vault) tem prioridade sobre o secret original
// ---------------------------------------------------------------------
let tokenCache: string | null = null;
export async function token(db: SupabaseClient): Promise<string> {
  if (tokenCache) return tokenCache;
  const { data } = await db.rpc("ig_token_ler");
  tokenCache = (data as string | null)?.trim() || Deno.env.get("IG_ACCESS_TOKEN")?.trim() || "";
  if (!tokenCache) throw new Error("IG_ACCESS_TOKEN não configurado.");
  return tokenCache;
}

export async function graph(db: SupabaseClient, caminho: string, init: RequestInit = {}) {
  const t = await token(db);
  const url = caminho.startsWith("http") ? caminho : IG_API + caminho;
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !j?.error, status: r.status, json: j };
}

function classificarErro(j: Record<string, any>): EnvioResultado {
  const e = j?.error ?? {};
  const msg = `${e.code ?? ""}${e.error_subcode ? "/" + e.error_subcode : ""} ${e.message ?? "erro desconhecido"}`.trim();
  const rateLimit = [4, 17, 32, 613].includes(Number(e.code)) || /rate limit|too many|limit.*reached/i.test(e.message ?? "");
  const janela = Number(e.error_subcode) === 2018278 || /outside of allowed window|24 ?hour/i.test(e.message ?? "");
  return { ok: false, erro: msg.slice(0, 400), rateLimit, janela };
}

// ---------------------------------------------------------------------
// Texto: normaliza pra comparar palavra-chave (minúsculo, sem acento, sem pontuação)
// ---------------------------------------------------------------------
export function normalizar(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9@#\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function palavras(a: Automacao): string[] {
  return String(a.keyword ?? "").split(",").map(normalizar).filter(Boolean);
}

export function bate(a: Automacao, texto: string): string | null {
  const t = ` ${normalizar(texto)} `;
  for (const p of palavras(a)) if (t.includes(` ${p} `)) return p;
  return a.match_any ? "*" : null;
}

export function janelaAberta(lead: Pick<Lead, "last_inbound_at"> | null, margemMs = 5 * 60 * 1000): boolean {
  if (!lead?.last_inbound_at) return false;
  return Date.now() - new Date(lead.last_inbound_at).getTime() < JANELA_MS - margemMs;
}

// ---------------------------------------------------------------------
// Freio
// ---------------------------------------------------------------------
export async function pedirVaga(db: SupabaseClient, chave: string, user: string): Promise<{ ok: boolean; motivo?: string }> {
  const { data, error } = await db.rpc("take_send_slot", { p_key: chave, p_user: user });
  if (error) return { ok: false, motivo: "Freio indisponível: " + error.message };
  return data as { ok: boolean; motivo?: string };
}

async function registrarResultado(db: SupabaseClient, r: EnvioResultado) {
  await db.rpc("record_send_result", { p_ok: r.ok, p_rate_limit: !!r.rateLimit, p_erro: r.erro ?? null });
}

// ---------------------------------------------------------------------
// Envio cru de 1 mensagem (já passando pelo freio)
// ---------------------------------------------------------------------
export async function enviar(db: SupabaseClient, destino: Destino, message: Record<string, unknown>, user: string): Promise<EnvioResultado> {
  const vaga = await pedirVaga(db, "comment_id" in destino ? "private_reply" : "dm", user);
  if (!vaga.ok) return { ok: false, erro: vaga.motivo, freio: true };

  const r = await graph(db, "/me/messages", { method: "POST", body: JSON.stringify({ recipient: destino, message }) });
  const res: EnvioResultado = r.ok ? { ok: true, mid: r.json.message_id } : classificarErro(r.json);
  await registrarResultado(db, res);
  if (res.ok && res.mid) await db.from("ig_bot_sends").upsert({ mid: res.mid }, { onConflict: "mid", ignoreDuplicates: true });
  return res;
}

export async function responderComentario(db: SupabaseClient, commentId: string, texto: string, user: string): Promise<EnvioResultado> {
  const vaga = await pedirVaga(db, "comment_reply", user);
  if (!vaga.ok) return { ok: false, erro: vaga.motivo, freio: true };
  const r = await graph(db, `/${commentId}/replies`, { method: "POST", body: JSON.stringify({ message: texto }) });
  const res: EnvioResultado = r.ok ? { ok: true, mid: r.json.id } : classificarErro(r.json);
  await registrarResultado(db, res);
  return res;
}

export async function registrarEntrega(db: SupabaseClient, d: {
  ig_user_id: string; automation_id?: string | null; canal: string; tipo: string; res?: EnvioResultado; status?: string; motivo?: string;
}) {
  await db.from("ig_deliveries").insert({
    ig_user_id: d.ig_user_id, automation_id: d.automation_id ?? null, canal: d.canal, tipo: d.tipo,
    status: d.status ?? (d.res?.ok ? "ok" : "erro"),
    motivo: d.motivo ?? (d.res?.ok ? null : d.res?.erro ?? null), mid: d.res?.mid ?? null,
  });
}

// ---------------------------------------------------------------------
// Monta e envia 1 passo do fluxo
// ---------------------------------------------------------------------
const tipoPorUrl = (u: string) =>
  /\.(jpe?g|png|gif|webp)(\?|$)/i.test(u) ? "image" : /\.(m4a|mp4a|aac)(\?|$)/i.test(u) ? "audio"
    : /\.(mp4|mov)(\?|$)/i.test(u) ? "video" : "file";

export function montarMensagemPasso(a: Automacao, passo: Passo, primeiraVez: boolean) {
  const botoes = (passo.buttons ?? []).filter((b) => b.title?.trim()).slice(0, 3);
  let texto = String(passo.message ?? "").trim();
  if (primeiraVez) texto = (texto ? texto + "\n\n" : "") + ROTULO_AUTOMATICO;
  const limite = botoes.length ? 640 : 1000;
  if (texto.length > limite) texto = texto.slice(0, limite - 1) + "…";

  const botoesApi = botoes.map((b) => b.url && /^https:\/\//i.test(b.url)
    ? { type: "web_url", url: b.url, title: b.title.slice(0, 20) }
    : { type: "postback", title: b.title.slice(0, 20), payload: `STEP:${a.id}:${b.next ?? ""}` });

  const template = botoesApi.length
    ? { attachment: { type: "template", payload: { template_type: "button", text: texto || "👇", buttons: botoesApi } } }
    : null;

  // Plano B se o template falhar: texto com os links escritos
  const links = botoes.filter((b) => b.url).map((b) => `👉 ${b.title}: ${b.url}`).join("\n");
  const textoPlano = [texto, links].filter(Boolean).join("\n\n").slice(0, 1000);

  return { template, texto: texto || null, textoPlano, temLink: botoes.some((b) => b.url) };
}

export async function enviarPasso(db: SupabaseClient, opts: {
  a: Automacao; passoId?: string; lead: Lead; destino: Destino; canal: "private_reply" | "dm"; tipo?: string;
}): Promise<EnvioResultado> {
  const { a, lead, destino, canal } = opts;
  const passos = a.flow?.steps ?? [];
  const passo = opts.passoId ? passos.find((p) => p.id === opts.passoId) : passos[0];
  if (!passo) {
    const res = { ok: false, erro: `Passo ${opts.passoId ?? "1"} não existe no fluxo` };
    await registrarEntrega(db, { ig_user_id: lead.ig_user_id, automation_id: a.id, canal, tipo: opts.tipo ?? "passo", res });
    return res;
  }

  const primeiraVez = (lead.interactions ?? 0) === 0;
  const m = montarMensagemPasso(a, passo, primeiraVez);
  let res: EnvioResultado;

  if (m.template) {
    res = await enviar(db, destino, m.template, lead.ig_user_id);
    if (!res.ok && !res.freio && !res.rateLimit && !res.janela) {
      // Template recusado: manda texto com o link
      res = await enviar(db, destino, { text: m.textoPlano }, lead.ig_user_id);
    }
  } else {
    res = await enviar(db, destino, { text: m.texto ?? "🙂" }, lead.ig_user_id);
  }
  await registrarEntrega(db, { ig_user_id: lead.ig_user_id, automation_id: a.id, canal, tipo: `${opts.tipo ?? "passo"} ${passo.id}`, res });
  if (!res.ok) return res;

  // Arquivos vão depois do texto (só em DM: resposta privada é 1 mensagem só)
  if ("id" in destino) {
    for (const url of passo.assets ?? []) {
      const r = await enviar(db, destino, { attachment: { type: tipoPorUrl(url), payload: { url } } }, lead.ig_user_id);
      await registrarEntrega(db, { ig_user_id: lead.ig_user_id, automation_id: a.id, canal, tipo: "arquivo", res: r });
      if (!r.ok) break;
    }
  }

  const upd: Record<string, unknown> = {
    automation_id: a.id, flow_step: passo.id, interactions: (lead.interactions ?? 0) + 1,
  };
  if (m.temLink) upd.link_sent = true;
  if (passo.collect?.field) {
    upd.expecting = { field: passo.collect.field, next: passo.collect.next ?? null, automation_id: a.id,
      ate: new Date(Date.now() + JANELA_MS).toISOString() };
  }
  await db.from("ig_leads").update(upd).eq("ig_user_id", lead.ig_user_id);
  lead.interactions = (lead.interactions ?? 0) + 1;

  if (passo.delay?.next && passo.delay.value > 0) {
    const mult = passo.delay.unit === "h" ? 3600e3 : passo.delay.unit === "s" ? 1e3 : 60e3;
    await db.from("ig_scheduled").insert({
      ig_user_id: lead.ig_user_id, automation_id: a.id, step_id: passo.delay.next,
      send_at: new Date(Date.now() + passo.delay.value * mult).toISOString(),
    });
  }
  return res;
}

/** Busca o lead ou cria (com o @ quando a API deixar). */
export async function garantirLead(db: SupabaseClient, igUserId: string, username?: string | null): Promise<Lead> {
  const { data } = await db.from("ig_leads").select("*").eq("ig_user_id", igUserId).maybeSingle();
  if (data) {
    if (username && data.username !== username) {
      await db.from("ig_leads").update({ username }).eq("ig_user_id", igUserId);
      data.username = username;
    }
    return data as Lead;
  }
  let nome = username ?? null;
  if (!nome) {
    const r = await graph(db, `/${igUserId}?fields=username`).catch(() => null);
    nome = r?.ok ? r.json.username ?? null : null;
  }
  const { data: novo } = await db.from("ig_leads")
    .upsert({ ig_user_id: igUserId, username: nome }, { onConflict: "ig_user_id" }).select("*").single();
  return novo as Lead;
}

/** A mesma pessoa, na mesma automação, só recebe 1 vez a cada 24h. */
export async function recebeuNas24h(db: SupabaseClient, igUserId: string, automationId: string): Promise<boolean> {
  const desde = new Date(Date.now() - JANELA_MS).toISOString();
  const { count } = await db.from("ig_deliveries").select("id", { count: "exact", head: true })
    .eq("ig_user_id", igUserId).eq("automation_id", automationId).eq("status", "ok")
    .in("canal", ["private_reply", "dm"]).gte("ts", desde);
  return (count ?? 0) > 0;
}

export function sortear<T>(lista: T[]): T | undefined {
  return lista.length ? lista[Math.floor(Math.random() * lista.length)] : undefined;
}
