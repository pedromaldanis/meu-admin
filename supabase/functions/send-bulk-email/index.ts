// send-bulk-email (JWT admin)
// Body: { recipients: [{email, nome, ...campos}], subject, html, origem?: 'disparo'|'teste' }
// Máximo 250 por chamada (o painel manda em lotes). Um a um, 200ms entre cada.
import { exigirAdmin, HttpError, json, servir } from "../_shared/auth.ts";
import { carregarRemetente, type Destinatario, emailValido, enviarUm, espera, montarPayload } from "../_shared/email.ts";

const MAX = 250;

servir(async (req) => {
  const { db } = await exigirAdmin(req);

  const apiKey = Deno.env.get("RESEND_API_KEY")?.trim();
  if (!apiKey) throw new HttpError(400, "RESEND_API_KEY não configurada. Veja a aba Configurações.");

  const body = await req.json().catch(() => ({}));
  const subject = String(body.subject ?? "").trim();
  const html = String(body.html ?? "");
  const origem = body.origem === "teste" ? "teste" : "disparo";
  const recipients: Destinatario[] = Array.isArray(body.recipients) ? body.recipients : [];

  if (!subject) throw new HttpError(400, "Falta o assunto.");
  if (!html.trim()) throw new HttpError(400, "Falta a mensagem.");
  if (!recipients.length) throw new HttpError(400, "Nenhum destinatário.");
  if (recipients.length > MAX) throw new HttpError(400, `Máximo de ${MAX} por chamada. Mande em lotes.`);

  // Normaliza e tira duplicados
  const vistos = new Set<string>();
  const lista = recipients
    .map((r) => ({ ...r, email: String(r.email ?? "").trim().toLowerCase() }))
    .filter((r) => (vistos.has(r.email) ? false : (vistos.add(r.email), true)));

  // Quem não pode receber: optout ou descadastrado
  const emails = lista.map((r) => r.email);
  const [{ data: optout }, { data: descad }] = await Promise.all([
    db.from("email_optout").select("email").in("email", emails),
    db.from("contatos").select("email").in("email", emails).eq("descadastrado", true),
  ]);
  const bloqueados = new Set([...(optout ?? []), ...(descad ?? [])].map((l) => l.email));

  const rem = await carregarRemetente(db);
  let sent = 0, failed = 0, skipped = 0, cotaAcabou = false, naoTentados = 0;
  const linhas: Record<string, unknown>[] = [];

  for (let i = 0; i < lista.length; i++) {
    const d = lista[i];
    if (bloqueados.has(d.email)) { skipped++; continue; }
    if (!emailValido(d.email)) {
      failed++;
      linhas.push({ email: d.email, assunto: subject, status: "erro", erro: "E-mail com formato inválido", origem });
      continue;
    }

    const r = await enviarUm(apiKey, montarPayload(rem, d, subject, html));
    if (r.ok) {
      sent++;
      linhas.push({ email: d.email, assunto: subject, status: "ok", resend_id: r.id ?? null, origem });
    } else {
      failed++;
      linhas.push({ email: d.email, assunto: subject, status: "erro", erro: r.erro, origem });
      if (r.cota) {
        // Cota diária acabou: para na hora
        cotaAcabou = true;
        naoTentados = lista.length - i - 1;
        break;
      }
    }
    await espera(200);
  }

  if (linhas.length) {
    const { error } = await db.from("email_envios").insert(linhas);
    if (error) console.error("gravar email_envios", error);
  }

  return json({ sent, failed, skipped, cotaAcabou, naoTentados });
});
