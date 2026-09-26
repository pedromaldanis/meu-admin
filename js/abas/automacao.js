// Aba 🤖 Automação do Instagram: lista, editor (gatilho, fluxo, prévia), leads, entregas, freio e mídia.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CHAVE_SUB = "admin:automacao:sub";
  const ROTULO_AUTO = "(mensagem automática 🤖)";
  const TIPOS = { comment: "💬 Comentário", dm: "✉️ DM", story_reply: "📖 Resposta a story" };

  let secao;
  let autos = [];
  let stats = new Map();
  let posts = null;          // cache do ig-media
  let postsErro = null;
  let assets = [];
  let leads = [];
  let entregas = [];

  // =====================================================================
  // Utilidades
  // =====================================================================
  const palavrasDe = (a) => String(a.keyword || "").split(",").map((p) => p.trim()).filter(Boolean);
  const postPorId = (id) => (posts || []).find((p) => p.id === id);
  const capaDe = (p) => p?.thumbnail_url || (p?.media_type !== "VIDEO" ? p?.media_url : null);
  const janelaAberta = (l) => l.last_inbound_at && Date.now() - new Date(l.last_inbound_at).getTime() < 24 * 3600e3;

  function novoIdPasso(steps) {
    const n = steps.reduce((m, s) => Math.max(m, parseInt(String(s.id).replace(/\D/g, ""), 10) || 0), 0);
    return "s" + (n + 1);
  }
  function passoVazio(steps) {
    return { id: novoIdPasso(steps), message: "", buttons: [], assets: [], delay: null, collect: null };
  }
  function resumoPasso(s, i) {
    const t = String(s.message || "").replace(/\s+/g, " ").trim();
    return `Passo ${i + 1}${t ? ": " + t.slice(0, 28) + (t.length > 28 ? "…" : "") : ""}`;
  }

  async function carregarPosts(forcar = false) {
    if (posts && !forcar) return posts;
    try {
      const r = await U.chamarFunction("ig-media", { acao: "posts" });
      posts = r.posts || [];
      postsErro = null;
    } catch (e) {
      posts = [];
      postsErro = e.message;
    }
    return posts;
  }

  // =====================================================================
  // Lista de automações
  // =====================================================================
  async function carregarAutos() {
    const [a, s] = await Promise.all([
      sb.from("ig_automations").select("*").order("created_at", { ascending: false }),
      sb.rpc("ig_automacao_stats"),
    ]);
    if (a.error) return U.toast("Erro ao ler automações: " + a.error.message, "erro");
    autos = a.data || [];
    stats = new Map((s.data || []).map((x) => [x.automation_id, x]));
    desenharLista();
    const sel = $("a-e-auto");
    const atual = sel.value;
    sel.innerHTML = '<option value="">Todas as automações</option>' + autos.map((x) => `<option value="${x.id}">${U.esc(x.nome)}</option>`).join("");
    sel.value = atual;
  }

  function desenharLista() {
    const el = $("a-lista");
    if (!autos.length) {
      el.innerHTML = `
        <div class="vazio" style="grid-column:1/-1">
          <div class="vazio-emoji">🤖</div>
          <h3>Nenhuma automação ainda.</h3>
          <p>Que tal criar a primeira? Ex.: quem comentar "QUERO" no seu próximo reel recebe o link na DM.</p>
          <button class="btn btn-primario" data-nova>➕ Criar automação</button>
        </div>`;
      return;
    }
    el.innerHTML = autos.map((a) => {
      const st = stats.get(a.id) || {};
      const p = a.media_ids?.length ? postPorId(a.media_ids[0]) : null;
      const capa = capaDe(p);
      const pal = palavrasDe(a);
      return `
        <div class="card auto-card">
          <div class="auto-capa">
            ${capa ? `<img src="${U.esc(capa)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : (a.trigger_type === "comment" ? "💬" : a.trigger_type === "dm" ? "✉️" : "📖")}
            <span class="badge ${a.active ? "badge-ok" : ""}">${a.active ? "Ativa" : "Pausada"}</span>
          </div>
          <div class="auto-corpo">
            <h3>${U.esc(a.nome)}</h3>
            <div class="muted pequeno">${TIPOS[a.trigger_type] || a.trigger_type} · ${a.media_ids?.length ? `${a.media_ids.length} post(s)` : "todos os posts"}</div>
            <div>${a.match_any ? '<span class="tag">qualquer texto</span>' : ""}${pal.map((k) => `<span class="tag">${U.esc(k)}</span>`).join("") || (a.match_any ? "" : '<span class="muted pequeno">sem palavra-chave</span>')}</div>
            <div class="auto-contadores">
              <span><strong>${U.numero(st.leads || 0)}</strong> leads</span>
              <span><strong>${U.numero(st.entregas_hoje || 0)}</strong> hoje</span>
              <span><strong>${U.numero(st.entregas_total || 0)}</strong> no total</span>
            </div>
          </div>
          <div class="auto-acoes">
            <label class="chave" title="Ativar ou pausar"><input type="checkbox" data-ativar="${a.id}" ${a.active ? "checked" : ""}><span class="trilho"></span></label>
            <button class="btn btn-secundario btn-p" data-editar="${a.id}">✏️ Editar</button>
            <button class="btn btn-fantasma btn-p" data-duplicar="${a.id}">📄 Duplicar</button>
            <button class="btn btn-fantasma btn-p" data-testar="${a.id}">🧪 Testar</button>
            <button class="btn btn-fantasma btn-p" data-apagar="${a.id}" title="Apagar">🗑️</button>
          </div>
        </div>`;
    }).join("");
  }

  async function ativar(id, ligado, input) {
    const { error } = await sb.from("ig_automations").update({ active: ligado }).eq("id", id);
    if (error) { input.checked = !ligado; return U.toast(error.message, "erro"); }
    const a = autos.find((x) => x.id === id);
    if (a) a.active = ligado;
    desenharLista();
    carregarNumeros();
    U.toast(ligado ? "Ativada ✓" : "Pausada ⏸️");
  }

  async function duplicar(id) {
    const a = autos.find((x) => x.id === id);
    if (!a) return;
    const { id: _i, created_at: _c, updated_at: _u, ...copia } = a;
    const { error } = await sb.from("ig_automations").insert({ ...copia, nome: a.nome + " (cópia)", active: false });
    if (error) return U.toast(error.message, "erro");
    U.toast("Duplicada ✓ (começa pausada)");
    carregarAutos();
  }

  async function apagar(id) {
    const a = autos.find((x) => x.id === id);
    if (!(await U.confirmar(`Apagar "${a?.nome}"? Os leads continuam, só a automação some.`, { perigo: true, ok: "Apagar" }))) return;
    const { error } = await sb.from("ig_automations").delete().eq("id", id);
    if (error) return U.toast(error.message, "erro");
    U.toast("Apagada ✓");
    carregarAutos();
  }

  async function testar(id, btn) {
    await U.comCarregando(btn, async () => {
      try {
        const r = await U.chamarFunction("ig-test-send", { automation_id: id });
        U.toast(`🧪 Passo 1 enviado pra @${r.para} ✓`);
      } catch (e) {
        U.toast(e.message, "erro", 8000);
      }
    });
  }

  // =====================================================================
  // Editor
  // =====================================================================
  let ed = null;       // automação em edição (cópia)
  let edEl = null;
  let edFoto = "";     // retrato do que está salvo, pra saber se tem mudança

  function abrirEditor(id) {
    const base = id ? autos.find((x) => x.id === id) : null;
    ed = base ? JSON.parse(JSON.stringify(base)) : {
      nome: "", active: false, trigger_type: "comment", keyword: "", match_any: false, media_ids: [],
      public_reply: "", public_reply_variants: [], ask_message: "", ask_button: "",
      flow: { steps: [] },
    };
    if (!ed.flow?.steps) ed.flow = { steps: [] };
    if (!ed.flow.steps.length) ed.flow.steps.push({ id: "s1", message: "", buttons: [], assets: [], delay: null, collect: null });

    edEl = document.createElement("div");
    edEl.className = "editor";
    edEl.innerHTML = `
      <div class="editor-topo">
        <button class="btn btn-fantasma btn-p" data-fechar>← Voltar</button>
        <input class="input" id="ed-nome" placeholder="Nome da automação (ex.: Reel do guia grátis)" maxlength="80" value="${U.esc(ed.nome)}">
        <label class="chave"><input type="checkbox" id="ed-ativa" ${ed.active ? "checked" : ""}><span class="trilho"></span> Ativa</label>
        <div style="flex:1"></div>
        <button class="btn btn-primario" data-salvar>💾 Salvar</button>
      </div>
      <div class="editor-colunas">
        <div class="ed-col" id="ed-gatilho"></div>
        <div class="ed-col" id="ed-fluxo"></div>
        <div class="ed-col col-previa" id="ed-previa"></div>
      </div>`;
    document.body.appendChild(edEl);
    document.body.style.overflow = "hidden";

    edEl.querySelector("[data-fechar]").addEventListener("click", fecharEditor);
    edEl.querySelector("[data-salvar]").addEventListener("click", (e) => salvarEditor(e.currentTarget));
    $("ed-nome").addEventListener("input", (e) => { ed.nome = e.target.value; });
    $("ed-ativa").addEventListener("change", (e) => { ed.active = e.target.checked; });

    desenharGatilho();
    desenharFluxo();
    reiniciarSimulacao();
    if (ed.trigger_type === "comment") carregarPosts().then(desenharPosts);
    edFoto = JSON.stringify(ed);
  }

  async function fecharEditor() {
    if (JSON.stringify(ed) !== edFoto &&
        !(await U.confirmar("As mudanças que não foram salvas se perdem.", { titulo: "Sair do editor?", ok: "Sair" }))) return;
    edEl.remove();
    edEl = null;
    ed = null;
    document.body.style.overflow = "";
  }

  // ---------------- Coluna 1: Gatilho ----------------
  function desenharGatilho() {
    const col = $("ed-gatilho");
    const variantes = [ed.public_reply || "", ...(ed.public_reply_variants || [])];
    if (!variantes.length) variantes.push("");
    col.innerHTML = `
      <h2>1 · Gatilho</h2>
      <div class="ed-bloco">
        <div class="campo">
          <label for="ed-tipo">Quando alguém...</label>
          <select class="select" id="ed-tipo">
            <option value="comment" ${ed.trigger_type === "comment" ? "selected" : ""}>💬 Comentar num post</option>
            <option value="dm" ${ed.trigger_type === "dm" ? "selected" : ""}>✉️ Mandar DM</option>
            <option value="story_reply" ${ed.trigger_type === "story_reply" ? "selected" : ""}>📖 Responder um story</option>
          </select>
        </div>
        <div class="campo">
          <label>...com a palavra</label>
          <div class="chips-input" id="ed-palavras">
            ${palavrasDe(ed).map((p, i) => `<span class="chip-x">${U.esc(p)}<button data-tirar-palavra="${i}" aria-label="Tirar">×</button></span>`).join("")}
            <input id="ed-palavra-nova" placeholder="Digite e aperte Enter">
          </div>
          <span class="ajuda">Não importa maiúscula nem acento: "Quero", "QUERO" e "quéro" batem igual.</span>
        </div>
        <label class="check"><input type="checkbox" id="ed-qualquer" ${ed.match_any ? "checked" : ""}> Qualquer ${ed.trigger_type === "comment" ? "comentário" : "mensagem"} (sem palavra-chave)</label>
      </div>

      ${ed.trigger_type === "comment" ? `
      <div class="ed-bloco">
        <div class="linha" style="justify-content:space-between">
          <strong class="pequeno">📸 Em quais posts</strong>
          <label class="check pequeno"><input type="checkbox" id="ed-todos-posts" ${!ed.media_ids.length ? "checked" : ""}> Todos</label>
        </div>
        <div id="ed-posts-caixa" class="${!ed.media_ids.length ? "oculto" : ""}">
          <input class="input" id="ed-posts-busca" placeholder="🔎 Buscar pela legenda" style="margin-bottom:8px">
          <div class="posts-grade" id="ed-posts"><div class="muted pequeno">Carregando posts...</div></div>
        </div>
      </div>

      <div class="ed-bloco">
        <strong class="pequeno">💬 Resposta pública no comentário (opcional)</strong>
        <div id="ed-variantes" style="display:grid;gap:6px">
          ${variantes.map((v, i) => `
            <div class="linha" style="flex-wrap:nowrap">
              <input class="input" data-variante="${i}" value="${U.esc(v)}" placeholder="${i === 0 ? "Te mandei na DM! 📩" : "Outra versão (sorteada)"}" maxlength="300">
              ${i > 0 ? `<button class="btn btn-fantasma btn-p" data-tirar-variante="${i}">×</button>` : ""}
            </div>`).join("")}
        </div>
        <button class="btn btn-fantasma btn-p" id="ed-add-variante" style="justify-self:start">➕ Outra versão</button>
        <span class="ajuda">Várias versões são sorteadas: responder sempre igual parece robô e aumenta denúncia.</span>
      </div>

      <div class="ed-bloco">
        <strong class="pequeno">🎁 Convite com botão (opcional, recomendado)</strong>
        <span class="ajuda" style="margin-top:-6px">Em vez de mandar o link direto, manda um convite. O link só vai quando a pessoa toca no botão. Parece menos spam e abre a janela de 24h.</span>
        <textarea class="textarea" id="ed-ask" style="min-height:80px" maxlength="600" placeholder="Oi! Vi seu comentário 😊 Quer que eu te mande o link?">${U.esc(ed.ask_message || "")}</textarea>
        <input class="input" id="ed-ask-botao" maxlength="20" placeholder="Texto do botão (ex.: Quero! 👉)" value="${U.esc(ed.ask_button || "")}">
      </div>` : `
      <div class="aviso info"><span>💡</span><span>DMs abrem a janela de 24h: dá pra mandar arquivos e passos com atraso direto.</span></div>`}
    `;

    $("ed-tipo").addEventListener("change", (e) => {
      ed.trigger_type = e.target.value;
      desenharGatilho();
      reiniciarSimulacao();
      if (ed.trigger_type === "comment") carregarPosts().then(desenharPosts);
    });
    $("ed-palavra-nova").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== ",") return;
      e.preventDefault();
      const v = e.target.value.replace(/,/g, " ").trim();
      if (!v) return;
      const lista = palavrasDe(ed);
      if (!lista.some((x) => U.semAcento(x) === U.semAcento(v))) lista.push(v);
      ed.keyword = lista.join(", ");
      desenharGatilho();
      $("ed-palavra-nova").focus();
      reiniciarSimulacao();
    });
    col.querySelectorAll("[data-tirar-palavra]").forEach((b) => b.addEventListener("click", () => {
      const lista = palavrasDe(ed);
      lista.splice(+b.dataset.tirarPalavra, 1);
      ed.keyword = lista.join(", ");
      desenharGatilho();
      reiniciarSimulacao();
    }));
    $("ed-qualquer").addEventListener("change", (e) => { ed.match_any = e.target.checked; });

    if (ed.trigger_type !== "comment") return;
    $("ed-todos-posts").addEventListener("change", (e) => {
      if (e.target.checked) ed.media_ids = [];
      $("ed-posts-caixa").classList.toggle("oculto", e.target.checked);
      desenharPosts();
    });
    $("ed-posts-busca").addEventListener("input", desenharPosts);
    const lerVariantes = () => {
      const vs = [...col.querySelectorAll("[data-variante]")].map((i) => i.value);
      ed.public_reply = vs[0] || "";
      ed.public_reply_variants = vs.slice(1);
    };
    col.querySelectorAll("[data-variante]").forEach((i) => i.addEventListener("input", () => { lerVariantes(); agendarSimulacao(); }));
    $("ed-add-variante").addEventListener("click", () => {
      lerVariantes();
      ed.public_reply_variants.push(" ");
      desenharGatilho();
    });
    col.querySelectorAll("[data-tirar-variante]").forEach((b) => b.addEventListener("click", () => {
      lerVariantes();
      ed.public_reply_variants.splice(+b.dataset.tirarVariante - 1, 1);
      desenharGatilho();
    }));
    $("ed-ask").addEventListener("input", (e) => { ed.ask_message = e.target.value; agendarSimulacao(); });
    $("ed-ask-botao").addEventListener("input", (e) => { ed.ask_button = e.target.value; agendarSimulacao(); });
    if (posts) desenharPosts();
  }

  function desenharPosts() {
    const el = $("ed-posts");
    if (!el) return;
    if (postsErro) {
      el.innerHTML = `<div class="muted pequeno" style="grid-column:1/-1">Não consegui listar seus posts: ${U.esc(postsErro)}<br>Conecte o Instagram em ⚙️ Configurações. Enquanto isso, deixe "Todos".</div>`;
      return;
    }
    if (!posts) return;
    const busca = U.semAcento($("ed-posts-busca")?.value || "");
    const lista = posts.filter((p) => !busca || U.semAcento(p.caption || "").includes(busca));
    el.innerHTML = lista.map((p) => `
      <button type="button" class="post-mini ${ed.media_ids.includes(p.id) ? "sel" : ""}" data-post="${p.id}" title="${U.esc((p.caption || "").slice(0, 120))}">
        ${capaDe(p) ? `<img src="${U.esc(capaDe(p))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "🎞️"}
      </button>`).join("") || '<div class="muted pequeno">Nenhum post com essa busca.</div>';
    el.querySelectorAll("[data-post]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.post;
      ed.media_ids = ed.media_ids.includes(id) ? ed.media_ids.filter((x) => x !== id) : [...ed.media_ids, id];
      b.classList.toggle("sel");
      $("ed-todos-posts").checked = !ed.media_ids.length;
    }));
  }

  // ---------------- Coluna 2: Fluxo ----------------
  function referenciados() {
    const r = new Set();
    for (const s of ed.flow.steps) {
      (s.buttons || []).forEach((b) => b.next && r.add(b.next));
      if (s.delay?.next) r.add(s.delay.next);
      if (s.collect?.next) r.add(s.collect.next);
    }
    return r;
  }

  function opcoesPassos(atual, excetoId, rotuloVazio = "Escolha o passo") {
    return `<option value="">${rotuloVazio}</option>` + ed.flow.steps.filter((s) => s.id !== excetoId)
      .map((s) => `<option value="${s.id}" ${atual === s.id ? "selected" : ""}>➡️ ${U.esc(resumoPasso(s, ed.flow.steps.indexOf(s)))}</option>`).join("") +
      '<option value="__novo">✨ Criar passo novo</option>';
  }

  function desenharFluxo() {
    const col = $("ed-fluxo");
    const refs = referenciados();
    col.innerHTML = `<h2>2 · Fluxo da conversa</h2>` + ed.flow.steps.map((s, i) => {
      const solto = i > 0 && !refs.has(s.id);
      const botoes = s.buttons || [];
      const limite = botoes.length ? 640 : 1000;
      const tam = (s.message || "").length;
      return `
        <div class="passo ${solto ? "solto" : ""}" data-passo="${s.id}">
          <div class="passo-cab">
            <strong>${i === 0 ? "🚀 Passo 1 (primeira mensagem)" : `Passo ${i + 1}`} <span class="passo-id">${s.id}</span></strong>
            ${i > 0 ? `<button class="btn btn-fantasma btn-p" data-tirar-passo="${s.id}" title="Apagar passo">🗑️</button>` : ""}
          </div>
          ${solto ? '<div class="alerta-mini">⚠️ Passo solto: nenhum botão, atraso ou captura leva até aqui.</div>' : ""}
          <textarea class="textarea" data-campo="message" style="min-height:90px" placeholder="${i === 0 ? "Aqui está o link que te prometi: ..." : "Mensagem deste passo"}">${U.esc(s.message || "")}</textarea>
          <div class="contador ${tam > limite ? "estourou" : ""}">${tam}/${limite}${botoes.length ? " (com botões)" : ""}</div>

          <div style="display:grid;gap:6px">
            ${botoes.map((b, k) => `
              <div class="botao-linha" data-botao="${k}">
                <input class="input" data-bcampo="title" maxlength="20" placeholder="Texto do botão" value="${U.esc(b.title || "")}">
                <select class="select" data-bcampo="destino">
                  <option value="__link" ${b.url != null ? "selected" : ""}>🔗 Abrir link</option>
                  ${opcoesPassos(b.url == null ? b.next : null, s.id)}
                </select>
                <button class="btn btn-fantasma btn-p" data-tirar-botao="${k}">×</button>
                ${b.url != null ? `<input class="input" data-bcampo="url" style="grid-column:1/-1" placeholder="https://..." value="${U.esc(b.url || "")}">
                  ${b.url && !/^https:\/\//i.test(b.url) ? '<div class="alerta-mini" style="grid-column:1/-1">⚠️ O link precisa começar com https://</div>' : ""}` : ""}
              </div>`).join("")}
            ${botoes.length < 3 ? '<button class="btn btn-fantasma btn-p" data-add-botao style="justify-self:start">➕ Botão</button>' : '<span class="muted pequeno">Máximo de 3 botões.</span>'}
          </div>

          <div class="passo-extra">
            <div class="linha" style="flex-wrap:wrap">
              ${(s.assets || []).map((u, k) => `<span class="chip-x">📎 ${U.esc(nomeAsset(u))}<button data-tirar-asset="${k}">×</button></span>`).join("")}
              <button class="btn btn-fantasma btn-p" data-add-asset>📎 Arquivo</button>
            </div>
            ${i === 0 && ed.trigger_type === "comment" && !ed.ask_message && (s.assets || []).length ? '<div class="alerta-mini">⚠️ Resposta a comentário é 1 mensagem só: os arquivos do passo 1 não vão. Use o convite com botão ou coloque os arquivos no passo 2.</div>' : ""}
            <label class="check pequeno"><input type="checkbox" data-toggle="delay" ${s.delay ? "checked" : ""}> ⏱️ Depois de um tempo, mandar outro passo</label>
            ${s.delay ? `
              <div class="linha" style="flex-wrap:nowrap">
                <input class="input" type="number" min="1" data-dcampo="value" value="${s.delay.value || 1}" style="max-width:80px">
                <select class="select" data-dcampo="unit" style="max-width:110px">
                  <option value="min" ${s.delay.unit === "min" ? "selected" : ""}>minutos</option>
                  <option value="h" ${s.delay.unit === "h" ? "selected" : ""}>horas</option>
                </select>
                <select class="select" data-dcampo="next">${opcoesPassos(s.delay.next, s.id)}</select>
              </div>
              <span class="ajuda">Só sai se a janela de 24h ainda estiver aberta.</span>` : ""}
            <div class="linha" style="flex-wrap:nowrap">
              <select class="select" data-ccampo="field" style="max-width:190px">
                <option value="">Não coletar nada</option>
                <option value="email" ${s.collect?.field === "email" ? "selected" : ""}>📧 Coletar e-mail</option>
                <option value="telefone" ${s.collect?.field === "telefone" ? "selected" : ""}>📱 Coletar telefone</option>
              </select>
              ${s.collect ? `<select class="select" data-ccampo="next">${opcoesPassos(s.collect.next, s.id, "Depois: só agradecer")}</select>` : ""}
            </div>
          </div>
        </div>`;
    }).join("") + `<button class="btn btn-secundario" data-add-passo>➕ Adicionar passo</button>`;

    ligarFluxo(col);
  }

  function nomeAsset(url) {
    const a = assets.find((x) => x.url === url);
    return a ? a.nome : decodeURIComponent(url.split("/").pop() || "arquivo").slice(0, 24);
  }

  function criarPassoNovo() {
    const s = passoVazio(ed.flow.steps);
    ed.flow.steps.push(s);
    return s.id;
  }

  function ligarFluxo(col) {
    const passo = (el) => ed.flow.steps.find((s) => s.id === el.closest("[data-passo]").dataset.passo);

    col.querySelectorAll('[data-campo="message"]').forEach((t) => t.addEventListener("input", () => {
      const s = passo(t);
      s.message = t.value;
      const lim = (s.buttons || []).length ? 640 : 1000;
      const c = t.nextElementSibling;
      c.textContent = `${t.value.length}/${lim}${(s.buttons || []).length ? " (com botões)" : ""}`;
      c.classList.toggle("estourou", t.value.length > lim);
      agendarSimulacao();
    }));

    col.querySelectorAll("[data-botao]").forEach((linha) => {
      const k = +linha.dataset.botao;
      linha.querySelectorAll("[data-bcampo]").forEach((c) => c.addEventListener(c.tagName === "SELECT" ? "change" : "input", () => {
        const s = passo(linha);
        const b = s.buttons[k];
        if (c.dataset.bcampo === "title") { b.title = c.value; agendarSimulacao(); return; }
        if (c.dataset.bcampo === "url") { b.url = c.value.trim(); agendarSimulacao(); return; }
        // destino
        if (c.value === "__link") { b.url = b.url || ""; delete b.next; }
        else if (c.value === "__novo") { delete b.url; b.next = criarPassoNovo(); }
        else { delete b.url; b.next = c.value || undefined; }
        desenharFluxo();
        reiniciarSimulacao();
      }));
    });

    col.querySelectorAll("[data-add-botao]").forEach((b) => b.addEventListener("click", () => {
      const s = passo(b);
      s.buttons = s.buttons || [];
      s.buttons.push({ title: "", url: "" });
      desenharFluxo();
    }));
    col.querySelectorAll("[data-tirar-botao]").forEach((b) => b.addEventListener("click", () => {
      passo(b).buttons.splice(+b.dataset.tirarBotao, 1);
      desenharFluxo();
      reiniciarSimulacao();
    }));

    col.querySelectorAll('[data-toggle="delay"]').forEach((c) => c.addEventListener("change", () => {
      const s = passo(c);
      s.delay = c.checked ? { value: 2, unit: "min", next: "" } : null;
      desenharFluxo();
    }));
    col.querySelectorAll("[data-dcampo]").forEach((c) => c.addEventListener("change", () => {
      const s = passo(c);
      if (c.dataset.dcampo === "value") s.delay.value = Math.max(1, +c.value || 1);
      else if (c.dataset.dcampo === "unit") s.delay.unit = c.value;
      else s.delay.next = c.value === "__novo" ? criarPassoNovo() : c.value;
      desenharFluxo();
      reiniciarSimulacao();
    }));
    col.querySelectorAll("[data-ccampo]").forEach((c) => c.addEventListener("change", () => {
      const s = passo(c);
      if (c.dataset.ccampo === "field") s.collect = c.value ? { field: c.value, next: s.collect?.next || "" } : null;
      else s.collect.next = c.value === "__novo" ? criarPassoNovo() : c.value;
      desenharFluxo();
      reiniciarSimulacao();
    }));

    col.querySelectorAll("[data-add-asset]").forEach((b) => b.addEventListener("click", () => escolherAsset(passo(b))));
    col.querySelectorAll("[data-tirar-asset]").forEach((b) => b.addEventListener("click", () => {
      passo(b).assets.splice(+b.dataset.tirarAsset, 1);
      desenharFluxo();
      reiniciarSimulacao();
    }));

    col.querySelectorAll("[data-tirar-passo]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.tirarPasso;
      if (!(await U.confirmar("Botões que apontam pra ele ficam sem destino.", { titulo: "Apagar este passo?", perigo: true, ok: "Apagar" }))) return;
      ed.flow.steps = ed.flow.steps.filter((s) => s.id !== id);
      for (const s of ed.flow.steps) {
        (s.buttons || []).forEach((x) => { if (x.next === id) x.next = ""; });
        if (s.delay?.next === id) s.delay.next = "";
        if (s.collect?.next === id) s.collect.next = "";
      }
      desenharFluxo();
      reiniciarSimulacao();
    }));

    col.querySelector("[data-add-passo]").addEventListener("click", () => {
      criarPassoNovo();
      desenharFluxo();
      col.scrollTop = col.scrollHeight;
    });
  }

  async function escolherAsset(passo) {
    await carregarAssets();
    if (!assets.length) {
      return U.toast("Nenhum arquivo ainda. Envie na sub-aba 🖼️ Mídia.", "aviso", 5000);
    }
    const m = U.modal({
      titulo: "📎 Escolher arquivo",
      html: `<div style="display:grid;gap:8px">${assets.map((a) => `
        <label class="check"><input type="checkbox" value="${U.esc(a.url)}" ${(passo.assets || []).includes(a.url) ? "checked" : ""}>
          ${{ image: "🖼️", audio: "🎧", video: "🎬", file: "📄" }[a.tipo] || "📎"} ${U.esc(a.nome)}</label>`).join("")}</div>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "Usar", classe: "btn-primario", acao: (fechar) => {
          passo.assets = [...m.el.querySelectorAll("input:checked")].map((i) => i.value);
          fechar();
          desenharFluxo();
          reiniciarSimulacao();
        } },
      ],
    });
  }

  // ---------------- Coluna 3: Prévia / simulação ----------------
  let sim = null;
  let timerSim = null;

  function agendarSimulacao() {
    clearTimeout(timerSim);
    timerSim = setTimeout(reiniciarSimulacao, 400);
  }

  function reiniciarSimulacao() {
    if (!ed) return;
    sim = { msgs: [], esperando: null, botsEnviados: 0 };
    const pal = palavrasDe(ed)[0] || (ed.match_any ? "Amei!" : "QUERO");
    if (ed.trigger_type === "comment") {
      sim.msgs.push({ tipo: "comentario", texto: pal });
      const pub = ed.public_reply?.trim();
      if (pub) sim.msgs.push({ tipo: "nota", texto: `💬 Resposta pública: "${pub}"` });
      if (ed.ask_message?.trim()) {
        sim.msgs.push({ tipo: "bot", texto: ed.ask_message.trim() + "\n\n" + ROTULO_AUTO,
          botoes: [{ title: ed.ask_button?.trim() || "Quero! 👉", acao: "link" }] });
        sim.botsEnviados++;
      } else {
        simPasso(ed.flow.steps[0]?.id);
      }
    } else {
      sim.msgs.push({ tipo: "eu", texto: ed.trigger_type === "story_reply" ? `↩️ (respondeu seu story) ${pal}` : pal });
      simPasso(ed.flow.steps[0]?.id);
    }
    desenharPrevia();
  }

  function simPasso(id, profundidade = 0) {
    const s = ed.flow.steps.find((x) => x.id === id);
    if (!s || profundidade > 10 || sim.msgs.length > 60) return;
    const primeira = sim.botsEnviados === 0;
    const texto = (s.message || "").trim() + (primeira ? (s.message?.trim() ? "\n\n" : "") + ROTULO_AUTO : "");
    const botoes = (s.buttons || []).filter((b) => b.title?.trim()).map((b) => b.url != null
      ? { title: b.title, acao: "url", url: b.url } : { title: b.title, acao: "passo", next: b.next });
    sim.msgs.push({ tipo: "bot", texto: texto || "(passo sem texto)", botoes });
    sim.botsEnviados++;
    for (const u of s.assets || []) sim.msgs.push({ tipo: "bot", texto: "📎 " + nomeAsset(u) });
    if (s.collect?.field) {
      sim.esperando = { field: s.collect.field, next: s.collect.next };
    }
    if (s.delay?.next) {
      sim.msgs.push({ tipo: "nota", texto: `⏱️ ${s.delay.value} ${s.delay.unit === "h" ? "hora(s)" : "min"} depois...` });
      simPasso(s.delay.next, profundidade + 1);
    }
  }

  function desenharPrevia() {
    const col = $("ed-previa");
    if (!col) return;
    col.innerHTML = `
      <div class="linha" style="justify-content:space-between">
        <h2 style="position:static;padding:0">3 · Prévia</h2>
        <button class="btn btn-fantasma btn-p" id="sim-reiniciar">🔄 Recomeçar</button>
      </div>
      <p class="muted pequeno" style="margin-top:-6px">Modo simular: toque nos botões pra navegar no fluxo de verdade.</p>
      <div class="celular"><div class="celular-tela">
        <div class="celular-cab"><span class="avatar">PM</span> pedromaldanis</div>
        <div class="celular-msgs" id="sim-msgs">
          ${sim.msgs.map((m, i) => {
            if (m.tipo === "comentario") return `<div class="comentario-sim">💬 <b>@seguidor</b> comentou no seu post:<br>"${U.esc(m.texto)}"</div>`;
            if (m.tipo === "nota") return `<div class="nota-sim">${U.esc(m.texto)}</div>`;
            const bolha = `<div class="bolha ${m.tipo === "eu" ? "eu" : "bot"}">${U.esc(m.texto)}</div>`;
            if (!m.botoes?.length) return bolha;
            return bolha + `<div class="bolha-botoes">${m.botoes.map((b, k) =>
              `<button data-sim="${i}:${k}" ${m.usado ? "disabled" : ""}>${b.acao === "url" ? "🔗 " : ""}${U.esc(b.title)}</button>`).join("")}</div>`;
          }).join("")}
        </div>
        ${sim.esperando ? `
          <form class="celular-entrada" id="sim-form">
            <input id="sim-input" placeholder="${sim.esperando.field === "email" ? "Digite um e-mail" : "Digite um telefone"}">
            <button>➤</button>
          </form>` : ""}
      </div></div>`;
    const msgs = $("sim-msgs");
    msgs.scrollTop = msgs.scrollHeight;

    $("sim-reiniciar").addEventListener("click", reiniciarSimulacao);
    col.querySelectorAll("[data-sim]").forEach((b) => b.addEventListener("click", () => {
      const [i, k] = b.dataset.sim.split(":").map(Number);
      const m = sim.msgs[i];
      const bt = m.botoes[k];
      if (bt.acao === "url") {
        sim.msgs.push({ tipo: "nota", texto: /^https:\/\//i.test(bt.url || "") ? `🔗 Abre ${bt.url}` : "⚠️ Link vazio ou sem https://" });
      } else {
        m.usado = true;
        sim.msgs.push({ tipo: "eu", texto: bt.title });
        if (bt.acao === "link") simPasso(ed.flow.steps[0]?.id);
        else if (bt.next) simPasso(bt.next);
        else sim.msgs.push({ tipo: "nota", texto: "⚠️ Esse botão não leva a nenhum passo" });
      }
      desenharPrevia();
    }));
    const form = $("sim-form");
    if (form) form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("sim-input").value.trim();
      if (!v) return;
      sim.msgs.push({ tipo: "eu", texto: v });
      const esp = sim.esperando;
      const ok = esp.field === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) : v.replace(/\D/g, "").length >= 10;
      if (!ok) {
        sim.msgs.push({ tipo: "bot", texto: esp.field === "email" ? "Hmm, esse e-mail parece incompleto 🤔 Pode mandar de novo?" : "Hmm, não entendi o número 🤔 Pode mandar com DDD?" });
      } else {
        sim.esperando = null;
        sim.msgs.push({ tipo: "nota", texto: `✅ ${esp.field === "email" ? "E-mail" : "Telefone"} salvo no lead` });
        if (esp.next) simPasso(esp.next); else sim.msgs.push({ tipo: "bot", texto: "Anotado ✅ Obrigado!" });
      }
      desenharPrevia();
      $("sim-input")?.focus();
    });
  }

  // ---------------- Salvar ----------------
  function validar() {
    const erros = [];
    if (!ed.nome.trim()) erros.push("Dê um nome pra automação.");
    if (!palavrasDe(ed).length && !ed.match_any) erros.push('Coloque pelo menos uma palavra-chave (ou marque "qualquer").');
    const s1 = ed.flow.steps[0];
    if (!s1 || (!s1.message?.trim() && !(s1.buttons || []).length)) erros.push("O passo 1 precisa de uma mensagem.");
    ed.flow.steps.forEach((s, i) => {
      const lim = (s.buttons || []).length ? 640 : 1000;
      if ((s.message || "").length > lim) erros.push(`Passo ${i + 1}: texto passou de ${lim} caracteres.`);
      (s.buttons || []).forEach((b, k) => {
        if (!b.title?.trim()) erros.push(`Passo ${i + 1}, botão ${k + 1}: falta o texto.`);
        if (b.url != null && !/^https:\/\//i.test(b.url)) erros.push(`Passo ${i + 1}, botão ${k + 1}: o link precisa começar com https://`);
        if (b.url == null && !b.next) erros.push(`Passo ${i + 1}, botão ${k + 1}: escolha pra qual passo ele leva.`);
      });
      if (s.delay && !s.delay.next) erros.push(`Passo ${i + 1}: escolha o passo que vai depois do atraso.`);
    });
    if (ed.ask_message?.trim() && !ed.ask_button?.trim()) ed.ask_button = "Quero! 👉";
    return erros;
  }

  async function salvarEditor(btn) {
    ed.nome = $("ed-nome").value.trim();
    const erros = validar();
    if (erros.length) {
      return U.modal({ titulo: "Falta pouco 🙂", html: `<ul style="margin:0;padding-left:18px;display:grid;gap:6px">${erros.map((e) => `<li>${U.esc(e)}</li>`).join("")}</ul>`,
        botoes: [{ texto: "Entendi", classe: "btn-primario" }] });
    }
    const dados = {
      nome: ed.nome, active: ed.active, trigger_type: ed.trigger_type,
      keyword: palavrasDe(ed).join(", ") || null, match_any: ed.match_any, media_ids: ed.media_ids || [],
      public_reply: ed.public_reply?.trim() || null,
      public_reply_variants: (ed.public_reply_variants || []).map((v) => v.trim()).filter(Boolean),
      ask_message: ed.ask_message?.trim() || null, ask_button: ed.ask_button?.trim() || null,
      flow: ed.flow,
    };
    await U.comCarregando(btn, async () => {
      const { data, error } = ed.id
        ? await sb.from("ig_automations").update(dados).eq("id", ed.id).select("id").single()
        : await sb.from("ig_automations").insert(dados).select("id").single();
      if (error) return U.toast("Não salvou: " + error.message, "erro", 6000);
      ed.id = data.id;
      edFoto = JSON.stringify(ed);
      U.toast("Salvo ✓");
      carregarAutos();
      carregarNumeros();
    });
  }

  // =====================================================================
  // Leads
  // =====================================================================
  async function carregarLeads() {
    try {
      leads = await U.buscarTudo(() => sb.from("ig_leads").select("*").order("updated_at", { ascending: false }), 20000);
    } catch (e) {
      return U.toast("Erro ao ler leads: " + e.message, "erro");
    }
    desenharLeads();
  }

  function desenharLeads() {
    const busca = U.semAcento($("a-l-busca").value.trim()).replace(/^@/, "");
    const origem = $("a-l-origem").value;
    const filtro = $("a-l-filtro").value;
    const nomeAuto = new Map(autos.map((a) => [a.id, a.nome]));
    const linhas = leads.filter((l) => {
      if (busca && !U.semAcento(`${l.username || ""} ${l.last_keyword || ""} ${l.last_text || ""} ${l.email || ""}`).includes(busca)) return false;
      if (origem && l.last_source !== origem) return false;
      if (filtro === "janela" && !janelaAberta(l)) return false;
      if (filtro === "email" && !l.email) return false;
      return true;
    });
    U.tabela($("a-l-tabela"), {
      linhas, limite: 300,
      vazio: leads.length ? "Ninguém com esse filtro." : "Nenhum lead ainda. Assim que alguém comentar a palavra-chave, aparece aqui.",
      colunas: [
        { campo: "username", titulo: "Perfil", render: (l) => l.username
          ? `<a href="https://instagram.com/${encodeURIComponent(l.username)}" target="_blank" rel="noopener">@${U.esc(l.username)}</a>`
          : `<span class="muted">${U.esc(l.ig_user_id)}</span>` },
        { campo: "last_source", titulo: "Origem", render: (l) => l.last_source === "comment" ? "💬 Comentário" : l.last_source === "dm" ? "✉️ DM" : "-" },
        { campo: "last_keyword", titulo: "Palavra", render: (l) => l.last_keyword ? `<span class="tag">${U.esc(l.last_keyword)}</span>` : "-" },
        { titulo: "Automação", ordenavel: false, render: (l) => U.esc(nomeAuto.get(l.automation_id) || "-") },
        { campo: "last_text", titulo: "Última mensagem", render: (l) => `<span class="pequeno">${U.esc((l.last_text || "-").slice(0, 80))}</span>` },
        { campo: "email", titulo: "E-mail", render: (l) => U.esc(l.email || "-") },
        { campo: "telefone", titulo: "Telefone", render: (l) => U.esc(l.telefone || "-") },
        { titulo: "Tags", ordenavel: false, render: (l) => `${(l.tags || []).map((t) => `<span class="tag">${U.esc(t)}</span>`).join("")}<button class="btn btn-fantasma btn-p" data-tags="${l.id}" title="Editar tags">🏷️</button>` },
        { campo: "last_inbound_at", titulo: "Janela 24h", render: (l) => janelaAberta(l) ? '<span class="badge badge-ok">Aberta</span>' : '<span class="badge">Fechada</span>' },
        { campo: "updated_at", titulo: "Atualizado", render: (l) => U.dataHora(l.updated_at) },
      ],
    });
  }

  function editarTagsLead(id) {
    const l = leads.find((x) => x.id === id);
    if (!l) return;
    const m = U.modal({
      titulo: `🏷️ Tags de @${l.username || l.ig_user_id}`,
      html: `<div class="campo"><label for="m-tags">Tags (separadas por vírgula)</label><input class="input" id="m-tags" value="${U.esc((l.tags || []).join(", "))}"></div>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "💾 Salvar", classe: "btn-primario", acao: async (fechar) => {
          const tags = [...new Set(m.el.querySelector("#m-tags").value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
          const { error } = await sb.from("ig_leads").update({ tags }).eq("id", id);
          if (error) return U.toast(error.message, "erro");
          l.tags = tags;
          fechar(); U.toast("Salvo ✓"); desenharLeads();
        } },
      ],
    });
  }

  // =====================================================================
  // Entregas
  // =====================================================================
  async function carregarEntregas() {
    let q = sb.from("ig_deliveries").select("*").order("ts", { ascending: false }).limit(1000);
    if ($("a-e-auto").value) q = q.eq("automation_id", $("a-e-auto").value);
    if ($("a-e-status").value) q = q.eq("status", $("a-e-status").value);
    const dia = $("a-e-dia").value;
    if (dia) {
      const ini = U.spParaISO(dia + "T00:00");
      const fim = new Date(new Date(ini).getTime() + 24 * 3600e3).toISOString();
      q = q.gte("ts", ini).lt("ts", fim);
    }
    const { data, error } = await q;
    if (error) return U.toast("Erro nas entregas: " + error.message, "erro");
    entregas = data || [];
    const nomes = new Map(leads.map((l) => [l.ig_user_id, l.username]));
    if (!leads.length) {
      const { data: ls } = await sb.from("ig_leads").select("ig_user_id, username").limit(5000);
      (ls || []).forEach((l) => nomes.set(l.ig_user_id, l.username));
    }
    const nomeAuto = new Map(autos.map((a) => [a.id, a.nome]));
    U.tabela($("a-e-tabela"), {
      linhas: entregas,
      vazio: "Nenhuma entrega nesse filtro.",
      colunas: [
        { campo: "ts", titulo: "Quando", render: (d) => U.dataHora(d.ts) },
        { campo: "ig_user_id", titulo: "Pra quem", render: (d) => nomes.get(d.ig_user_id) ? "@" + U.esc(nomes.get(d.ig_user_id)) : `<span class="muted">${U.esc(d.ig_user_id || "-")}</span>` },
        { titulo: "Automação", ordenavel: false, render: (d) => U.esc(nomeAuto.get(d.automation_id) || "-") },
        { campo: "canal", titulo: "Canal", render: (d) => ({ private_reply: "💬 Resposta privada", dm: "✉️ DM", comment_reply: "🗨️ Resposta pública" })[d.canal] || d.canal || "-" },
        { campo: "tipo", titulo: "O quê", render: (d) => U.esc(d.tipo || "-") },
        { campo: "status", titulo: "Status", render: (d) => {
          const b = d.status === "ok" ? '<span class="badge badge-ok">Enviado</span>' : d.status === "pulado" ? '<span class="badge badge-aviso">Pulado</span>' : '<span class="badge badge-erro">Erro</span>';
          return b + (d.motivo ? `<div class="pequeno muted" style="margin-top:4px;max-width:320px">${U.esc(d.motivo)}</div>` : "");
        } },
      ],
    });
  }

  // =====================================================================
  // Freio
  // =====================================================================
  async function carregarFreio() {
    const [{ data: f }, { data: pausas }] = await Promise.all([
      sb.rpc("ig_freio"),
      sb.from("ig_pausas").select("*").order("ts", { ascending: false }).limit(50),
    ]);
    if (!f) return;
    const barra = (n, cap) => `<div class="barra" style="margin:10px 0 0"><div class="barra-cheia" style="width:${Math.min(100, Math.round((n / cap) * 100))}%"></div></div>`;
    $("a-f-contadores").innerHTML =
      `<div class="card card-numero"><div class="rotulo">⏱️ Neste minuto</div><div class="numero">${f.minuto}<span class="muted pequeno"> / ${f.cap_minute}</span></div>${barra(f.minuto, f.cap_minute)}</div>` +
      `<div class="card card-numero"><div class="rotulo">🕐 Nesta hora</div><div class="numero">${f.hora}<span class="muted pequeno"> / ${f.cap_hour}</span></div>${barra(f.hora, f.cap_hour)}</div>` +
      `<div class="card card-numero"><div class="rotulo">📅 Hoje</div><div class="numero">${f.dia}<span class="muted pequeno"> / ${f.cap_day}</span></div>${barra(f.dia, f.cap_day)}</div>` +
      `<div class="card card-numero"><div class="rotulo">⚠️ Erros de limite seguidos</div><div class="numero">${f.err_streak}<span class="muted pequeno"> / 3</span></div></div>`;
    $("a-f-min").value = f.cap_minute;
    $("a-f-hora").value = f.cap_hour;
    $("a-f-dia").value = f.cap_day;
    $("a-f-estado").innerHTML = f.pausado_manual
      ? "⏸️ <strong>Pausado manualmente.</strong> Nada sai até você retomar."
      : f.paused_until ? `⏸️ <strong>Pausado automaticamente até ${U.hora(f.paused_until)}</strong>: ${U.esc(f.paused_reason || "")}`
      : "▶️ Rodando normalmente.";
    $("a-f-pausar").disabled = !!f.pausado_manual;
    $("a-f-retomar").disabled = !f.pausado_manual && !f.paused_until;
    U.tabela($("a-f-pausas"), {
      linhas: pausas || [],
      vazio: "Nenhuma pausa até agora. Ótimo sinal.",
      colunas: [
        { campo: "ts", titulo: "Quando", render: (p) => U.dataHora(p.ts) },
        { campo: "ate", titulo: "Até", render: (p) => p.ate ? U.dataHora(p.ate) : "até retomar" },
        { campo: "manual", titulo: "Tipo", render: (p) => p.manual ? "✋ Manual" : "🤖 Automática" },
        { campo: "motivo", titulo: "Motivo", render: (p) => U.esc(p.motivo || "-") },
      ],
    });
    atualizarAvisoFreio(f);
  }

  function atualizarAvisoFreio(f) {
    const el = $("a-aviso-freio");
    if (f?.pausado_manual || f?.paused_until) {
      el.innerHTML = `<span>🛑</span><span><strong>As automações estão pausadas.</strong> ${f.pausado_manual ? "Pausa manual." : `Pausa automática até ${U.hora(f.paused_until)}: ${U.esc(f.paused_reason || "")}.`} Veja a sub-aba 🛑 Freio.</span>`;
      el.classList.remove("oculto");
    } else {
      el.classList.add("oculto");
    }
  }

  async function salvarCaps(e) {
    e.preventDefault();
    const caps = { cap_minute: +$("a-f-min").value, cap_hour: +$("a-f-hora").value, cap_day: +$("a-f-dia").value };
    if (Object.values(caps).some((v) => !v || v < 1)) return U.toast("Os limites precisam ser maiores que zero.", "erro");
    if (caps.cap_day > 200 && !(await U.confirmar("Acima de 200 por dia o risco de o Instagram frear a conta aumenta bastante.", { titulo: "Tem certeza?", ok: "Salvar mesmo assim" }))) return;
    const { error } = await sb.from("ig_send_budget").update(caps).eq("id", 1);
    if (error) return U.toast(error.message, "erro");
    U.toast("Limites salvos ✓");
    carregarFreio();
    carregarNumeros();
  }

  async function pausar() {
    if (!(await U.confirmar("Nenhuma DM automática sai até você retomar.", { titulo: "Pausar tudo?", ok: "Pausar", perigo: true }))) return;
    await sb.from("ig_send_budget").update({ pausado_manual: true }).eq("id", 1);
    await sb.from("ig_pausas").insert({ motivo: "Pausa manual pelo painel", manual: true });
    U.toast("⏸️ Tudo pausado");
    carregarFreio();
  }

  async function retomar() {
    await sb.from("ig_send_budget").update({ pausado_manual: false, paused_until: null, paused_reason: null, err_streak: 0 }).eq("id", 1);
    U.toast("▶️ Retomado");
    carregarFreio();
  }

  // =====================================================================
  // Mídia
  // =====================================================================
  async function carregarAssets() {
    const { data } = await sb.from("ig_assets").select("*").order("created_at", { ascending: false });
    assets = data || [];
    return assets;
  }

  async function desenharMidia() {
    await carregarAssets();
    const el = $("a-m-grade");
    if (!assets.length) {
      el.innerHTML = `<div class="vazio" style="grid-column:1/-1"><div class="vazio-emoji">🖼️</div><h3>Nenhum arquivo ainda.</h3><p>Que tal subir o PDF ou o áudio que você quer mandar na DM?</p></div>`;
      return;
    }
    el.innerHTML = assets.map((a) => `
      <div class="card midia-card">
        <div class="midia-previa">${a.tipo === "image" ? `<img src="${U.esc(a.url)}" alt="" loading="lazy">`
          : a.tipo === "video" ? `<video src="${U.esc(a.url)}" muted preload="metadata"></video>`
          : a.tipo === "audio" ? "🎧" : "📄"}</div>
        <div class="midia-info">
          <div class="nome" title="${U.esc(a.nome)}">${U.esc(a.nome)}</div>
          <div class="muted pequeno">${(a.tamanho / 1048576).toFixed(1)} MB · ${U.data(a.created_at)}</div>
          <div class="linha">
            <button class="btn btn-fantasma btn-p" data-copiar-url="${U.esc(a.url)}">📋 Link</button>
            <button class="btn btn-fantasma btn-p" data-apagar-asset="${a.id}">🗑️</button>
          </div>
        </div>
      </div>`).join("");
  }

  function tipoArquivo(f) {
    const n = f.name.toLowerCase();
    if (/\.mp3$/.test(n) || f.type === "audio/mpeg") return { erro: "MP3 o Instagram recusa. Converta pra M4A." };
    if (/^image\/(jpeg|png|gif|webp)$/.test(f.type)) return { tipo: "image", max: 8 };
    if (/\.m4a$/.test(n) || /^audio\/(mp4|x-m4a|m4a)$/.test(f.type)) return { tipo: "audio", max: 25, mime: "audio/mp4" };
    if (f.type === "video/mp4" || /\.mp4$/.test(n)) return { tipo: "video", max: 25, mime: "video/mp4" };
    if (f.type === "application/pdf" || /\.pdf$/.test(n)) return { tipo: "file", max: 25, mime: "application/pdf" };
    return { erro: "Formato não aceito. Use JPG, PNG, GIF, WEBP, M4A, MP4 ou PDF." };
  }

  async function enviarArquivos(files) {
    const prog = $("a-m-progresso");
    prog.classList.remove("oculto");
    for (const f of files) {
      const t = tipoArquivo(f);
      if (t.erro) { U.toast(`${f.name}: ${t.erro}`, "erro", 6000); continue; }
      if (f.size > t.max * 1048576) { U.toast(`${f.name}: passa de ${t.max}MB.`, "erro", 6000); continue; }
      prog.textContent = `Enviando ${f.name}...`;
      const limpo = f.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
      const path = `${Date.now()}-${limpo}`;
      const { error } = await sb.storage.from("ig-assets").upload(path, f, { contentType: t.mime || f.type, upsert: false });
      if (error) { U.toast(`${f.name}: ${error.message}`, "erro", 6000); continue; }
      const url = sb.storage.from("ig-assets").getPublicUrl(path).data.publicUrl;
      const { error: e2 } = await sb.from("ig_assets").insert({ nome: f.name, tipo: t.tipo, url, path, tamanho: f.size });
      if (e2) U.toast(e2.message, "erro");
      else U.toast(`${f.name} enviado ✓`);
    }
    prog.classList.add("oculto");
    $("a-m-arquivo").value = "";
    desenharMidia();
  }

  async function apagarAsset(id) {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    const usado = autos.some((x) => (x.flow?.steps || []).some((s) => (s.assets || []).includes(a.url)));
    if (!(await U.confirmar(usado ? "Esse arquivo está em uso numa automação. Se apagar, ele deixa de ir." : `Apagar "${a.nome}"?`, { perigo: true, ok: "Apagar" }))) return;
    await sb.storage.from("ig-assets").remove([a.path]);
    const { error } = await sb.from("ig_assets").delete().eq("id", id);
    if (error) return U.toast(error.message, "erro");
    U.toast("Apagado ✓");
    desenharMidia();
  }

  // =====================================================================
  // Recado (broadcast)
  // =====================================================================
  function recado() {
    const m = U.modal({
      titulo: "📣 Recado pra quem está com a janela aberta",
      grande: true,
      html: `
        <div style="display:grid;gap:14px">
          <div class="aviso info"><span>ℹ️</span><span>Pela regra da Meta, só dá pra mandar mensagem nova pra quem falou com você nas últimas 24h. O freio vale aqui também.</span></div>
          <div class="campo"><label for="m-msg">Mensagem</label><textarea class="textarea" id="m-msg" maxlength="1000" placeholder="Oi! Abri mais 5 vagas pra mentoria, quer que eu te conte?"></textarea></div>
          <div class="form-grade">
            <div class="campo"><label for="m-bt">Botão (opcional)</label><input class="input" id="m-bt" maxlength="20" placeholder="Ver detalhes"></div>
            <div class="campo"><label for="m-url">Link do botão</label><input class="input" id="m-url" placeholder="https://..."></div>
            <div class="campo"><label for="m-auto">Só leads da automação</label><select class="select" id="m-auto"><option value="">Todas</option>${autos.map((a) => `<option value="${a.id}">${U.esc(a.nome)}</option>`).join("")}</select></div>
            <div class="campo"><label for="m-tag">Só com a tag</label><input class="input" id="m-tag" placeholder="opcional"></div>
          </div>
          <div id="m-contagem" class="contagem">Clique em "Contar" pra ver quantas pessoas recebem.</div>
        </div>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "🔢 Contar", classe: "btn-secundario", acao: (_f, btn) => rodar(btn, true) },
        { texto: "📣 Enviar", classe: "btn-primario", acao: (_f, btn) => rodar(btn, false) },
      ],
    });
    const corpo = () => ({
      mensagem: m.el.querySelector("#m-msg").value.trim(),
      botao_titulo: m.el.querySelector("#m-bt").value.trim() || null,
      botao_url: m.el.querySelector("#m-url").value.trim() || null,
      automation_id: m.el.querySelector("#m-auto").value || null,
      tag: m.el.querySelector("#m-tag").value.trim().toLowerCase() || null,
    });
    async function rodar(btn, dry) {
      const b = corpo();
      if (!dry && !b.mensagem) return U.toast("Escreva o recado.", "erro");
      if (b.botao_titulo && !/^https:\/\//i.test(b.botao_url || "")) return U.toast("O link do botão precisa começar com https://", "erro");
      await U.comCarregando(btn, async () => {
        try {
          const c = await U.chamarFunction("ig-broadcast", { ...b, dry_run: true });
          const el = m.el.querySelector("#m-contagem");
          el.classList.toggle("zero", !c.total);
          el.textContent = c.total ? `📨 ${c.total} pessoa(s) com a janela aberta vão receber.` : "⚠️ Ninguém com a janela aberta agora.";
          if (dry || !c.total) return;
          if (!(await U.confirmar(`Mandar o recado pra ${c.total} pessoa(s)?`, { ok: `Enviar pra ${c.total}` }))) return;
          const r = await U.chamarFunction("ig-broadcast", { ...b, dry_run: false });
          m.fechar();
          U.modal({ titulo: r.parouNoFreio ? "⚠️ O freio segurou" : "✅ Recado enviado",
            html: `<p>Enviados: <strong>${r.enviados}</strong> · Falhas: <strong>${r.falhas}</strong> · Não tentados: <strong>${r.naoTentados}</strong></p>
                   ${r.parouNoFreio ? `<p class="muted pequeno" style="margin-top:8px">${U.esc(r.parouNoFreio)}</p>` : ""}`,
            botoes: [{ texto: "Fechar", classe: "btn-primario" }] });
          carregarNumeros();
        } catch (e) {
          U.toast(e.message, "erro", 7000);
        }
      });
    }
  }

  // =====================================================================
  // Números do topo
  // =====================================================================
  async function carregarNumeros() {
    const desde = new Date(Date.now() - 24 * 3600e3).toISOString();
    const [a, l, j, e, f] = await Promise.all([
      sb.from("ig_automations").select("id, active"),
      sb.from("ig_leads").select("id", { count: "exact", head: true }),
      sb.from("ig_leads").select("id", { count: "exact", head: true }).gte("last_inbound_at", desde),
      sb.from("ig_leads").select("id", { count: "exact", head: true }).not("email", "is", null),
      sb.rpc("ig_freio"),
    ]);
    const lista = a.data || [];
    $("a-n-ativas").textContent = lista.filter((x) => x.active).length;
    $("a-n-total").textContent = `de ${lista.length}`;
    $("a-n-leads").textContent = U.numero(l.count ?? 0);
    $("a-n-janela").textContent = `janelas abertas: ${U.numero(j.count ?? 0)}`;
    $("a-n-emails").textContent = U.numero(e.count ?? 0);
    if (f.data) {
      $("a-n-hoje").textContent = U.numero(f.data.dia);
      $("a-n-cap").textContent = `limite: ${f.data.cap_day} por dia`;
      atualizarAvisoFreio(f.data);
    }
  }

  // =====================================================================
  // Sub-abas e eventos
  // =====================================================================
  function irSub(nome) {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.classList.toggle("ativo", b.dataset.sub === nome));
    secao.querySelectorAll(".subaba").forEach((s) => s.classList.toggle("ativa", s.dataset.sub === nome));
    U.guardar.gravar(CHAVE_SUB, nome);
    if (nome === "lista") carregarAutos();
    if (nome === "leads") carregarLeads();
    if (nome === "entregas") carregarEntregas();
    if (nome === "freio") carregarFreio();
    if (nome === "midia") desenharMidia();
  }

  function ligarEventos() {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.addEventListener("click", () => irSub(b.dataset.sub)));
    $("a-btn-nova").addEventListener("click", () => abrirEditor(null));
    $("a-btn-recado").addEventListener("click", recado);

    $("a-lista").addEventListener("click", (e) => {
      const t = (sel) => e.target.closest(sel);
      if (t("[data-nova]")) abrirEditor(null);
      if (t("[data-editar]")) abrirEditor(t("[data-editar]").dataset.editar);
      if (t("[data-duplicar]")) duplicar(t("[data-duplicar]").dataset.duplicar);
      if (t("[data-testar]")) testar(t("[data-testar]").dataset.testar, t("[data-testar]"));
      if (t("[data-apagar]")) apagar(t("[data-apagar]").dataset.apagar);
    });
    $("a-lista").addEventListener("change", (e) => {
      const c = e.target.closest("[data-ativar]");
      if (c) ativar(c.dataset.ativar, c.checked, c);
    });

    $("a-l-busca").addEventListener("input", desenharLeads);
    $("a-l-origem").addEventListener("change", desenharLeads);
    $("a-l-filtro").addEventListener("change", desenharLeads);
    $("a-l-tabela").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tags]");
      if (b) editarTagsLead(b.dataset.tags);
    });
    $("a-l-csv").addEventListener("click", () => U.baixarCSV(`leads-instagram-${U.spInput().slice(0, 10)}.csv`, leads, [
      { titulo: "Usuário", valor: (l) => l.username ? "@" + l.username : "" }, { titulo: "ID", campo: "ig_user_id" },
      { titulo: "Origem", campo: "last_source" }, { titulo: "Palavra", campo: "last_keyword" },
      { titulo: "Última mensagem", campo: "last_text" }, { titulo: "E-mail", campo: "email" },
      { titulo: "Telefone", campo: "telefone" }, { titulo: "Tags", campo: "tags" },
      { titulo: "Última interação", valor: (l) => U.dataHora(l.last_inbound_at) }, { titulo: "Criado", valor: (l) => U.dataHora(l.created_at) },
    ]));

    ["a-e-auto", "a-e-dia", "a-e-status"].forEach((id) => $(id).addEventListener("change", carregarEntregas));
    $("a-e-atualizar").addEventListener("click", carregarEntregas);

    $("a-f-form").addEventListener("submit", salvarCaps);
    $("a-f-pausar").addEventListener("click", pausar);
    $("a-f-retomar").addEventListener("click", retomar);

    $("a-m-arquivo").addEventListener("change", (e) => enviarArquivos([...e.target.files]));
    $("a-m-grade").addEventListener("click", (e) => {
      const c = e.target.closest("[data-copiar-url]");
      if (c) U.copiar(c.dataset.copiarUrl);
      const d = e.target.closest("[data-apagar-asset]");
      if (d) apagarAsset(d.dataset.apagarAsset);
    });
  }

  window.ABAS = window.ABAS || {};
  window.ABAS.automacao = {
    iniciar(el) {
      secao = el;
      ligarEventos();
      $("a-e-dia").value = U.spInput().slice(0, 10);
      carregarAssets();
      // Capas dos posts chegam depois; a lista é redesenhada quando vierem
      carregarPosts().then(() => { if (autos.length) desenharLista(); });
      irSub(U.guardar.ler(CHAVE_SUB, "lista"));
    },
    mostrar() {
      carregarNumeros();
    },
  };
})();
