// resend-webhook (--no-verify-jwt; valida a assinatura Svix da Resend)
// Grava entregue/aberto/clique/bounce/reclamação. Bounce e reclamação viram optout.
import { adminClient, HttpError, igualSeguro, json, servir } from "../_shared/auth.ts";

const TIPOS = new Set(["email.delivered", "email.opened", "email.clicked", "email.bounced", "email.complained"]);
const TOLERANCIA_S = 5 * 60;

function b64ParaBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function assinaturaValida(req: Request, corpo: string): Promise<boolean> {
  const segredo = Deno.env.get("RESEND_WEBHOOK_SECRET")?.trim();
  if (!segredo) throw new HttpError(500, "RESEND_WEBHOOK_SECRET não configurado.");

  const id = req.headers.get("svix-id");
  const ts = req.headers.get("svix-timestamp");
  const assinaturas = req.headers.get("svix-signature");
  if (!id || !ts || !assinaturas) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCIA_S) return false;

  const chave = await crypto.subtle.importKey(
    "raw", b64ParaBytes(segredo.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(`${id}.${ts}.${corpo}`));
  const esperado = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // O header pode ter várias: "v1,abc v1,def"
  return assinaturas.split(" ").some((a) => {
    const [versao, sig] = a.split(",");
    return versao === "v1" && !!sig && igualSeguro(sig, esperado);
  });
}

servir(async (req) => {
  if (req.method !== "POST") return json({ ok: true });
  const corpo = await req.text();
  if (!(await assinaturaValida(req, corpo))) throw new HttpError(401, "Assinatura inválida.");

  const evento = JSON.parse(corpo);
  const tipo = String(evento?.type ?? "");
  if (!TIPOS.has(tipo)) return json({ ok: true, ignorado: tipo });

  const d = evento.data ?? {};
  const email = String((Array.isArray(d.to) ? d.to[0] : d.to) ?? "").trim().toLowerCase() || null;
  const db = adminClient();

  await db.from("email_eventos").insert({
    tipo, email, resend_id: d.email_id ?? null, payload: evento,
    ts: evento.created_at ?? new Date().toISOString(),
  });

  if (email && (tipo === "email.bounced" || tipo === "email.complained")) {
    const motivo = tipo === "email.bounced"
      ? `bounce${d.bounce?.type ? " (" + d.bounce.type + ")" : ""}`
      : "reclamação de spam";
    await db.from("email_optout").upsert({ email, motivo }, { onConflict: "email", ignoreDuplicates: true });
  }

  return json({ ok: true });
});
