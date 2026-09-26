// instagram-webhook (--no-verify-jwt; valida X-Hub-Signature-256 com APP_SECRET)
// GET: handshake da Meta. POST: comentários e DMs. Responde 200 rápido e processa em segundo plano.
import { adminClient, cors, HttpError, igualSeguro, servir } from "../_shared/auth.ts";
import {
  type Automacao, bate, enviar, enviarPasso, garantirLead, type Lead, recebeuNas24h,
  registrarEntrega, responderComentario, ROTULO_AUTOMATICO, sortear,
} from "../_shared/instagram.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const RE_EMAIL = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;

async function assinaturaValida(req: Request, corpo: string): Promise<boolean> {
  const segredo = Deno.env.get("APP_SECRET")?.trim();
  if (!segredo) throw new HttpError(500, "APP_SECRET não configurado.");
  const recebida = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!recebida) return false;
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo)));
  const esperada = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return igualSeguro(recebida.toLowerCase(), esperada);
}

servir(async (req) => {
  const url = new URL(req.url);

  // Handshake da Meta
  if (req.method === "GET") {
    const esperado = Deno.env.get("VERIFY_TOKEN")?.trim();
    if (url.searchParams.get("hub.mode") === "subscribe" && esperado &&
        igualSeguro(url.searchParams.get("hub.verify_token") ?? "", esperado)) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: cors });
    }
    return new Response("verify token inválido", { status: 403, headers: cors });
  }

  const corpo = await req.text();
  if (!(await assinaturaValida(req, corpo))) throw new HttpError(401, "Assinatura inválida.");
  const payload = JSON.parse(corpo);

  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(processar(payload).catch((e) => console.error("webhook", e)));
  return new Response("ok", { status: 200, headers: cors });
});

async function processar(payload: any) {
  const db = adminClient();
  for (const entry of payload?.entry ?? []) {
    const minhaConta = String(entry.id ?? "");
    for (const ch of entry.changes ?? []) {
      if (ch.field === "comments") await tratarComentario(db, minhaConta, ch.value).catch((e) => console.error("comentario", e));
    }
    for (const ev of entry.messaging ?? []) {
      await tratarMensagem(db, minhaConta, ev).catch((e) => console.error("mensagem", e));
    }
  }
}

async function automacoesAtivas(db: SupabaseClient, tipos: string[]): Promise<Automacao[]> {
  const { data } = await db.from("ig_automations").select("*").eq("active", true).in("trigger_type", tipos)
    .order("created_at");
  return (data ?? []) as Automacao[];
}

/** Escolhe a automação mais específica: post exato > todos os posts; palavra > qualquer comentário. */
function escolher(autos: Automacao[], texto: string, mediaId?: string) {
  const candidatas = autos
    .filter((a) => !a.media_ids?.length || (mediaId && a.media_ids.includes(mediaId)))
    .map((a) => ({ a, palavra: bate(a, texto) }))
    .filter((x) => x.palavra);
  candidatas.sort((x, y) => {
    const px = (x.a.media_ids?.length ? 2 : 0) + (x.palavra !== "*" ? 1 : 0);
    const py = (y.a.media_ids?.length ? 2 : 0) + (y.palavra !== "*" ? 1 : 0);
    return py - px;
  });
  return candidatas[0] ?? null;
}

