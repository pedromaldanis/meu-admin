// ig-scheduler (cron a cada 1 minuto, x-sched-key, --no-verify-jwt)
// Envia os passos com atraso que venceram, se a janela de 24h da pessoa ainda estiver aberta.
import { adminClient, exigirSchedKey, json, servir } from "../_shared/auth.ts";
import { type Automacao, enviarPasso, janelaAberta, type Lead } from "../_shared/instagram.ts";

servir(async (req) => {
  exigirSchedKey(req);
  const db = adminClient();
  const { data: fila, error } = await db.rpc("pegar_ig_agendados", { p_limite: 20 });
  if (error) throw error;

  let enviados = 0, cancelados = 0, adiados = 0;
  for (const item of fila ?? []) {
    const cancelar = (motivo: string) =>
      db.from("ig_scheduled").update({ canceled: true, cancel_reason: motivo }).eq("id", item.id);

    const { data: lead } = await db.from("ig_leads").select("*").eq("ig_user_id", item.ig_user_id).maybeSingle();
    if (!lead) { await cancelar("Lead não existe mais"); cancelados++; continue; }
    if (!janelaAberta(lead as Lead)) { await cancelar("Janela de 24h fechada (a pessoa não falou nas últimas 24h)"); cancelados++; continue; }

    const { data: a } = await db.from("ig_automations").select("*").eq("id", item.automation_id).maybeSingle();
    if (!a) { await cancelar("Automação apagada"); cancelados++; continue; }
    if (!a.active) { await cancelar("Automação pausada"); cancelados++; continue; }

    const res = await enviarPasso(db, { a: a as Automacao, lead: lead as Lead, destino: { id: item.ig_user_id },
      canal: "dm", passoId: item.step_id, tipo: "passo agendado" });
    if (res.ok) {
      await db.from("ig_scheduled").update({ sent: true }).eq("id", item.id);
      enviados++;
    } else if (res.freio || res.rateLimit) {
      // Freio segurou: solta pra tentar no próximo minuto
      await db.from("ig_scheduled").update({ claimed_at: null }).eq("id", item.id);
      adiados++;
      break;
    } else {
      await cancelar("Erro ao enviar: " + (res.erro ?? "desconhecido"));
      cancelados++;
    }
  }
  return json({ ok: true, enviados, cancelados, adiados });
});
