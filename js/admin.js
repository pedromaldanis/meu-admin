// Painel: confere login, monta o roteador de abas e o menu.
// Cada aba se registra em window.ABAS[nome] = { iniciar(secao), mostrar(secao) }.
(function () {
  "use strict";

  window.ABAS = window.ABAS || {};
  const CHAVE_ABA = "admin:aba";
  const ABA_PADRAO = "disparo";
  const iniciadas = new Set();
  let saindo = false;

  window.PAINEL = { usuario: null, perfil: null, irPara };

  // ---------------------------------------------------------------------
  // Guarda de sessão: sem login, volta pro login.html
  // ---------------------------------------------------------------------
  async function conferirSessao() {
    if (U.configFaltando) {
      location.replace("login.html");
      return false;
    }
    const { data } = await sb.auth.getSession();
    const sessao = data.session;
    if (!sessao) {
      location.replace("login.html");
      return false;
    }
    const { data: perfil, error } = await sb
      .from("usuarios")
      .select("id, email, nome, role")
      .eq("id", sessao.user.id)
      .maybeSingle();
    if (error || perfil?.role !== "admin") {
      await sb.auth.signOut();
      location.replace("login.html?motivo=sem-acesso");
      return false;
    }
    PAINEL.usuario = sessao.user;
    PAINEL.perfil = perfil;
    return true;
  }

  function preencherUsuario() {
    const nome = PAINEL.perfil.nome || window.APP_CONFIG.NOME || PAINEL.usuario.email;
    document.getElementById("usuario-nome").textContent = nome;
    document.getElementById("usuario-email").textContent = PAINEL.usuario.email;
    document.getElementById("usuario-avatar").textContent = U.iniciais(nome);
    document.getElementById("topo-nome").textContent = nome.split(" ")[0];
  }

  // ---------------------------------------------------------------------
  // Roteador por data-tab
  // ---------------------------------------------------------------------
  function secaoDe(nome) {
    return document.querySelector(`.aba[data-aba="${nome}"]`);
  }

  function irPara(nome) {
    if (!secaoDe(nome)) nome = ABA_PADRAO;
    const secao = secaoDe(nome);

    document.querySelectorAll(".aba").forEach((s) => s.classList.toggle("ativa", s === secao));
    document.querySelectorAll(".menu button[data-tab]").forEach((b) => {
      const ativo = b.dataset.tab === nome;
      b.classList.toggle("ativo", ativo);
      if (ativo) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.getElementById("topo-titulo").textContent = secao.dataset.titulo || "";
    document.title = `${(secao.dataset.titulo || "Painel").replace(/^\S+\s/, "")} · Pedro Maldanis`;
    U.guardar.gravar(CHAVE_ABA, nome);
    document.body.classList.remove("menu-aberto");

    const aba = window.ABAS[nome];
    if (aba) {
      try {
        if (!iniciadas.has(nome)) {
          iniciadas.add(nome);
          if (aba.iniciar) aba.iniciar(secao);
        }
        if (aba.mostrar) aba.mostrar(secao);
      } catch (e) {
        console.error(e);
        U.toast("Algo deu errado ao abrir essa aba.", "erro");
      }
    }
    window.scrollTo({ top: 0 });
  }

  // ---------------------------------------------------------------------
  // Eventos globais
  // ---------------------------------------------------------------------
  function ligarEventos() {
    document.querySelectorAll(".menu button[data-tab]").forEach((b) =>
      b.addEventListener("click", () => irPara(b.dataset.tab)));

    document.addEventListener("click", (e) => {
      const emBreve = e.target.closest("[data-em-breve]");
      if (emBreve) U.toast(`Isso chega na FASE ${emBreve.dataset.emBreve} 🚀`, "aviso");
      const irAba = e.target.closest("[data-ir-aba]");
      if (irAba) irPara(irAba.dataset.irAba);
    });

    document.getElementById("btn-menu").addEventListener("click", () =>
      document.body.classList.toggle("menu-aberto"));
    document.getElementById("lateral-fundo").addEventListener("click", () =>
      document.body.classList.remove("menu-aberto"));

    document.getElementById("btn-sair").addEventListener("click", async () => {
      saindo = true;
      await sb.auth.signOut();
      location.replace("login.html?motivo=saiu");
    });

    // Sessão expirou ou saiu em outra aba do navegador
    sb.auth.onAuthStateChange((evento) => {
      if (evento === "SIGNED_OUT" && !saindo) location.replace("login.html");
    });
  }

  // ---------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------
  (async function iniciar() {
    if (!(await conferirSessao())) return;
    preencherUsuario();
    ligarEventos();
    document.body.classList.remove("carregando");
    irPara(U.guardar.ler(CHAVE_ABA, ABA_PADRAO));
  })();
})();
