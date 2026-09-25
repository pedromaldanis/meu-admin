// Núcleo compartilhado: cliente do Supabase + utilidades de tela.
// Tudo fica em window.sb (cliente) e window.U (utilidades).
(function () {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const FUSO = cfg.FUSO || "America/Sao_Paulo";

  const configFaltando =
    !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY ||
    cfg.SUPABASE_URL.startsWith("COLE_") || cfg.SUPABASE_ANON_KEY.startsWith("COLE_");

  if (!configFaltando) {
    window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }

  // ---------------------------------------------------------------------
  // Texto e datas
  // ---------------------------------------------------------------------
  function esc(v) {
    return String(v ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  const fmtDH = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const fmtD = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric" });
  const fmtH = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });

  function paraData(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d) ? null : d;
  }
  /** Sempre em horário de São Paulo. */
  const dataHora = (v) => { const d = paraData(v); return d ? fmtDH.format(d).replace(",", " às") : "-"; };
  const data = (v) => { const d = paraData(v); return d ? fmtD.format(d) : "-"; };
  const hora = (v) => { const d = paraData(v); return d ? fmtH.format(d) : "-"; };

  const numero = (n) => (n == null || isNaN(n) ? "-" : Number(n).toLocaleString("pt-BR"));

  function iniciais(nome) {
    return String(nome || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }

  // ---------------------------------------------------------------------
  // localStorage protegido (pode falhar em aba anônima)
  // ---------------------------------------------------------------------
  const guardar = {
    ler(chave, padrao = null) {
      try { const v = localStorage.getItem(chave); return v == null ? padrao : v; } catch { return padrao; }
    },
    gravar(chave, valor) {
      try { localStorage.setItem(chave, valor); } catch { /* sem storage, segue a vida */ }
    },
  };

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------
  function toast(msg, tipo = "ok", ms = 3200) {
    let caixa = document.querySelector(".toasts");
    if (!caixa) {
      caixa = document.createElement("div");
      caixa.className = "toasts";
      caixa.setAttribute("role", "status");
      caixa.setAttribute("aria-live", "polite");
      document.body.appendChild(caixa);
    }
    const el = document.createElement("div");
    el.className = "toast " + (tipo === "ok" ? "" : tipo);
    el.textContent = msg;
    caixa.appendChild(el);
    setTimeout(() => { el.classList.add("saindo"); setTimeout(() => el.remove(), 260); }, ms);
  }

  // ---------------------------------------------------------------------
  // Modal
  // U.modal({ titulo, html, grande, botoes: [{ texto, classe, acao(fechar) }] })
  // ---------------------------------------------------------------------
  function modal({ titulo = "", html = "", grande = false, botoes = [], aoFechar } = {}) {
    const fundo = document.createElement("div");
    fundo.className = "modal-fundo";
    fundo.innerHTML = `
      <div class="modal ${grande ? "modal-grande" : ""}" role="dialog" aria-modal="true">
        <div class="modal-cabecalho">
          <h2>${esc(titulo)}</h2>
          <button class="modal-fechar" aria-label="Fechar">×</button>
        </div>
        <div class="modal-corpo">${html}</div>
        <div class="modal-rodape"></div>
      </div>`;
    const rodape = fundo.querySelector(".modal-rodape");
    if (!botoes.length) rodape.remove();

    function fechar() {
      document.removeEventListener("keydown", tecla);
      fundo.remove();
      if (aoFechar) aoFechar();
    }
    function tecla(e) { if (e.key === "Escape") fechar(); }

    botoes.forEach((b) => {
      const btn = document.createElement("button");
      btn.className = "btn " + (b.classe || "btn-secundario");
      btn.textContent = b.texto;
      btn.addEventListener("click", () => (b.acao ? b.acao(fechar, btn) : fechar()));
      rodape.appendChild(btn);
    });

    fundo.querySelector(".modal-fechar").addEventListener("click", fechar);
    fundo.addEventListener("mousedown", (e) => { if (e.target === fundo) fechar(); });
    document.addEventListener("keydown", tecla);
    document.body.appendChild(fundo);
    const foco = fundo.querySelector("input, textarea, select");
    if (foco) foco.focus();
    return { el: fundo, corpo: fundo.querySelector(".modal-corpo"), fechar };
  }

  function confirmar(msg, { titulo = "Tem certeza?", ok = "Sim, pode", perigo = false } = {}) {
    return new Promise((resolve) => {
      let respondeu = false;
      modal({
        titulo,
        html: `<p class="muted">${esc(msg)}</p>`,
        aoFechar: () => { if (!respondeu) resolve(false); },
        botoes: [
          { texto: "Cancelar", classe: "btn-fantasma" },
          { texto: ok, classe: perigo ? "btn-perigo" : "btn-primario", acao: (fechar) => { respondeu = true; fechar(); resolve(true); } },
        ],
      });
    });
  }

  // ---------------------------------------------------------------------
  // Botão com estado de carregando
  // ---------------------------------------------------------------------
  async function comCarregando(btn, fn) {
    if (!btn) return fn();
    btn.classList.add("carregando");
    btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove("carregando"); btn.disabled = false; }
  }

  // ---------------------------------------------------------------------
  // Chamar Edge Function com a sessão do usuário
  // ---------------------------------------------------------------------
  async function chamarFunction(nome, body) {
    const { data: resp, error } = await window.sb.functions.invoke(nome, { body: body ?? {} });
    if (error) {
      let msg = error.message || "Erro ao chamar " + nome;
      try {
        const j = await error.context.json();
        msg = j.erro || j.error || j.message || msg;
      } catch { /* resposta sem JSON */ }
      if (/Failed to send a request|Failed to fetch/i.test(msg)) {
        msg = `A function "${nome}" não respondeu. Ela já foi publicada?`;
      }
      throw new Error(msg);
    }
    return resp;
  }

  // ---------------------------------------------------------------------
  // Tabela com busca e ordenação simples
  // U.ordenarTabela(tabelaEl, linhas, render) : clica no <th data-campo> e ordena
  // ---------------------------------------------------------------------
  function ordenarPor(lista, campo, dir) {
    const m = dir === "desc" ? -1 : 1;
    return [...lista].sort((a, b) => {
      const va = a[campo], vb = b[campo];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * m;
      return String(va).localeCompare(String(vb), "pt-BR", { numeric: true }) * m;
    });
  }

  function semAcento(s) {
    return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  window.U = {
    FUSO, configFaltando, esc, dataHora, data, hora, numero, iniciais, guardar,
    toast, modal, confirmar, comCarregando, chamarFunction, ordenarPor, semAcento,
  };
})();
