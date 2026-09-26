// ig-media (JWT admin): lista meus posts pro seletor, e dados da conta conectada.
// Body: { acao?: 'posts' | 'conta', after?: string }
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";
import { graph } from "../_shared/instagram.ts";

servir(async (req) => {
  const { db } = await exigirAdmin(req);
  const body = await req.json().catch(() => ({}));

  if (body.acao === "conta") {
    const r = await graph(db, "/me?fields=id,user_id,username,account_type,media_count,followers_count,profile_picture_url");
    if (!r.ok) throw new HttpError(400, "Instagram: " + (r.json?.error?.message ?? "não respondeu"));
    await db.from("ig_token_status").upsert({ id: 1, username: r.json.username, account_id: r.json.user_id ?? r.json.id,
      updated_at: new Date().toISOString() });
    return json({ ok: true, conta: r.json });
  }

  const campos = "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,comments_count,like_count";
  const after = body.after ? `&after=${encodeURIComponent(body.after)}` : "";
  const r = await graph(db, `/me/media?fields=${campos}&limit=50${after}`);
  if (!r.ok) throw new HttpError(400, "Instagram: " + (r.json?.error?.message ?? "não respondeu"));
  return json({ ok: true, posts: r.json.data ?? [], after: r.json.paging?.cursors?.after ?? null, temMais: !!r.json.paging?.next });
});
