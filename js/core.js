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

  // ---------------------------------------------------------------------
  // Tabela com ordenação por clique no cabeçalho (vira cards no celular)
  // U.tabela(el, { colunas: [{ campo, titulo, render?(linha), ordenavel? }], linhas, vazio })
  // ---------------------------------------------------------------------
  function tabela(el, { colunas, linhas, vazio = "Nada por aqui ainda.", limite = 500 }) {
    const estado = el._ordem || { campo: null, dir: "asc" };
    el._ordem = estado;
    const ordenada = estado.campo ? ordenarPor(linhas, estado.campo, estado.dir) : linhas;
    const lista = ordenada.slice(0, limite);
    const indice = new Map(linhas.map((l, i) => [l, i]));

    if (!lista.length) {
      el.innerHTML = `<div class="vazio" style="border:0;background:none;padding:40px 16px"><div class="vazio-emoji">🫙</div><p style="margin-bottom:0">${esc(vazio)}</p></div>`;
      return;
    }
    const cab = colunas.map((c) => {
      const ord = estado.campo === c.campo ? estado.dir : "";
      const clicavel = c.ordenavel !== false && c.campo;
      return `<th ${clicavel ? `data-campo="${esc(c.campo)}"` : 'style="cursor:default"'} ${ord ? `data-ordem="${ord}"` : ""}>${esc(c.titulo)}</th>`;
    }).join("");
    const corpo = lista.map((l, i) => `<tr data-i="${indice.get(l)}">${colunas.map((c) =>
      `<td data-label="${esc(c.titulo)}">${c.render ? c.render(l, i) : esc(l[c.campo] ?? "-")}</td>`).join("")}</tr>`).join("");
    const nota = ordenada.length > lista.length
      ? `<div class="muted pequeno" style="padding:12px 16px">Mostrando ${lista.length} de ${numero(ordenada.length)}. Use a busca pra achar o resto.</div>` : "";
    el.innerHTML = `<div style="overflow-x:auto"><table class="tabela"><thead><tr>${cab}</tr></thead><tbody>${corpo}</tbody></table></div>${nota}`;

    el.querySelectorAll("th[data-campo]").forEach((th) => th.addEventListener("click", () => {
      const campo = th.dataset.campo;
      estado.dir = estado.campo === campo && estado.dir === "asc" ? "desc" : "asc";
      estado.campo = campo;
      tabela(el, { colunas, linhas, vazio, limite });
    }));
  }

  // ---------------------------------------------------------------------
  // CSV (separador ; e BOM pro Excel em português abrir certinho)
  // ---------------------------------------------------------------------
  function baixarCSV(nomeArquivo, linhas, colunas) {
    const cel = (v) => {
      const s = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [colunas.map((c) => cel(c.titulo)).join(";")]
      .concat(linhas.map((l) => colunas.map((c) => cel(c.valor ? c.valor(l) : l[c.campo])).join(";")))
      .join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------------------------------------------------------------------
  // Horário de São Paulo <-> ISO (pra input datetime-local)
  // ---------------------------------------------------------------------
  const fmtPartes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  function partesSP(ts) {
    const p = Object.fromEntries(fmtPartes.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { Y: +p.year, M: +p.month, D: +p.day, h: +p.hour, m: +p.minute, s: +p.second };
  }
  function offsetSP(ts) {
    const p = partesSP(ts);
    return (Date.UTC(p.Y, p.M - 1, p.D, p.h, p.m, p.s) - Math.floor(ts / 1000) * 1000) / 60000;
  }
  /** "2026-09-26T14:30" (horário de SP) -> ISO UTC */
  function spParaISO(valor) {
    const [d, t] = String(valor).split("T");
    if (!d || !t) return null;
    const [Y, M, D] = d.split("-").map(Number);
    const [h, m] = t.split(":").map(Number);
    const comoUTC = Date.UTC(Y, M - 1, D, h, m);
    let ts = comoUTC - offsetSP(comoUTC) * 60000;
    ts = comoUTC - offsetSP(ts) * 60000;
    return new Date(ts).toISOString();
  }
  /** Agora (+ minutos) em SP, no formato do input datetime-local */
  function spInput(maisMinutos = 0) {
    const p = partesSP(Date.now() + maisMinutos * 60000);
    const z = (n) => String(n).padStart(2, "0");
    return `${p.Y}-${z(p.M)}-${z(p.D)}T${z(p.h)}:${z(p.m)}`;
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      toast("Copiado ✓");
    } catch {
      toast("Não consegui copiar. Selecione e copie na mão.", "aviso");
    }
  }

  /** Busca tudo de uma consulta, de 1000 em 1000 (limite padrão da API). */
  async function buscarTudo(montarConsulta, limite = 50000) {
    const tudo = [];
    for (let de = 0; de < limite; de += 1000) {
      const { data, error } = await montarConsulta().range(de, de + 999);
      if (error) throw error;
      tudo.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return tudo;
  }

  window.U = {
    FUSO, configFaltando, esc, dataHora, data, hora, numero, iniciais, guardar,
    toast, modal, confirmar, comCarregando, chamarFunction, ordenarPor, semAcento,
    tabela, baixarCSV, spParaISO, spInput, copiar, buscarTudo,
  };
})();
