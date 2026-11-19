// transcrever (JWT admin). Chave da Supadata só no secret SUPADATA_API_KEY.
//  {url, de_quem?, titulo?, tags?} -> cria a linha em roteiros e transcreve EM SEGUNDO PLANO
//  {acao:"verificar", id}           -> continua um vídeo longo que ainda estava na fila da Supadata
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";

const API = "https://api.supadata.ai/v1/transcript";
const ESPERA_MS = 5000;
const LIMITE_MS = 130_000; // depois disso a tela pede pra continuar

function chave(): string {
  const k = Deno.env.get("SUPADATA_API_KEY")?.trim();
  if (!k) throw new HttpError(400, "Falta a chave da Supadata. Configure o secret SUPADATA_API_KEY no Supabase (veja ⚙️ Configurações).");
  return k;
}

function identificar(url: string) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (/instagram\.com$/.test(host)) {
    const id = u.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1];
    const capa = id
      ? `https://images.weserv.nl/?url=${encodeURIComponent(`instagram.com/p/${id}/media/?size=l`)}&w=480&h=600&fit=cover`
      : null;
    return { fonte: "instagram", capa, perfil: null as string | null };
  }
  if (/youtube\.com$|youtu\.be$/.test(host)) {
    const id = host === "youtu.be" ? u.pathname.slice(1) : u.searchParams.get("v") ?? u.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
    return { fonte: "youtube", capa: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null, perfil: null };
  }
  if (/tiktok\.com$/.test(host)) {
    return { fonte: "tiktok", capa: null, perfil: u.pathname.match(/\/@([^/]+)/)?.[1] ?? null };
  }
  return { fonte: "outro", capa: null, perfil: null };
}

async function salvar(db: SupabaseClient, id: string, campos: Record<string, unknown>) {
  await db.from("roteiros").update(campos).eq("id", id);
}

function resultado(j: Record<string, unknown>) {
  const c = j.content;
  const texto = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join(" ") : "";
  return texto.replace(/\s+/g, " ").trim();
}

/** Espera o job da Supadata (vídeo longo) até ficar pronto ou passar do limite. */
async function acompanhar(db: SupabaseClient, id: string, jobId: string, key: string) {
  const inicio = Date.now();
  while (Date.now() - inicio < LIMITE_MS) {
    await new Promise((r) => setTimeout(r, ESPERA_MS));
    const r = await fetch(`${API}/${encodeURIComponent(jobId)}`, { headers: { "x-api-key": key } });
    const j = await r.json().catch(() => ({}));
    if (j.status === "completed" || (r.ok && j.content != null && !j.status)) {
      const t = resultado(j);
      return salvar(db, id, t ? { transcricao: t, status: "pronto", erro: null, job_id: null }
        : { transcricao: "", status: "sem_fala", erro: "O vídeo não tem fala (só música).", job_id: null });
    }
    if (j.status === "failed" || (!r.ok && r.status !== 404)) {
      return salvar(db, id, { status: "erro", erro: String(j.error ?? j.message ?? `Supadata: HTTP ${r.status}`).slice(0, 300), job_id: null });
    }
  }
  // Ainda na fila: fica "transcrevendo" com o job_id; a tela oferece continuar
}

async function transcrever(db: SupabaseClient, id: string, url: string, key: string) {
  try {
    const q = new URLSearchParams({ url, mode: "auto", text: "true", lang: "pt" });
    const r = await fetch(`${API}?${q}`, { headers: { "x-api-key": key } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 202 && j.jobId) {
      await salvar(db, id, { job_id: j.jobId });
      return await acompanhar(db, id, j.jobId, key);
    }
    if (!r.ok) {
      const msg = r.status === 401 || r.status === 403 ? "A chave da Supadata foi recusada."
        : r.status === 402 ? "Os créditos da Supadata acabaram."
        : String(j.message ?? j.error ?? `Supadata: HTTP ${r.status}`);
      return await salvar(db, id, { status: "erro", erro: msg.slice(0, 300) });
    }
    const t = resultado(j);
    await salvar(db, id, t ? { transcricao: t, status: "pronto", erro: null }
      : { transcricao: "", status: "sem_fala", erro: "O vídeo não tem fala (só música)." });
  } catch (e) {
    await salvar(db, id, { status: "erro", erro: e instanceof Error ? e.message.slice(0, 300) : "erro" });
  }
}

servir(async (req) => {
  const { db } = await exigirAdmin(req);
  const b = await req.json().catch(() => ({}));
  const key = chave();

  if (b.acao === "verificar") {
    const { data: row } = await db.from("roteiros").select("id, job_id, url, status").eq("id", b.id).maybeSingle();
    if (!row) throw new HttpError(404, "Roteiro não encontrado.");
    if (row.status !== "transcrevendo") return json({ ok: true, status: row.status });
    // @ts-ignore EdgeRuntime existe no Supabase
    EdgeRuntime.waitUntil(row.job_id ? acompanhar(db, row.id, row.job_id, key) : transcrever(db, row.id, row.url, key));
    return json({ ok: true, status: "transcrevendo" });
  }

  const url = String(b.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Cole o link completo do vídeo (começando com https://).");
  let info;
  try { info = identificar(url); } catch { throw new HttpError(400, "Esse link não parece válido."); }

  let titulo = String(b.titulo ?? "").trim() || null;
  if (info.fonte === "tiktok") {
    const o = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`).then((x) => x.json()).catch(() => null);
    if (o) { info.capa = o.thumbnail_url ?? null; info.perfil = o.author_unique_id ?? o.author_name ?? info.perfil; titulo ??= o.title ?? null; }
  }

  const { data: row, error } = await db.from("roteiros").insert({
    url, fonte: info.fonte, capa_url: info.capa, perfil: b.perfil || info.perfil, titulo,
    de_quem: b.de_quem === "minha" ? "minha" : "outra",
    tags: Array.isArray(b.tags) ? b.tags.map(String).slice(0, 10) : [],
    status: "transcrevendo",
  }).select("*").single();
  if (error) throw error;

  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(transcrever(db, row.id, url, key));
  return json({ ok: true, roteiro: row });
});
