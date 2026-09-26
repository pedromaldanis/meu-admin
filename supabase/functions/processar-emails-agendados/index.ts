// processar-emails-agendados (cron a cada 1 minuto, x-sched-key, --no-verify-jwt)
// Pega 1 agendamento vencido, monta os destinatários, envia em lotes de 100.
// Responde na hora e trabalha em segundo plano (o cron não fica esperando).
import { adminClient, exigirSchedKey, json, servir } from "../_shared/auth.ts";
import {
  carregarRemetente, type Destinatario, emailValido, enviarLote, enviarUm, espera, montarPayload, type Resultado,
} from "../_shared/email.ts";

const LOTE = 100;
const ORCAMENTO_MS = 110_000; // passa disso, devolve pra fila e o próximo minuto continua

type Agendado = {
  id: string; assunto: string; html: string; destinatario: string; lista_emails: string | null;
  enviados: number; falhas: number; pulados: number; total: number;
};

servir(async (req) => {
  exigirSchedKey(req);
  const db = adminClient();

  const { data, error } = await db.rpc("pegar_email_agendado");
  if (error) throw error;
  const ag: Agendado | undefined = data?.[0];
  if (!ag) return json({ ok: true, nada: true });

  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(processar(ag).catch(async (e) => {
    console.error(e);
    await db.from("emails_agendados").update({ status: "erro", erro: String(e?.message ?? e).slice(0, 500) }).eq("id", ag.id);
  }));
  return json({ ok: true, processando: ag.id }, 202);
});

async function processar(ag: Agendado) {
  const db = adminClient();
  const inicio = Date.now();
  const falhar = (erro: string, extra: Record<string, unknown> = {}) =>
    db.from("emails_agendados").update({ status: "erro", erro, ...extra }).eq("id", ag.id);

  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  if (!apiKey) return falhar("RESEND_API_KEY não configurada. Nada foi enviado.");

  // 1) Destinatários pelo alvo (já sem optout e descadastrados)
  const todos: Destinatario[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await db
      .rpc("destinatarios_email", { p_alvo: ag.destinatario, p_lista: ag.lista_emails })
      .range(de, de + 999);
    if (error) return falhar("Erro ao montar destinatários: " + error.message);
    todos.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  // TRAVA: zero destinatários nunca vira "enviado"
  if (todos.length === 0) {
    return falhar(`Nenhum destinatário encontrado pro alvo ${ag.destinatario}. Nada foi enviado.`, { total: 0 });
  }

  // 2) Pula quem JÁ recebeu esse mesmo assunto com sucesso (continua disparo interrompido)
  const jaRecebeu = new Set<string>();
  for (let de = 0; ; de += 1000) {
    const { data } = await db.from("email_envios").select("email")
      .eq("assunto", ag.assunto).eq("status", "ok").range(de, de + 999);
    (data ?? []).forEach((l) => jaRecebeu.add(l.email));
    if (!data || data.length < 1000) break;
  }

  // 3) Valida formato antes (a Resend recusa o lote inteiro se um endereço estiver quebrado)
  const invalidos = todos.filter((d) => !emailValido(d.email));
  const fila = todos.filter((d) => emailValido(d.email) && !jaRecebeu.has(d.email));
  // Retomando (rodada anterior estourou o tempo): quem já foi nessa mesma rodada não conta como pulado
  const retomando = ag.enviados + ag.falhas > 0;
  const pulados = Math.max(0, todos.length - fila.length - invalidos.length - (retomando ? ag.enviados : 0));

  let enviados = 0, falhas = 0;
  if (invalidos.length && !retomando) {
    falhas += invalidos.length;
    await db.from("email_envios").insert(invalidos.map((d) => ({
      email: d.email, assunto: ag.assunto, status: "erro", erro: "E-mail com formato inválido", origem: "agendado",
    })));
  }

  const salvarProgresso = (extra: Record<string, unknown> = {}) =>
    db.from("emails_agendados").update({
      enviados: ag.enviados + enviados, falhas: ag.falhas + falhas, pulados: pulados,
      total: todos.length, lock_at: new Date().toISOString(), ...extra,
    }).eq("id", ag.id);

  await salvarProgresso();
  const rem = await carregarRemetente(db);

  // 4) Envia em lotes de 100
  for (let i = 0; i < fila.length; i += LOTE) {
    if (Date.now() - inicio > ORCAMENTO_MS) {
      // Tempo acabando: devolve pra fila; o próximo minuto continua sem repetir ninguém
      await salvarProgresso({ status: "pendente", lock_at: null });
      return;
    }

    const lote = fila.slice(i, i + LOTE);
    const payloads = lote.map((d) => montarPayload(rem, d, ag.assunto, ag.html));
    let resultados: Resultado[];

    const r = await enviarLote(apiKey, payloads);
    if ("resultados" in r) {
      resultados = r.resultados;
    } else if (r.falhouLote.cota) {
      resultados = lote.map(() => r.falhouLote);
    } else {
      // Lote caiu: reenvia um a um pra só o culpado ficar de fora
      resultados = [];
      for (const p of payloads) {
        const u = await enviarUm(apiKey, p);
        resultados.push(u);
        if (u.cota) break;
        await espera(250);
      }
    }

    const linhas = resultados.map((res, k) => ({
      email: lote[k].email, assunto: ag.assunto, status: res.ok ? "ok" : "erro",
      erro: res.ok ? null : res.erro, resend_id: res.id ?? null, origem: "agendado",
    }));
    await db.from("email_envios").insert(linhas);
    enviados += resultados.filter((x) => x.ok).length;
    falhas += resultados.filter((x) => !x.ok).length;

    if (resultados.some((x) => x.cota)) {
      await salvarProgresso({
        status: "erro",
        erro: `A cota diária da Resend acabou. ${ag.enviados + enviados} enviados até aqui. ` +
          "Reagende pra amanhã: quem já recebeu é pulado automaticamente.",
      });
      return;
    }

    await salvarProgresso();
    await espera(600);
  }

  await salvarProgresso({ status: "enviado", sent_at: new Date().toISOString(), lock_at: null });
}
