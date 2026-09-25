// Aba ⚙️ Configurações: status das integrações + meus dados (tabela configuracoes).
(function () {
  "use strict";

  const CAMPOS = [
    "nome_exibicao", "instagram_usuario", "remetente_nome", "remetente_email",
    "reply_to", "email_teste", "ig_conta_teste",
  ];

  const STATUS = {
    configurado: { rotulo: "Configurado", classe: "badge-ok" },
    parcial: { rotulo: "Incompleto", classe: "badge-aviso" },
    vencendo: { rotulo: "Vence logo", classe: "badge-aviso" },
    vencido: { rotulo: "Vencido", classe: "badge-erro" },
    nao_configurado: { rotulo: "Não configurado", classe: "" },
  };

  // ---------------------------------------------------------------------
  // Integrações
  // ---------------------------------------------------------------------
  function cardIntegracao(it) {
    const st = STATUS[it.status] || STATUS.nao_configurado;
    const itens = it.itens.map((i) => `
      <li>
        <span aria-hidden="true">${i.ok ? "✅" : i.obrigatorio ? "⬜" : "▫️"}</span>
        <span>
          <code>${U.esc(i.nome)}</code>${i.obrigatorio ? "" : '<span class="opcional">opcional</span>'}
          <span class="dica">${U.esc(i.dica)}</span>
        </span>
      </li>`).join("");
    return `
      <div class="card card-integracao">
        <div class="card-integracao-topo">
          <div class="card-integracao-nome"><span class="emoji">${it.emoji}</span>${U.esc(it.nome)}</div>
          <span class="badge ${st.classe}">${st.rotulo}</span>
        </div>
        <div class="card-integracao-resumo">${U.esc(it.resumo)}</div>
        <ul class="lista-secrets">${itens}</ul>
        ${it.status === "nao_configurado" ? `<div class="muted pequeno">Entra em uso na FASE ${it.fase}.</div>` : ""}
      </div>`;
  }

  async function carregarStatus(btn) {
    const caixa = document.getElementById("cards-integracoes");
    const verificado = document.getElementById("verificado-em");
    await U.comCarregando(btn, async () => {
      try {
        const r = await U.chamarFunction("status-integracoes");
        caixa.innerHTML = r.integracoes.map(cardIntegracao).join("");
        verificado.textContent = `Verificado em ${U.dataHora(r.verificado_em)}.`;
      } catch (e) {
        verificado.textContent = "";
        caixa.innerHTML = `
          <div class="aviso erro" style="grid-column:1/-1">
            <span>⚠️</span>
            <span>
              <strong>Não consegui verificar as integrações.</strong><br>
              ${U.esc(e.message)}<br>
              <span class="muted pequeno">Publique a function com: <code>supabase functions deploy status-integracoes --project-ref SEU_REF</code></span>
            </span>
          </div>`;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Meus dados
  // ---------------------------------------------------------------------
  async function carregarConfig() {
    const { data, error } = await sb.from("configuracoes").select("chave, valor").in("chave", CAMPOS);
    if (error) {
      U.toast("Não consegui ler as configurações. Rodou o SQL da FASE 1?", "erro");
      return;
    }
    const mapa = Object.fromEntries((data || []).map((l) => [l.chave, l.valor]));
    CAMPOS.forEach((c) => {
      const el = document.getElementById("cfg-" + c);
      if (el) el.value = mapa[c] ?? "";
    });
  }

  async function salvarConfig(e) {
    e.preventDefault();
    const btn = document.getElementById("btn-salvar-config");
    const linhas = CAMPOS.map((c) => {
      let valor = document.getElementById("cfg-" + c).value.trim();
      if (c.includes("instagram") || c === "ig_conta_teste") valor = valor.replace(/^@/, "");
      if (c.includes("email") || c === "reply_to") valor = valor.toLowerCase();
      return { chave: c, valor };
    });

    const emailRuim = linhas.find((l) =>
      (l.chave.includes("email") || l.chave === "reply_to") && l.valor && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.valor));
    if (emailRuim) return U.toast(`O e-mail "${emailRuim.valor}" parece estar errado.`, "erro");

    const ig = linhas.find((l) => l.chave === "instagram_usuario").valor.toLowerCase();
    const teste = linhas.find((l) => l.chave === "ig_conta_teste").valor.toLowerCase();
    if (ig && teste && ig === teste) {
      U.toast("A conta de teste precisa ser diferente da sua. Salvei mesmo assim.", "aviso", 5000);
    }

    await U.comCarregando(btn, async () => {
      const { error } = await sb.from("configuracoes").upsert(linhas, { onConflict: "chave" });
      if (error) return U.toast("Não salvou: " + error.message, "erro");
      U.toast("Salvo ✓");
    });
  }

  window.ABAS = window.ABAS || {};
  window.ABAS.configuracoes = {
    iniciar() {
      document.getElementById("btn-verificar").addEventListener("click", (e) => carregarStatus(e.currentTarget));
      document.getElementById("form-config").addEventListener("submit", salvarConfig);
      document.getElementById("conta-email").textContent = PAINEL.usuario.email;
      carregarConfig();
      carregarStatus(document.getElementById("btn-verificar"));
    },
  };
})();
