// Utilidades compartilhadas por todas as Edge Functions do painel.
import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";

export const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sched-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Cliente com service role. Só existe dentro das functions, nunca no site. */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Secret presente e não vazio (sem nunca devolver o valor). */
export function temSecret(nome: string): boolean {
  return !!Deno.env.get(nome)?.trim();
}

/**
 * Functions chamadas pelo PAINEL: valida o JWT do usuário e confere
 * usuarios.role = 'admin' antes de qualquer coisa.
 */
export async function exigirAdmin(req: Request): Promise<{ user: User; db: SupabaseClient }> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Sem login. Entre no painel de novo.");

  const db = adminClient();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Sessão inválida ou expirada. Entre de novo.");

  const { data: perfil, error: errPerfil } = await db
    .from("usuarios")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (errPerfil) throw new HttpError(500, "Não consegui conferir o seu acesso.");
  if (perfil?.role !== "admin") throw new HttpError(403, "Seu usuário não tem acesso de admin.");

  return { user: data.user, db };
}

/**
 * Functions chamadas por CRON ou WEBHOOK interno: confere o header
 * x-sched-key contra o secret SCHED_SECRET. Essas functions são
 * publicadas com --no-verify-jwt (o cron não tem login).
 */
export function exigirSchedKey(req: Request): void {
  const esperado = Deno.env.get("SCHED_SECRET")?.trim();
  if (!esperado) throw new HttpError(500, "SCHED_SECRET não configurado.");
  const recebido = req.headers.get("x-sched-key")?.trim() ?? "";
  if (!igualSeguro(recebido, esperado)) throw new HttpError(401, "x-sched-key inválida.");
}

/** Comparação em tempo constante, pra não vazar a chave por tempo de resposta. */
export function igualSeguro(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Envolve o handler: responde OPTIONS (CORS) e transforma erros em JSON. */
export function servir(fn: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ erro: e.message }, e.status);
      console.error(e);
      return json({ erro: "Erro inesperado. Veja os logs da function no Supabase." }, 500);
    }
  });
}
