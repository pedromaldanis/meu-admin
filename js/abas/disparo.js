// Aba 📧 Disparo: novo disparo, agendados, histórico e contatos.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LOTE_ENVIO = 50;          // por chamada da function (máx. 250)
  const CHAVE_SUB = "admin:disparo:sub";
  const AMOSTRA = { email: "maria@exemplo.com", nome: "Maria Silva" };

  let secao;
  let modo = "texto";
  let tags = [];
  let modelos = [];
  let contatos = [];
  let optout = new Map();
  let historico = [];
  let enviando = false;
  let timerAgendados = null;
  let timerContagem = null;

  const ROTULO_ALVO = (a) =>
    a === "todos" ? "👥 Todos" : a === "lista" ? "📋 Lista avulsa" : a === "teste" ? "🧪 Teste" :
    a?.startsWith("tag:") ? "🏷️ " + a.slice(4) : a;

  const STATUS_AG = {
    pendente: ["⏳ Pendente", "badge-info"],
    enviando: ["📤 Enviando", "badge-aviso"],
    enviado: ["✅ Enviado", "badge-ok"],
    erro: ["❌ Erro", "badge-erro"],
    cancelado: ["🚫 Cancelado", ""],
  };

  // =====================================================================
  // Modelo de e-mail (modo texto)
  // =====================================================================
  function linkificar(t) {
    return t.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g,
      '<a href="$1" style="color:#0a8f75;text-decoration:underline">$1</a>');
  }

  function montarHtmlTexto({ corpo, botaoTexto, botaoUrl }) {
    const paragrafos = String(corpo || "").trim().split(/\n\s*\n/).filter(Boolean).map((p) =>
      `<p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#1a1f36">${linkificar(U.esc(p).replace(/\n/g, "<br>"))}</p>`,
    ).join("");
    const botao = botaoTexto && /^https:\/\//i.test(botaoUrl || "")
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td style="border-radius:999px;background:#00FFCD">
           <a href="${U.esc(botaoUrl)}" style="display:inline-block;padding:14px 28px;font-weight:700;font-size:15px;color:#071651;text-decoration:none;border-radius:999px">${U.esc(botaoTexto)}</a>
         </td></tr></table>`
      : "";
    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:Poppins,'Segoe UI',Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:28px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
    <tr><td style="background:#071651;border-radius:16px 16px 0 0;padding:26px 32px">
      <span style="display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;border-radius:10px;background:#00FFCD;color:#071651;font-weight:700;font-size:14px;vertical-align:middle">PM</span>
      <span style="color:#ffffff;font-weight:600;font-size:17px;margin-left:10px;vertical-align:middle">Pedro Maldanis</span>
    </td></tr>
    <tr><td style="background:#ffffff;padding:34px 32px 18px;border-radius:0 0 16px 16px">
      ${paragrafos || '<p style="color:#8a93b2;font-size:15px">Seu texto aparece aqui.</p>'}
      ${botao}
    </td></tr>
    <tr><td style="padding:22px 12px;text-align:center;font-size:12px;line-height:1.6;color:#8a93b2">
      Você recebeu este e-mail porque está na lista do Pedro Maldanis.<br>
      Não quer mais receber? Responda este e-mail com a palavra <strong>SAIR</strong>.
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
  }

  function htmlAtual() {
    if (modo === "html") return $("d-html").value;
    return montarHtmlTexto({ corpo: $("d-corpo").value, botaoTexto: $("d-botao-texto").value.trim(), botaoUrl: $("d-botao-url").value.trim() });
  }

  function aplicarAmostra(t) {
    const primeiro = AMOSTRA.nome.split(" ")[0];
    return String(t)
      .replace(/\{\{\s*nome\s*\}\}/g, primeiro)
      .replace(/\{\{\s*nome_completo\s*\}\}/g, AMOSTRA.nome)
      .replace(/\{\{\s*email\s*\}\}/g, AMOSTRA.email)
      .replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, "");
  }

  let timerPrevia = null;
  function atualizarPrevia() {
    clearTimeout(timerPrevia);
    timerPrevia = setTimeout(() => {
      $("d-previa").srcdoc = aplicarAmostra(htmlAtual());
      $("d-previa-assunto").textContent = aplicarAmostra($("d-assunto").value) || "(sem assunto)";
    }, 150);
  }

  // =====================================================================
  // Bloco 1: pra quem + contagem ao vivo
  // =====================================================================
  const alvo = () => $("d-alvo").value;
  const listaColada = () => $("d-lista").value;

  async function carregarTags() {
    const { data } = await sb.rpc("contatos_tags");
    tags = data || [];
    const atual = alvo();
    $("d-alvo-tags").innerHTML = tags.length
      ? tags.map((t) => `<option value="tag:${U.esc(t.tag)}">🏷️ ${U.esc(t.tag)} (${t.qtd})</option>`).join("")
      : '<option disabled>Nenhuma tag ainda</option>';
    if ([...$("d-alvo").options].some((o) => o.value === atual)) $("d-alvo").value = atual;
    $("d-c-tag").innerHTML = '<option value="">Todas as tags</option>' +
      tags.map((t) => `<option value="${U.esc(t.tag)}">${U.esc(t.tag)} (${t.qtd})</option>`).join("");
  }

  function agendarContagem() {
    clearTimeout(timerContagem);
    timerContagem = setTimeout(contar, 350);
  }

  async function contar() {
    const el = $("d-contagem");
    $("d-lista-caixa").classList.toggle("oculto", alvo() !== "lista");
    const { data, error } = await sb.rpc("contar_destinatarios", { p_alvo: alvo(), p_lista: alvo() === "lista" ? listaColada() : null });
    if (error) { el.textContent = "Não consegui contar: " + error.message; return 0; }
    const n = data || 0;
    el.classList.toggle("zero", n === 0);
    if (n === 0) {
      el.textContent = alvo() === "teste"
        ? "⚠️ Nenhum e-mail de teste configurado. Preencha em ⚙️ Configurações."
        : alvo() === "lista" ? "⚠️ Cole pelo menos um e-mail válido." : "⚠️ Ninguém vai receber. Esse alvo está vazio.";
    } else {
      el.textContent = `✉️ ${U.numero(n)} ${n === 1 ? "pessoa vai" : "pessoas vão"} receber`;
    }
    return n;
  }

  // =====================================================================
  // Modelos
  // =====================================================================
  async function carregarModelos() {
    const { data } = await sb.from("modelos_email").select("*").order("nome");
    modelos = data || [];
    $("d-modelo").innerHTML = '<option value="">📂 Carregar modelo...</option>' +
      modelos.map((m) => `<option value="${m.id}">${U.esc(m.nome)}</option>`).join("");
  }

  function aplicarModelo(id) {
    const m = modelos.find((x) => x.id === id);
    if (!m) return;
    const c = m.config || {};
    $("d-assunto").value = m.assunto || "";
    if (c.modo === "texto") {
      trocarModo("texto");
      $("d-corpo").value = c.corpo || "";
      $("d-botao-texto").value = c.botaoTexto || "";
      $("d-botao-url").value = c.botaoUrl || "";
    } else {
      trocarModo("html");
      $("d-html").value = m.html || "";
    }
    atualizarPrevia();
    U.toast(`Modelo "${m.nome}" carregado ✓`);
    $("d-modelo").value = "";
  }

  function salvarModelo() {
    const m = U.modal({
      titulo: "💾 Salvar como modelo",
      html: `<div class="campo"><label for="m-nome">Nome do modelo</label>
             <input class="input" id="m-nome" maxlength="80" placeholder="Ex.: Convite pra live"></div>
             <p class="muted pequeno" style="margin-top:10px">Se já existir um modelo com esse nome, ele é substituído.</p>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        {
          texto: "💾 Salvar", classe: "btn-primario", acao: async (fechar, btn) => {
            const nome = m.el.querySelector("#m-nome").value.trim();
            if (!nome) return U.toast("Dê um nome pro modelo.", "erro");
            await U.comCarregando(btn, async () => {
              const config = modo === "texto"
                ? { modo, corpo: $("d-corpo").value, botaoTexto: $("d-botao-texto").value, botaoUrl: $("d-botao-url").value }
                : { modo };
              const { error } = await sb.from("modelos_email").upsert(
                { nome, assunto: $("d-assunto").value, html: htmlAtual(), config }, { onConflict: "nome" });
              if (error) return U.toast("Não salvou: " + error.message, "erro");
              fechar();
              U.toast("Modelo salvo ✓");
              carregarModelos();
            });
          },
        },
      ],
    });
  }

  function trocarModo(novo) {
    modo = novo;
    secao.querySelectorAll(".segmentado [data-modo]").forEach((b) => b.classList.toggle("ativo", b.dataset.modo === novo));
    $("d-modo-texto").classList.toggle("oculto", novo !== "texto");
    $("d-modo-html").classList.toggle("oculto", novo !== "html");
    if (novo === "html" && !$("d-html").value.trim() && $("d-corpo").value.trim()) {
      $("d-html").value = montarHtmlTexto({ corpo: $("d-corpo").value, botaoTexto: $("d-botao-texto").value, botaoUrl: $("d-botao-url").value });
    }
    atualizarPrevia();
  }

  // Placeholder vai pro último campo focado
  let ultimoCampo = null;
  function inserirPlaceholder(ph) {
    const el = ultimoCampo || (modo === "html" ? $("d-html") : $("d-corpo"));
    const ini = el.selectionStart ?? el.value.length;
    const fim = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, ini) + ph + el.value.slice(fim);
    el.focus();
    el.selectionStart = el.selectionEnd = ini + ph.length;
    atualizarPrevia();
  }

  // =====================================================================
  // Bloco 3: validar, testar, enviar, agendar
  // =====================================================================
  function validarMensagem() {
    const assunto = $("d-assunto").value.trim();
    if (!assunto) { U.toast("Escreva o assunto.", "erro"); $("d-assunto").focus(); return null; }
    if (modo === "texto" && !$("d-corpo").value.trim()) { U.toast("Escreva o texto do e-mail.", "erro"); $("d-corpo").focus(); return null; }
    if (modo === "html" && !$("d-html").value.trim()) { U.toast("Cole o HTML do e-mail.", "erro"); $("d-html").focus(); return null; }
    if (modo === "texto" && $("d-botao-texto").value.trim() && !/^https:\/\//i.test($("d-botao-url").value.trim())) {
      U.toast("O link do botão precisa começar com https://", "erro"); $("d-botao-url").focus(); return null;
    }
    return { assunto, html: htmlAtual() };
  }

  async function buscarDestinatarios(a, lista) {
    return U.buscarTudo(() => sb.rpc("destinatarios_email", { p_alvo: a, p_lista: a === "lista" ? lista : null }));
  }

  async function mandarTeste(btn) {
    const msg = validarMensagem();
    if (!msg) return;
    await U.comCarregando(btn, async () => {
      try {
        const dest = await buscarDestinatarios("teste");
        if (!dest.length) return U.toast("Configure o e-mail de teste em ⚙️ Configurações.", "erro");
        const r = await U.chamarFunction("send-bulk-email", { recipients: dest, subject: msg.assunto, html: msg.html, origem: "teste" });
        if (r.sent) U.toast(`🧪 Teste enviado pra ${dest[0].email} ✓`);
        else U.toast(r.cotaAcabou ? "A cota diária da Resend acabou." : "O teste não saiu. Veja o Histórico.", "erro", 5000);
        carregarHistorico();
      } catch (e) {
        U.toast(e.message, "erro", 6000);
      }
    });
  }

  function progresso(feito, total, texto) {
    $("d-progresso").classList.remove("oculto");
    $("d-barra").style.width = total ? `${Math.round((feito / total) * 100)}%` : "0";
    $("d-progresso-texto").textContent = texto;
  }

  async function enviarAgora() {
    if (enviando) return;
    const msg = validarMensagem();
    if (!msg) return;
    const a = alvo();
    const n = await contar();
    if (!n) return U.toast("Ninguém pra receber. Confira o bloco 1.", "erro");

    const ok = await U.confirmar(
      `Enviar "${msg.assunto}" pra ${U.numero(n)} ${n === 1 ? "pessoa" : "pessoas"} agora (${ROTULO_ALVO(a)})? Já mandou o teste pra você?`,
      { titulo: "🚀 Enviar agora?", ok: `Enviar pra ${U.numero(n)}` },
    );
    if (!ok) return;

    enviando = true;
    const btn = $("d-btn-enviar");
    btn.disabled = true;
    const tot = { sent: 0, failed: 0, skipped: 0, naoTentados: 0, cota: false };
    try {
      progresso(0, n, "Montando a lista...");
      const dest = await buscarDestinatarios(a, listaColada());
      for (let i = 0; i < dest.length; i += LOTE_ENVIO) {
        const lote = dest.slice(i, i + LOTE_ENVIO);
        progresso(i, dest.length, `Enviando ${U.numero(i + 1)} a ${U.numero(i + lote.length)} de ${U.numero(dest.length)}... não feche esta aba.`);
        const r = await U.chamarFunction("send-bulk-email", { recipients: lote, subject: msg.assunto, html: msg.html, origem: "disparo" });
        tot.sent += r.sent; tot.failed += r.failed; tot.skipped += r.skipped;
        if (r.cotaAcabou) {
          tot.cota = true;
          tot.naoTentados = r.naoTentados + (dest.length - i - lote.length);
          break;
        }
      }
      progresso(1, 1, "Pronto ✓");
    } catch (e) {
      U.toast("Parou no meio: " + e.message, "erro", 8000);
    } finally {
      enviando = false;
      btn.disabled = false;
    }

    U.modal({
      titulo: tot.cota ? "⚠️ A cota da Resend acabou" : "✅ Disparo concluído",
      html: `
        <div class="grade" style="grid-template-columns:repeat(3,1fr);gap:10px">
          <div class="card card-numero"><div class="rotulo">✅ Enviados</div><div class="numero">${U.numero(tot.sent)}</div></div>
          <div class="card card-numero"><div class="rotulo">❌ Falhas</div><div class="numero">${U.numero(tot.failed)}</div></div>
          <div class="card card-numero"><div class="rotulo">⏭️ Pulados</div><div class="numero">${U.numero(tot.skipped)}</div></div>
        </div>
        ${tot.cota ? `<p class="aviso" style="margin-top:14px">${U.numero(tot.naoTentados)} não foram tentados. Agende o mesmo e-mail pra amanhã: quem já recebeu é pulado.</p>` : ""}
        ${tot.failed ? '<p class="muted pequeno" style="margin-top:14px">Os motivos das falhas estão no 📜 Histórico.</p>' : ""}`,
      botoes: [{ texto: "Fechar", classe: "btn-primario" }],
    });
    carregarHistorico();
    carregarNumeros();
  }

  async function agendar(btn) {
    const msg = validarMensagem();
    if (!msg) return;
    const quando = $("d-quando").value;
    if (!quando) { U.toast("Escolha a data e a hora.", "erro"); $("d-quando").focus(); return; }
    const iso = U.spParaISO(quando);
    if (!iso || new Date(iso).getTime() < Date.now() - 60000) return U.toast("Essa data já passou.", "erro");
    const a = alvo();
    const n = await contar();
    if (!n) return U.toast("Ninguém pra receber. Confira o bloco 1.", "erro");

    await U.comCarregando(btn, async () => {
      const { error } = await sb.from("emails_agendados").insert({
        assunto: msg.assunto,
        html: msg.html,
        destinatario: a,
        // Os e-mails colados VIAJAM com o agendamento; sem isso o robô manda pra ninguém
        lista_emails: a === "lista" ? listaColada() : null,
        agendado_para: iso,
        total: n,
      });
      if (error) return U.toast("Não agendou: " + error.message, "erro");
      U.toast(`⏰ Agendado pra ${U.dataHora(iso)} ✓`, "ok", 4500);
      carregarAgendados();
      carregarNumeros();
    });
  }

  // =====================================================================
  // Agendados
  // =====================================================================
  async function carregarAgendados() {
    const { data, error } = await sb.from("emails_agendados")
      .select("id, assunto, destinatario, agendado_para, status, enviados, falhas, pulados, total, sent_at, erro, created_at")
      .order("agendado_para", { ascending: false }).limit(200);
    if (error) return U.toast("Erro ao ler agendados: " + error.message, "erro");
    const linhas = data || [];
    U.tabela($("d-ag-tabela"), {
      linhas,
      vazio: "Nenhum e-mail agendado. Escreva um em ✉️ Novo disparo e clique em Agendar.",
      colunas: [
        { campo: "agendado_para", titulo: "Quando", render: (l) => `<strong>${U.dataHora(l.agendado_para)}</strong>` },
        { campo: "assunto", titulo: "Assunto", render: (l) => U.esc(l.assunto) },
        { campo: "destinatario", titulo: "Pra quem", render: (l) => U.esc(ROTULO_ALVO(l.destinatario)) },
        {
          campo: "status", titulo: "Status", render: (l) => {
            const [rot, cls] = STATUS_AG[l.status] || [l.status, ""];
            return `<span class="badge ${cls}">${rot}</span>${l.erro ? `<div class="pequeno" style="color:var(--erro);margin-top:4px;max-width:320px">${U.esc(l.erro)}</div>` : ""}`;
          },
        },
        {
          campo: "enviados", titulo: "Enviados", render: (l) =>
            `${U.numero(l.enviados)} de ${U.numero(l.total)}<div class="muted pequeno">❌ ${l.falhas} · ⏭️ ${l.pulados}</div>`,
        },
        {
          titulo: "", ordenavel: false, render: (l) => `
            <div class="linha" style="justify-content:flex-end">
              <button class="btn btn-fantasma btn-p" data-ver="${l.id}">👀 Ver</button>
              ${l.status === "pendente" ? `<button class="btn btn-perigo btn-p" data-cancelar="${l.id}">Cancelar</button>` : ""}
            </div>`,
        },
      ],
    });
    // Enquanto tiver algo enviando, a contagem de cima também anda
    if (linhas.some((l) => l.status === "enviando")) carregarNumeros();
  }

  async function cancelarAgendado(id) {
    if (!(await U.confirmar("Esse e-mail não vai mais sair.", { titulo: "Cancelar agendamento?", ok: "Sim, cancelar", perigo: true }))) return;
    const { data, error } = await sb.from("emails_agendados").update({ status: "cancelado" })
      .eq("id", id).eq("status", "pendente").select("id");
    if (error) return U.toast(error.message, "erro");
    if (!data?.length) U.toast("Não deu: ele já começou a sair.", "aviso");
    else U.toast("Cancelado ✓");
    carregarAgendados();
    carregarNumeros();
  }

  async function verAgendado(id) {
    const { data } = await sb.from("emails_agendados").select("assunto, html, destinatario, lista_emails").eq("id", id).single();
    if (!data) return;
    const m = U.modal({
      titulo: "👀 " + data.assunto,
      grande: true,
      html: `<p class="muted pequeno" style="margin-bottom:10px">Pra: ${U.esc(ROTULO_ALVO(data.destinatario))}${data.lista_emails ? ` (${data.lista_emails.split(/\n+/).filter(Boolean).length} linhas coladas)` : ""}</p>
             <iframe sandbox="" style="width:100%;height:60vh;border:0;border-radius:10px;background:#f4f6fb"></iframe>`,
      botoes: [
        { texto: "✏️ Usar como base", classe: "btn-secundario", acao: (fechar) => {
          trocarModo("html"); $("d-html").value = data.html; $("d-assunto").value = data.assunto;
          irSub("novo"); atualizarPrevia(); fechar();
        } },
        { texto: "Fechar", classe: "btn-primario" },
      ],
    });
    m.el.querySelector("iframe").srcdoc = aplicarAmostra(data.html);
  }

  // =====================================================================
  // Histórico
  // =====================================================================
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");

  async function carregarStats() {
    const assunto = $("d-h-assunto").value || null;
    const { data: s } = await sb.rpc("email_stats", { p_assunto: assunto, p_dias: assunto ? 3650 : 30 });
    if (!s) return;
    const base = s.enviados || 0;
    const card = (rot, num, sub) => `<div class="card card-numero"><div class="rotulo">${rot}</div><div class="numero">${num}</div><div class="variacao">${sub}</div></div>`;
    $("d-h-stats").innerHTML =
      card("📤 Enviados", U.numero(s.enviados), assunto ? "neste assunto" : "últimos 30 dias") +
      card("❌ Falhas", U.numero(s.falhas), "não saíram") +
      card("📬 Entregues", s.webhook_ativo ? pct(s.entregues, base) : "-", s.webhook_ativo ? `${U.numero(s.entregues)} e-mails` : "precisa do webhook") +
      card("👀 Abertos", s.webhook_ativo ? pct(s.abertos, base) : "-", s.webhook_ativo ? `${U.numero(s.abertos)} e-mails` : "precisa do webhook") +
      card("🖱️ Cliques", s.webhook_ativo ? pct(s.cliques, base) : "-", s.webhook_ativo ? `${U.numero(s.cliques)} e-mails` : "precisa do webhook") +
      card("↩️ Bounces", s.webhook_ativo ? U.numero(s.bounces) : "-", s.webhook_ativo ? `+ ${s.reclamacoes} reclamações` : "precisa do webhook");
    $("d-h-webhook").classList.toggle("oculto", !!s.webhook_ativo);
  }

  async function carregarAssuntos() {
    const { data } = await sb.rpc("email_assuntos");
    const atual = $("d-h-assunto").value;
    $("d-h-assunto").innerHTML = '<option value="">Todos os assuntos</option>' +
      (data || []).map((a) => `<option value="${U.esc(a.assunto)}">${U.esc(a.assunto.slice(0, 60))} (${a.qtd})</option>`).join("");
    $("d-h-assunto").value = atual;
  }

  async function carregarHistorico() {
    let q = sb.from("email_envios").select("id, email, assunto, status, erro, origem, ts").order("ts", { ascending: false }).limit(1000);
    if ($("d-h-assunto").value) q = q.eq("assunto", $("d-h-assunto").value);
    if ($("d-h-status").value) q = q.eq("status", $("d-h-status").value);
    const busca = $("d-h-busca").value.trim().toLowerCase();
    if (busca) q = q.ilike("email", `%${busca}%`);
    const { data, error } = await q;
    if (error) return U.toast("Erro no histórico: " + error.message, "erro");
    historico = data || [];
    U.tabela($("d-h-tabela"), {
      linhas: historico,
      vazio: "Nenhum envio por aqui ainda. Que tal mandar um teste pra você?",
      colunas: [
        { campo: "ts", titulo: "Quando", render: (l) => U.dataHora(l.ts) },
        { campo: "email", titulo: "E-mail", render: (l) => U.esc(l.email) },
        { campo: "assunto", titulo: "Assunto", render: (l) => U.esc(l.assunto || "-") },
        { campo: "origem", titulo: "Origem", render: (l) => ({ disparo: "🚀 Disparo", agendado: "⏰ Agendado", teste: "🧪 Teste" })[l.origem] || l.origem },
        {
          campo: "status", titulo: "Status", render: (l) => l.status === "ok"
            ? '<span class="badge badge-ok">Enviado</span>'
            : `<span class="badge badge-erro">Erro</span><div class="pequeno" style="color:var(--erro);margin-top:4px;max-width:300px">${U.esc(l.erro || "")}</div>`,
        },
      ],
    });
    carregarStats();
  }

  // =====================================================================
  // Contatos
  // =====================================================================
  async function carregarContatos() {
    try {
      const [cs, os] = await Promise.all([
        U.buscarTudo(() => sb.from("contatos").select("id, nome, email, tags, origem, descadastrado, created_at").order("created_at", { ascending: false })),
        U.buscarTudo(() => sb.from("email_optout").select("email, motivo, created_at")),
      ]);
      contatos = cs;
      optout = new Map(os.map((o) => [o.email, o]));
      desenharContatos();
    } catch (e) {
      U.toast("Erro ao ler contatos: " + e.message, "erro");
    }
  }

  function statusContato(c) {
    if (optout.has(c.email)) return "bloqueado";
    return c.descadastrado ? "descadastrado" : "ativo";
  }

  function desenharContatos() {
    const busca = U.semAcento($("d-c-busca").value.trim());
    const tag = $("d-c-tag").value;
    const st = $("d-c-status").value;
    const linhas = contatos.filter((c) => {
      if (busca && !U.semAcento(`${c.nome || ""} ${c.email}`).includes(busca)) return false;
      if (tag && !(c.tags || []).includes(tag)) return false;
      const s = statusContato(c);
      if (st === "ativo" && s !== "ativo") return false;
      if (st === "fora" && s === "ativo") return false;
      return true;
    });
    U.tabela($("d-c-tabela"), {
      linhas,
      limite: 300,
      vazio: contatos.length ? "Ninguém com esse filtro." : "Nenhum contato ainda. Que tal importar sua lista? Clique em 📥 Importar.",
      colunas: [
        { campo: "nome", titulo: "Nome", render: (c) => `<strong>${U.esc(c.nome || "-")}</strong>` },
        { campo: "email", titulo: "E-mail", render: (c) => U.esc(c.email) },
        { titulo: "Tags", ordenavel: false, render: (c) => (c.tags || []).map((t) => `<span class="tag">${U.esc(t)}</span>`).join("") || '<span class="muted">-</span>' },
        { campo: "origem", titulo: "Origem", render: (c) => U.esc(c.origem || "-") },
        {
          titulo: "Status", ordenavel: false, render: (c) => {
            const s = statusContato(c);
            if (s === "ativo") return '<span class="badge badge-ok">Ativo</span>';
            if (s === "descadastrado") return '<span class="badge">Descadastrado</span>';
            return `<span class="badge badge-erro" title="${U.esc(optout.get(c.email)?.motivo || "")}">Bloqueado</span>`;
          },
        },
        { campo: "created_at", titulo: "Desde", render: (c) => U.data(c.created_at) },
        { titulo: "", ordenavel: false, render: (c) => `<button class="btn btn-fantasma btn-p" data-editar="${c.id}">✏️ Editar</button>` },
      ],
    });
  }

  function lerTags(texto) {
    return [...new Set(String(texto || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
  }

  function editarContato(id) {
    const c = contatos.find((x) => x.id === id) || { nome: "", email: "", tags: [], descadastrado: false };
    const novo = !c.id;
    const bloqueio = optout.get(c.email);
    const m = U.modal({
      titulo: novo ? "➕ Novo contato" : "✏️ Editar contato",
      html: `
        <div style="display:grid;gap:14px">
          <div class="campo"><label for="m-nome">Nome</label><input class="input" id="m-nome" value="${U.esc(c.nome || "")}"></div>
          <div class="campo"><label for="m-email">E-mail</label><input class="input" id="m-email" type="email" value="${U.esc(c.email)}" ${novo ? "" : "readonly"}></div>
          <div class="campo"><label for="m-tags">Tags</label><input class="input" id="m-tags" value="${U.esc((c.tags || []).join(", "))}" placeholder="clientes, lista-vip">
            <span class="ajuda">Separe por vírgula.</span></div>
          <label class="check"><input type="checkbox" id="m-descad" ${c.descadastrado ? "checked" : ""}> Descadastrado (não recebe mais)</label>
          ${bloqueio ? `<div class="aviso erro"><span>🚫</span><span>Bloqueado automaticamente: ${U.esc(bloqueio.motivo || "")}.
            <button class="btn btn-fantasma btn-p" id="m-desbloquear" style="margin-top:6px">Desbloquear</button></span></div>` : ""}
        </div>`,
      botoes: [
        ...(novo ? [] : [{ texto: "🗑️ Apagar", classe: "btn-perigo", acao: async (fechar) => {
          if (!(await U.confirmar(`Apagar ${c.email} da base? O histórico de envios continua.`, { perigo: true, ok: "Apagar" }))) return;
          const { error } = await sb.from("contatos").delete().eq("id", c.id);
          if (error) return U.toast(error.message, "erro");
          fechar(); U.toast("Apagado ✓"); carregarContatos(); carregarTags(); carregarNumeros();
        } }]),
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "💾 Salvar", classe: "btn-primario", acao: async (fechar, btn) => {
          const dados = {
            nome: m.el.querySelector("#m-nome").value.trim() || null,
            tags: lerTags(m.el.querySelector("#m-tags").value),
            descadastrado: m.el.querySelector("#m-descad").checked,
          };
          const email = m.el.querySelector("#m-email").value.trim().toLowerCase();
          if (novo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return U.toast("E-mail inválido.", "erro");
          await U.comCarregando(btn, async () => {
            const { error } = novo
              ? await sb.from("contatos").insert({ ...dados, email, origem: "manual" })
              : await sb.from("contatos").update(dados).eq("id", c.id);
            if (error) return U.toast(/duplicate|unique/i.test(error.message) ? "Esse e-mail já está na base." : error.message, "erro");
            fechar(); U.toast("Salvo ✓"); carregarContatos(); carregarTags(); carregarNumeros();
          });
        } },
      ],
    });
    const desb = m.el.querySelector("#m-desbloquear");
    if (desb) desb.addEventListener("click", async () => {
      if (!(await U.confirmar("Só desbloqueie se a pessoa pediu pra voltar. Bounce repetido prejudica a sua entrega.", { ok: "Desbloquear" }))) return;
      const { error } = await sb.from("email_optout").delete().eq("email", c.email);
      if (error) return U.toast(error.message, "erro");
      m.fechar(); U.toast("Desbloqueado ✓"); carregarContatos();
    });
  }

  // Aceita "nome;email", "email", CSV com vírgula ou tab, com ou sem cabeçalho
  function lerLinhasContato(texto) {
    const res = [];
    for (const bruta of String(texto).split(/\r?\n/)) {
      const linha = bruta.trim();
      if (!linha) continue;
      const partes = linha.split(/[;,\t]/).map((p) => p.trim().replace(/^"|"$/g, ""));
      const iEmail = partes.findIndex((p) => p.includes("@"));
      if (iEmail < 0) continue; // cabeçalho ou lixo
      const nome = partes.find((p, i) => i !== iEmail && p && !p.includes("@")) || "";
      res.push({ nome, email: partes[iEmail].toLowerCase() });
    }
    return res;
  }

  function importar() {
    const m = U.modal({
      titulo: "📥 Importar contatos",
      grande: true,
      html: `
        <div style="display:grid;gap:14px">
          <div class="campo">
            <label for="m-texto">Cole aqui (um por linha)</label>
            <textarea class="textarea mono" id="m-texto" style="min-height:200px" placeholder="Maria Silva;maria@email.com&#10;joao@email.com"></textarea>
            <span class="ajuda">Aceita "nome;email", só o e-mail, ou um CSV exportado (com vírgula ou ponto e vírgula).</span>
          </div>
          <div class="linha">
            <label class="btn btn-secundario btn-p" style="cursor:pointer">📄 Escolher arquivo CSV
              <input type="file" id="m-arquivo" accept=".csv,.txt,text/csv" hidden></label>
            <span class="muted pequeno" id="m-lidos">Nenhum contato lido ainda.</span>
          </div>
          <div class="form-grade">
            <div class="campo"><label for="m-tags">Tags pra esses contatos</label><input class="input" id="m-tags" placeholder="lista-vip, evento-set"></div>
            <div class="campo"><label for="m-origem">Origem</label><input class="input" id="m-origem" value="importacao"></div>
          </div>
          <p class="muted pequeno">Quem já está na base não é duplicado: o nome é atualizado (se vier) e as tags novas são somadas às antigas.</p>
        </div>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "📥 Importar", classe: "btn-primario", acao: async (fechar, btn) => {
          const lidos = lerLinhasContato(m.el.querySelector("#m-texto").value);
          if (!lidos.length) return U.toast("Nenhum e-mail encontrado no texto.", "erro");
          const tagsImp = lerTags(m.el.querySelector("#m-tags").value);
          const origem = m.el.querySelector("#m-origem").value.trim() || "importacao";
          await U.comCarregando(btn, async () => {
            const tot = { novos: 0, atualizados: 0, invalidos: 0 };
            for (let i = 0; i < lidos.length; i += 500) {
              const { data, error } = await sb.rpc("importar_contatos", { p: lidos.slice(i, i + 500), p_tags: tagsImp, p_origem: origem });
              if (error) return U.toast("Parou no meio: " + error.message, "erro", 6000);
              tot.novos += data.novos; tot.atualizados += data.atualizados; tot.invalidos += data.invalidos;
            }
            fechar();
            U.toast(`✓ ${tot.novos} novos, ${tot.atualizados} atualizados${tot.invalidos ? `, ${tot.invalidos} inválidos ignorados` : ""}`, "ok", 6000);
            carregarContatos(); carregarTags(); carregarNumeros(); agendarContagem();
          });
        } },
      ],
    });
    const texto = m.el.querySelector("#m-texto");
    const atualizarLidos = () => {
      const n = lerLinhasContato(texto.value).length;
      m.el.querySelector("#m-lidos").textContent = n ? `${U.numero(n)} contatos encontrados.` : "Nenhum contato lido ainda.";
    };
    texto.addEventListener("input", atualizarLidos);
    m.el.querySelector("#m-arquivo").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      texto.value = await f.text();
      atualizarLidos();
    });
  }

  function quemEstaNaBase() {
    const m = U.modal({
      titulo: "🔎 Quem está na base?",
      grande: true,
      html: `
        <div class="campo">
          <label for="m-lista">Cole os e-mails (de qualquer jeito, eu acho eles no texto)</label>
          <textarea class="textarea mono" id="m-lista" style="min-height:160px"></textarea>
        </div>
        <div id="m-resultado" style="margin-top:16px"></div>`,
      botoes: [
        { texto: "Fechar", classe: "btn-fantasma" },
        { texto: "🔎 Conferir", classe: "btn-primario", acao: async (_f, btn) => {
          const emails = [...new Set((m.el.querySelector("#m-lista").value.toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/g) || []))];
          if (!emails.length) return U.toast("Não achei nenhum e-mail no texto.", "erro");
          await U.comCarregando(btn, async () => {
            const achados = new Set();
            for (let i = 0; i < emails.length; i += 200) {
              const { data } = await sb.from("contatos").select("email").in("email", emails.slice(i, i + 200));
              (data || []).forEach((l) => achados.add(l.email));
            }
            const sim = emails.filter((e) => achados.has(e));
            const nao = emails.filter((e) => !achados.has(e));
            m.el.querySelector("#m-resultado").innerHTML = `
              <div class="grade-2">
                <div><div class="linha" style="justify-content:space-between;margin-bottom:8px"><strong>✅ Já estão (${sim.length})</strong>
                  ${sim.length ? '<button class="btn btn-fantasma btn-p" data-copiar="sim">📋 Copiar</button>' : ""}</div>
                  <div class="lista-resultado">${U.esc(sim.join("\n")) || "Ninguém."}</div></div>
                <div><div class="linha" style="justify-content:space-between;margin-bottom:8px"><strong>🆕 Não estão (${nao.length})</strong>
                  ${nao.length ? '<button class="btn btn-fantasma btn-p" data-copiar="nao">📋 Copiar</button>' : ""}</div>
                  <div class="lista-resultado">${U.esc(nao.join("\n")) || "Todo mundo já está."}</div></div>
              </div>`;
            m.el.querySelectorAll("[data-copiar]").forEach((b) => b.addEventListener("click", () =>
              U.copiar((b.dataset.copiar === "sim" ? sim : nao).join("\n"))));
          });
        } },
      ],
    });
  }

  // =====================================================================
  // Números do topo
  // =====================================================================
  async function carregarNumeros() {
    const [c, s, a] = await Promise.all([
      sb.from("contatos").select("id", { count: "exact", head: true }).eq("descadastrado", false),
      sb.rpc("email_stats", { p_assunto: null, p_dias: 30 }),
      sb.from("emails_agendados").select("id", { count: "exact", head: true }).in("status", ["pendente", "enviando"]),
    ]);
    $("d-n-contatos").textContent = U.numero(c.count ?? 0);
    $("d-n-agendados").textContent = U.numero(a.count ?? 0);
    const st = s.data || {};
    $("d-n-enviados").textContent = U.numero(st.enviados ?? 0);
    $("d-n-falhas").textContent = st.falhas ? `${U.numero(st.falhas)} com erro` : "e-mails";
    if (st.webhook_ativo && st.enviados) {
      $("d-n-abertura").textContent = pct(st.abertos, st.enviados);
      $("d-n-abertura-sub").textContent = `${U.numero(st.cliques)} cliques`;
    }
  }

  // =====================================================================
  // Sub-abas
  // =====================================================================
  function irSub(nome) {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.classList.toggle("ativo", b.dataset.sub === nome));
    secao.querySelectorAll(".subaba").forEach((s) => s.classList.toggle("ativa", s.dataset.sub === nome));
    U.guardar.gravar(CHAVE_SUB, nome);
    if (nome === "agendados") carregarAgendados();
    if (nome === "historico") { carregarAssuntos(); carregarHistorico(); }
    if (nome === "contatos") carregarContatos();
  }

  function ligarEventos() {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.addEventListener("click", () => irSub(b.dataset.sub)));
    secao.querySelectorAll("[data-ir-sub]").forEach((b) => b.addEventListener("click", () => irSub(b.dataset.irSub)));

    $("d-alvo").addEventListener("change", agendarContagem);
    $("d-lista").addEventListener("input", agendarContagem);

    secao.querySelectorAll(".segmentado [data-modo]").forEach((b) => b.addEventListener("click", () => trocarModo(b.dataset.modo)));
    ["d-assunto", "d-corpo", "d-botao-texto", "d-botao-url", "d-html"].forEach((id) => {
      $(id).addEventListener("input", atualizarPrevia);
      $(id).addEventListener("focus", () => { if (id !== "d-botao-texto" && id !== "d-botao-url") ultimoCampo = $(id); });
    });
    secao.querySelectorAll(".chip[data-ph]").forEach((b) => b.addEventListener("click", () => inserirPlaceholder(b.dataset.ph)));
    $("d-modelo").addEventListener("change", (e) => aplicarModelo(e.target.value));
    $("d-salvar-modelo").addEventListener("click", salvarModelo);

    $("d-btn-teste").addEventListener("click", (e) => mandarTeste(e.currentTarget));
    $("d-btn-enviar").addEventListener("click", enviarAgora);
    $("d-btn-agendar").addEventListener("click", (e) => agendar(e.currentTarget));

    $("d-ag-atualizar").addEventListener("click", carregarAgendados);
    $("d-ag-tabela").addEventListener("click", (e) => {
      const c = e.target.closest("[data-cancelar]");
      if (c) cancelarAgendado(c.dataset.cancelar);
      const v = e.target.closest("[data-ver]");
      if (v) verAgendado(v.dataset.ver);
    });

    let timerBusca;
    $("d-h-busca").addEventListener("input", () => { clearTimeout(timerBusca); timerBusca = setTimeout(carregarHistorico, 350); });
    $("d-h-assunto").addEventListener("change", carregarHistorico);
    $("d-h-status").addEventListener("change", carregarHistorico);
    $("d-h-csv").addEventListener("click", () => U.baixarCSV(`envios-${U.spInput().slice(0, 10)}.csv`, historico, [
      { titulo: "Quando", valor: (l) => U.dataHora(l.ts) }, { titulo: "E-mail", campo: "email" },
      { titulo: "Assunto", campo: "assunto" }, { titulo: "Origem", campo: "origem" },
      { titulo: "Status", campo: "status" }, { titulo: "Erro", campo: "erro" },
    ]));

    $("d-c-busca").addEventListener("input", desenharContatos);
    $("d-c-tag").addEventListener("change", desenharContatos);
    $("d-c-status").addEventListener("change", desenharContatos);
    $("d-c-novo").addEventListener("click", () => editarContato(null));
    $("d-c-importar").addEventListener("click", importar);
    $("d-c-quem").addEventListener("click", quemEstaNaBase);
    $("d-c-csv").addEventListener("click", () => U.baixarCSV(`contatos-${U.spInput().slice(0, 10)}.csv`, contatos, [
      { titulo: "Nome", campo: "nome" }, { titulo: "E-mail", campo: "email" }, { titulo: "Tags", campo: "tags" },
      { titulo: "Origem", campo: "origem" }, { titulo: "Status", valor: statusContato },
      { titulo: "Desde", valor: (c) => U.data(c.created_at) },
    ]));
    $("d-c-tabela").addEventListener("click", (e) => {
      const b = e.target.closest("[data-editar]");
      if (b) editarContato(b.dataset.editar);
    });

    window.addEventListener("beforeunload", (e) => {
      if (enviando) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  window.ABAS = window.ABAS || {};
  window.ABAS.disparo = {
    iniciar(el) {
      secao = el;
      ligarEventos();
      $("d-quando").min = U.spInput();
      $("d-quando").value = U.spInput(60);
      atualizarPrevia();
      carregarTags().then(contar);
      carregarModelos();
      carregarNumeros();
      irSub(U.guardar.ler(CHAVE_SUB, "novo"));
      // Agendados se atualizam sozinhos enquanto a aba está aberta
      timerAgendados = setInterval(() => {
        if (document.hidden || !secao.classList.contains("ativa")) return;
        const sub = secao.querySelector(".subaba.ativa")?.dataset.sub;
        if (sub === "agendados") carregarAgendados();
      }, 20000);
    },
    mostrar() {
      carregarNumeros();
    },
  };
})();
