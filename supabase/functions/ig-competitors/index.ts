// ig-competitors (--no-verify-jwt: cron das 4h com x-sched-key, ou painel com JWT de admin)
// Lê até 10 perfis públicos (contas profissionais) pelo business_discovery e guarda 1 foto por dia.
//  {acao:"atualizar"}              -> todos os cadastrados
//  {acao:"atualizar", username:"x"} -> só esse (usado ao cadastrar)
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { exigirAdminOuSched, HttpError, json, servir } from "../_shared/auth.ts";
import { graph } from "../_shared/instagram.ts";

const FUSO = "America/Sao_Paulo";
const diaSP = (d: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
const LIMITE = 10;

async function foto(db: SupabaseClient, username: string) {
  const campos = "username,name,profile_picture_url,followers_count,follows_count,media_count," +
    "media.limit(12){id,caption,like_count,comments_count,media_type,media_product_type,timestamp,permalink,media_url,thumbnail_url}";
  const r = await graph(db, `/me?fields=business_discovery.username(${encodeURIComponent(username)}){${campos}}`);
  const dia = diaSP(Date.now());
  if (!r.ok || !r.json.business_discovery) {
    const msg = r.json?.error?.message ?? "Perfil não encontrado.";
    const erro = /business_discovery|nonexisting field|Unsupported/i.test(msg)
      ? "Esse tipo de conexão do Instagram não libera ver outros perfis (a Meta só permite pelo login do Facebook)."
      : /Invalid user id|cannot be found|not exist/i.test(msg)
        ? "Não achei esse @, ou ele não é conta profissional (pessoal não aparece)."
        : msg.slice(0, 300);
    await db.from("ig_competitor_snapshots").upsert({ username, dia, payload: {}, erro }, { onConflict: "username,dia" });
    return { username, ok: false, erro };
  }
  const b = r.json.business_discovery;
  const media = (b.media?.data ?? []).map((m: Record<string, unknown>) => ({
    id: m.id, caption: String(m.caption ?? "").slice(0, 300), likes: m.like_count ?? null, comments: m.comments_count ?? null,
    formato: m.media_product_type === "REELS" ? "REELS" : m.media_type, timestamp: m.timestamp, permalink: m.permalink,
    capa: m.thumbnail_url ?? (m.media_type !== "VIDEO" ? m.media_url : null),
  }));
  const payload = {
    username: b.username, nome: b.name ?? null, foto: b.profile_picture_url ?? null,
    followers: b.followers_count ?? null, follows: b.follows_count ?? null, media_count: b.media_count ?? null, media,
  };
  await db.from("ig_competitor_snapshots").upsert({ username, dia, payload, erro: null }, { onConflict: "username,dia" });
  return { username, ok: true };
}

servir(async (req) => {
  const { db } = await exigirAdminOuSched(req);
  const body = await req.json().catch(() => ({}));
  let nomes: string[];
  if (body.username) {
    const u = String(body.username).replace(/^@/, "").trim().toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u)) throw new HttpError(400, "@ inválido.");
    nomes = [u];
  } else {
    const { data } = await db.from("ig_competitors").select("username").order("created_at").limit(LIMITE);
    nomes = (data ?? []).map((x: { username: string }) => x.username);
  }
  const res = [];
  for (const u of nomes) res.push(await foto(db, u));
  return json({ ok: true, resultados: res });
});
