// ig-broadcast (JWT admin): recado novo pra quem está com a janela de 24h aberta.
// Body: { mensagem, botao_titulo?, botao_url?, tag?, automation_id?, dry_run = true }
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";
import { enviar, janelaAberta, type Lead, registrarEntrega } from "../_shared/instagram.ts";
import { espera } from "../_shared/email.ts";

servir(async (req) => {
  const { db } = await exigirAdmin(req);
  const b = await req.json().catch(() => ({}));
  const dryRun = b.dry_run !== false;

  const desde = new Date(Date.now() - 24 * 3600e3).toISOString();
  let q = db.from("ig_leads").select("*").gte("last_inbound_at", desde);
  if (b.tag) q = q.contains("tags", [b.tag]);
  if (b.automation_id) q = q.eq("automation_id", b.automation_id);
  const { data, error } = await q.limit(1000);
  if (error) throw error;
  const alvo = (data ?? []).filter((l) => janelaAberta(l as Lead));

  if (dryRun) return json({ ok: true, dry_run: true, total: alvo.length, amostra: alvo.slice(0, 10).map((l) => l.username) });

  const texto = String(b.mensagem ?? "").trim();
  if (!texto) throw new HttpError(400, "Escreva o recado.");
  const temBotao = b.botao_titulo && /^https:\/\//i.test(b.botao_url ?? "");
  const message = temBotao
    ? { attachment: { type: "template", payload: { template_type: "button", text: texto.slice(0, 640),
        buttons: [{ type: "web_url", url: b.botao_url, title: String(b.botao_titulo).slice(0, 20) }] } } }
    : { text: texto.slice(0, 1000) };

  let enviados = 0, falhas = 0, parouNoFreio = null as string | null;
  for (const l of alvo) {
    const res = await enviar(db, { id: l.ig_user_id }, message, l.ig_user_id);
    await registrarEntrega(db, { ig_user_id: l.ig_user_id, canal: "dm", tipo: "recado", res });
    if (res.ok) enviados++;
    else if (res.freio || res.rateLimit) { parouNoFreio = res.erro ?? "freio"; break; }
    else falhas++;
    await espera(1000);
  }
  return json({ ok: true, total: alvo.length, enviados, falhas, naoTentados: alvo.length - enviados - falhas, parouNoFreio });
});