// ---------------------------------------------------------------------
// Comentário
// ---------------------------------------------------------------------
async function tratarComentario(db: SupabaseClient, minhaConta: string, v: any) {
  const autorId = String(v?.from?.id ?? "");
  const commentId = String(v?.id ?? "");
  if (!autorId || !commentId) return;
  const contaEnv = Deno.env.get("IG_ACCOUNT_ID")?.trim();
  if (autorId === minhaConta || (contaEnv && autorId === contaEnv)) return; // comentário da própria conta

  const texto = String(v.text ?? "");
  const mediaId = v?.media?.id ? String(v.media.id) : undefined;
  const achou = escolher(await automacoesAtivas(db, ["comment"]), texto, mediaId);
  if (!achou) return;
  const { a, palavra } = achou;

  const lead = await garantirLead(db, autorId, v.from?.username ?? null);
  await db.from("ig_leads").update({
    last_source: "comment", last_keyword: palavra === "*" ? null : palavra, last_text: texto.slice(0, 500),
    last_media_id: mediaId ?? null, automation_id: a.id,
  }).eq("ig_user_id", autorId);

  if (await recebeuNas24h(db, autorId, a.id)) {
    await registrarEntrega(db, { ig_user_id: autorId, automation_id: a.id, canal: "private_reply", tipo: "gatilho",
      status: "pulado", motivo: "Já recebeu dessa automação nas últimas 24h" });
    return;
  }

  // Resposta privada ao comentário (só 1 por comentário, até 7 dias depois)
  const destino = { comment_id: commentId };
  let res;
  if (a.ask_message?.trim()) {
    const primeira = (lead.interactions ?? 0) === 0;
    const texto = (a.ask_message.trim() + (primeira ? "\n\n" + ROTULO_AUTOMATICO : "")).slice(0, 640);
    res = await enviar(db, destino, {
      attachment: { type: "template", payload: { template_type: "button", text: texto,
        buttons: [{ type: "postback", title: (a.ask_button?.trim() || "Quero! 👉").slice(0, 20), payload: `LINK:${a.id}` }] } },
    }, autorId);
    if (!res.ok && !res.freio && !res.rateLimit) {
      res = await enviar(db, destino, { text: texto + "\n\nMe responde aqui que eu te mando 😉" }, autorId);
    }
    await registrarEntrega(db, { ig_user_id: autorId, automation_id: a.id, canal: "private_reply", tipo: "convite", res });
    if (res.ok) await db.from("ig_leads").update({ interactions: (lead.interactions ?? 0) + 1 }).eq("ig_user_id", autorId);
  } else {
    res = await enviarPasso(db, { a, lead, destino, canal: "private_reply", tipo: "passo" });
  }

  // Resposta pública no comentário (sorteada entre as variantes)
  const variantes = [a.public_reply, ...(a.public_reply_variants ?? [])].map((s) => (s ?? "").trim()).filter(Boolean);
  const publica = sortear(variantes);
  if (publica && res.ok) {
    const nome = v.from?.username ? `@${v.from.username} ` : "";
    const r = await responderComentario(db, commentId, publica.replace(/\{\{\s*usuario\s*\}\}/g, nome.trim()), autorId);
    await registrarEntrega(db, { ig_user_id: autorId, automation_id: a.id, canal: "comment_reply", tipo: "resposta_publica", res: r });
  }
}

