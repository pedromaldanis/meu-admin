// ig-token-refresh (cron semanal com x-sched-key, ou botão no painel com JWT admin; --no-verify-jwt)
// Renova o token de 60 dias, guarda no Vault e avisa por e-mail se falhar ou faltar menos de 10 dias.
import { exigirAdminOuSched, json, servir } from "../_shared/auth.ts";
import { carregarRemetente, enviarUm } from "../_shared/email.ts";
import { graph, token } from "../_shared/instagram.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

async function avisar(db: SupabaseClient, assunto: string, texto: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  if (!apiKey) return;
  const { data } = await db.from("configuracoes").select("valor").eq("chave", "email_teste").maybeSingle();
  const para = data?.valor;
  if (!para) return;
  const rem = await carregarRemetente(db);
  await enviarUm(apiKey, { from: rem.from, to: [para], subject: assunto,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${texto}</div>` });
}

servir(async (req) => {
  const { db } = await exigirAdminOuSched(req);
  const body = await req.json().catch(() => ({}));

  // Modo "só verificar": confere o token e a conta sem renovar
  // (a Meta só renova token com mais de 24h de vida)
  if (body.acao === "verificar") {
    const me = await graph(db, "/me?fields=id,user_id,username,account_type");
    if (!me.ok) {
      const erro = me.json?.error?.message ?? `HTTP ${me.status}`;
      await db.from("ig_token_status").upsert({ id: 1, ok: false, erro, updated_at: new Date().toISOString() });
      return json({ ok: false, erro });
    }
    const { data: st } = await db.from("ig_token_status").select("expires_at").eq("id", 1).maybeSingle();
    await db.from("ig_token_status").upsert({
      id: 1, ok: true, erro: null, username: me.json.username, account_id: me.json.user_id ?? me.json.id,
      // Token recém-gerado vale 60 dias; a primeira renovação corrige a data exata
      expires_at: st?.expires_at ?? new Date(Date.now() + 60 * 86_400_000).toISOString(),
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true, conta: me.json });
  }

  const atual = await token(db);

  const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(atual)}`);
  const j = await r.json().catch(() => ({}));

  if (!r.ok || !j.access_token) {
    const erro = j?.error?.message ?? `HTTP ${r.status}`;
    await db.from("ig_token_status").upsert({ id: 1, ok: false, erro, updated_at: new Date().toISOString() });
    await avisar(db, "⚠️ Token do Instagram: a renovação falhou",
      `A renovação automática do token do Instagram falhou.<br><br><b>Erro:</b> ${erro}<br><br>
       Gere um token novo na tela do produto Instagram (Meta for Developers) e atualize o secret IG_ACCESS_TOKEN no Supabase.
       Enquanto isso, as automações podem parar.`);
    return json({ ok: false, erro }, 200);
  }

  await db.rpc("ig_token_salvar", { p_token: j.access_token });
  const expira = new Date(Date.now() + Number(j.expires_in ?? 0) * 1000);
  const me = await graph(db, "/me?fields=user_id,username");
  await db.from("ig_token_status").upsert({
    id: 1, ok: true, erro: null, expires_at: expira.toISOString(), refreshed_at: new Date().toISOString(),
    username: me.json?.username ?? null, account_id: me.json?.user_id ?? null, updated_at: new Date().toISOString(),
  });

  const dias = Math.ceil((expira.getTime() - Date.now()) / 86_400_000);
  if (dias < 10) {
    await avisar(db, `⚠️ Token do Instagram vence em ${dias} dias`,
      `O token do Instagram vence em <b>${dias} dias</b> e a renovação automática não conseguiu estender. Gere um token novo e atualize o secret IG_ACCESS_TOKEN.`);
  }
  return json({ ok: true, dias, username: me.json?.username ?? null });
});
