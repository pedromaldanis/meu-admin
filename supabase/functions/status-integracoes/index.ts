// status-integracoes (JWT admin)
// Diz se cada integração está configurada, sem NUNCA devolver valor de chave.
import { exigirAdmin, json, servir, temSecret } from "../_shared/auth.ts";

type Item = { nome: string; ok: boolean; obrigatorio: boolean; dica: string };
type Integracao = {
  id: string;
  nome: string;
  emoji: string;
  fase: number;
  status: "configurado" | "parcial" | "nao_configurado" | "vencendo" | "vencido";
  resumo: string;
  itens: Item[];
};

function item(nome: string, dica: string, obrigatorio = true): Item {
  return { nome, ok: temSecret(nome), obrigatorio, dica };
}

function statusPorItens(itens: Item[]): Integracao["status"] {
  const obrig = itens.filter((i) => i.obrigatorio);
  const ok = obrig.filter((i) => i.ok).length;
  if (ok === obrig.length) return "configurado";
  if (ok === 0) return "nao_configurado";
  return "parcial";
}

const RESUMO: Record<string, string> = {
  configurado: "Tudo certo por aqui.",
  parcial: "Falta configurar algum secret.",
  nao_configurado: "Ainda não configurado.",
};

servir(async (req) => {
  const { db } = await exigirAdmin(req);

  // 📧 Resend
  const resendItens = [
    item("RESEND_API_KEY", "Chave da API da Resend (resend.com > API Keys)."),
    item("RESEND_WEBHOOK_SECRET", "Segredo do webhook da Resend (opcional, liga as taxas de abertura e clique).", false),
  ];
  const resendStatus = statusPorItens(resendItens);

  // 🤖 Instagram
  const igItens = [
    item("IG_ACCESS_TOKEN", "Token de longa duração (60 dias) gerado na tela do produto Instagram."),
    item("IG_ACCOUNT_ID", "Id numérico da conta (GET /me?fields=id,username)."),
    item("APP_SECRET", "Chave secreta do app do INSTAGRAM (não a do Facebook)."),
    item("VERIFY_TOKEN", "Texto que você inventa pro handshake do webhook."),
  ];
  let igStatus = statusPorItens(igItens);
  let igResumo = RESUMO[igStatus];
  let venceEmDias: number | null = null;

  if (temSecret("IG_ACCESS_TOKEN")) {
    // ig_token_status nasce na FASE 3; antes disso a consulta só falha em silêncio.
    const { data } = await db
      .from("ig_token_status")
      .select("expires_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.expires_at) {
      venceEmDias = Math.ceil((new Date(data.expires_at).getTime() - Date.now()) / 86_400_000);
      if (venceEmDias <= 0) {
        igStatus = "vencido";
        igResumo = "Token vencido. Gere um novo e atualize o secret.";
      } else {
        if (venceEmDias <= 10 && igStatus === "configurado") igStatus = "vencendo";
        igResumo = `Token vence em ${venceEmDias} ${venceEmDias === 1 ? "dia" : "dias"}.`;
      }
    } else if (igStatus === "configurado") {
      igResumo = "Configurado. Validade do token ainda não verificada.";
    }
  }

  // ✨ IA
  const iaItens = [
    item("ANTHROPIC_API_KEY", "Chave da Anthropic (console.anthropic.com).", false),
    item("OPENAI_API_KEY", "Chave da OpenAI (platform.openai.com).", false),
    item("SUPADATA_API_KEY", "Chave da Supadata, pra transcrever vídeos (FASE 5).", false),
  ];
  const provedor = temSecret("ANTHROPIC_API_KEY") ? "Anthropic" : temSecret("OPENAI_API_KEY") ? "OpenAI" : null;
  const iaStatus: Integracao["status"] = provedor ? "configurado" : "nao_configurado";
  const iaResumo = provedor ? `Usando ${provedor}.` : "Nenhuma chave de IA ainda. As partes com IA ficam desligadas.";

  // ⏱️ Robôs (cron)
  const robosItens = [item("SCHED_SECRET", "Senha que o cron manda no header x-sched-key.")];
  const robosStatus = statusPorItens(robosItens);

  const integracoes: Integracao[] = [
    { id: "resend", nome: "Resend", emoji: "📧", fase: 2, status: resendStatus, resumo: RESUMO[resendStatus], itens: resendItens },
    { id: "instagram", nome: "Instagram", emoji: "📸", fase: 3, status: igStatus, resumo: igResumo, itens: igItens },
    { id: "ia", nome: "Inteligência artificial", emoji: "✨", fase: 4, status: iaStatus, resumo: iaResumo, itens: iaItens },
    { id: "robos", nome: "Robôs (cron)", emoji: "⏱️", fase: 2, status: robosStatus, resumo: RESUMO[robosStatus], itens: robosItens },
  ];

  // O verify token não é chave de API: é o texto que você cola no painel da Meta pro handshake do webhook.
  const verifyToken = Deno.env.get("VERIFY_TOKEN")?.trim() || null;

  return json({ ok: true, verificado_em: new Date().toISOString(), venceEmDias, verifyToken, integracoes });
});
