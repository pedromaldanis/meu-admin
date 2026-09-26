// ig-test-send (JWT admin): manda o passo 1 de uma automação pra conta de TESTE (configuracoes.ig_conta_teste).
// Só funciona se a conta de teste falou com você nas últimas 24h (regra da Meta).
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";
import { type Automacao, enviarPasso, janelaAberta, type Lead } from "../_shared/instagram.ts";

servir(async (req) => {
  const { db } = await exigirAdmin(req);
  const { automation_id } = await req.json().catch(() => ({}));
  if (!automation_id) throw new HttpError(400, "Falta a automação.");

  const { data: cfg } = await db.from("configuracoes").select("valor").eq("chave", "ig_conta_teste").maybeSingle();
  const usuario = String(cfg?.valor ?? "").replace(/^@/, "").trim().toLowerCase();
  if (!usuario) throw new HttpError(400, "Configure a conta de TESTE em ⚙️ Configurações.");

  const { data: lead } = await db.from("ig_leads").select("*").ilike("username", usuario).maybeSingle();
  if (!lead) {
    throw new HttpError(400, `Ainda não conheço @${usuario}. Mande uma DM qualquer dessa conta pro seu perfil e tente de novo.`);
  }
  if (!janelaAberta(lead as Lead)) {
    throw new HttpError(400, `A janela de 24h com @${usuario} está fechada. Mande uma DM dessa conta pro seu perfil e tente de novo.`);
  }

  const { data: a } = await db.from("ig_automations").select("*").eq("id", automation_id).maybeSingle();
  if (!a) throw new HttpError(404, "Automação não encontrada.");

  const res = await enviarPasso(db, { a: a as Automacao, lead: lead as Lead, destino: { id: lead.ig_user_id }, canal: "dm", tipo: "teste" });
  if (!res.ok) throw new HttpError(400, "Não saiu: " + (res.erro ?? "erro desconhecido"));
  return json({ ok: true, para: usuario });
});