// ---------------------------------------------------------------------
// Mensagem (DM), postback e leitura
// ---------------------------------------------------------------------
async function tratarMensagem(db: SupabaseClient, minhaConta: string, ev: any) {
  const remetente = String(ev?.sender?.id ?? "");
  if (!remetente || remetente === minhaConta) return;          // eco / mensagem própria
  if (ev.message?.is_echo) return;
  if (ev.read || ev.reaction) return;                          // messaging_seen etc.
  const mid = ev.message?.mid ?? ev.postback?.mid;
  if (mid) {
    const { data: eco } = await db.from("ig_bot_sends").select("mid").eq("mid", mid).maybeSingle();
    if (eco) return;
  }

  const lead = await garantirLead(db, remetente);
  // Toda mensagem ou toque em botão reabre a janela de 24h
  await db.from("ig_leads").update({ last_inbound_at: new Date().toISOString(), last_source: "dm" }).eq("ig_user_id", remetente);
  lead.last_inbound_at = new Date().toISOString();
  const destino = { id: remetente };

  // Toque em botão
  if (ev.postback?.payload) {
    const p = String(ev.postback.payload);
    const [tipo, autoId, passoId] = p.split(":");
    if (tipo !== "STEP" && tipo !== "LINK") return;
    // Lido do banco NA HORA: editar o fluxo muda o que botões antigos fazem
    const { data: a } = await db.from("ig_automations").select("*").eq("id", autoId).maybeSingle();
    if (!a) return;
    await enviarPasso(db, { a: a as Automacao, lead, destino, canal: "dm", passoId: tipo === "STEP" ? passoId : undefined,
      tipo: tipo === "LINK" ? "link" : "passo" });
    return;
  }

  const texto = String(ev.message?.text ?? "");
  if (!texto && !ev.message?.attachments) return;
  await db.from("ig_leads").update({ last_text: texto.slice(0, 500) }).eq("ig_user_id", remetente);

  // Esperando e-mail ou telefone?
  const esp = lead.expecting;
  if (esp && new Date(esp.ate).getTime() > Date.now() && texto) {
    await capturar(db, lead, esp, texto);
    return;
  }

  // Palavra-chave de automação de DM (ou resposta a story)
  const tipos = ev.message?.reply_to?.story ? ["story_reply", "dm"] : ["dm"];
  const achou = escolher(await automacoesAtivas(db, tipos), texto);
  if (!achou) return;
  const { a, palavra } = achou;
  await db.from("ig_leads").update({ last_keyword: palavra === "*" ? null : palavra, automation_id: a.id })
    .eq("ig_user_id", remetente);
  if (await recebeuNas24h(db, remetente, a.id)) {
    await registrarEntrega(db, { ig_user_id: remetente, automation_id: a.id, canal: "dm", tipo: "gatilho",
      status: "pulado", motivo: "Já recebeu dessa automação nas últimas 24h" });
    return;
  }
  await enviarPasso(db, { a, lead, destino, canal: "dm", tipo: "passo" });
}

async function capturar(db: SupabaseClient, lead: Lead, esp: NonNullable<Lead["expecting"]>, texto: string) {
  const destino = { id: lead.ig_user_id };
  const bruto = texto.trim();
  let valor: string | null = null;

  if (esp.field === "email") {
    const achado = bruto.toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/)?.[0] ?? "";
    if (RE_EMAIL.test(achado)) valor = achado;
  } else {
    const dig = bruto.replace(/\D/g, "");
    if (dig.length >= 10 && dig.length <= 13) valor = dig;
  }

  if (!valor) {
    const r = await enviar(db, destino, { text: esp.field === "email"
      ? "Hmm, esse e-mail parece incompleto 🤔 Pode mandar de novo? (ex.: nome@email.com)"
      : "Hmm, não entendi o número 🤔 Pode mandar com DDD? (ex.: 11 91234-5678)" }, lead.ig_user_id);
    await registrarEntrega(db, { ig_user_id: lead.ig_user_id, automation_id: esp.automation_id, canal: "dm", tipo: "captura", res: r });
    return;
  }

  await db.from("ig_leads").update({ [esp.field]: valor, expecting: null }).eq("ig_user_id", lead.ig_user_id);
  lead.expecting = null;
  await registrarEntrega(db, { ig_user_id: lead.ig_user_id, automation_id: esp.automation_id, canal: "dm",
    tipo: `captura ${esp.field}`, status: "ok" });

  if (esp.next) {
    const { data: a } = await db.from("ig_automations").select("*").eq("id", esp.automation_id).maybeSingle();
    if (a) await enviarPasso(db, { a: a as Automacao, lead, destino, canal: "dm", passoId: esp.next });
  } else {
    const r = await enviar(db, destino, { text: "Anotado ✅ Obrigado!" }, lead.ig_user_id);
    await registrarEntrega(db, { ig_user_id: lead.ig_user_id, automation_id: esp.automation_id, canal: "dm", tipo: "captura", res: r });
  }
}
