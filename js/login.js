// Tela de login: e-mail e senha, sem cadastro público.
(function () {
  "use strict";

  const form = document.getElementById("form-login");
  const aviso = document.getElementById("aviso");
  const btn = document.getElementById("btn-entrar");

  function mostrarAviso(msg) {
    aviso.textContent = msg;
    aviso.classList.remove("oculto");
  }

  if (U.configFaltando) {
    mostrarAviso("Falta preencher js/config.js com a URL e a chave anon do Supabase.");
    btn.disabled = true;
    return;
  }

  // Mensagem vinda do admin (ex.: sem permissão)
  const motivo = new URLSearchParams(location.search).get("motivo");
  if (motivo === "sem-acesso") mostrarAviso("Seu usuário não tem acesso de admin.");
  if (motivo === "saiu") U.toast("Até logo 👋");

  // Já logado? Vai direto pro painel.
  sb.auth.getSession().then(({ data }) => {
    if (data.session && !motivo) location.replace("admin.html");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    aviso.classList.add("oculto");
    const email = document.getElementById("email").value.trim().toLowerCase();
    const senha = document.getElementById("senha").value;
    if (!email || !senha) return mostrarAviso("Preencha e-mail e senha.");

    await U.comCarregando(btn, async () => {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
      if (error) {
        const msg = /invalid login/i.test(error.message)
          ? "E-mail ou senha incorretos."
          : /email not confirmed/i.test(error.message)
            ? "E-mail ainda não confirmado. Confirme o usuário no painel do Supabase."
            : error.message;
        return mostrarAviso(msg);
      }

      const { data: perfil } = await sb.from("usuarios").select("role").eq("id", data.user.id).maybeSingle();
      if (perfil?.role !== "admin") {
        await sb.auth.signOut();
        return mostrarAviso("Seu usuário não tem acesso de admin. Rode o SQL do primeiro admin.");
      }
      location.replace("admin.html");
    });
  });
})();
