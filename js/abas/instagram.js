// Aba 📊 Instagram: visão geral, posts, comentários, revisão do dia, concorrentes e objetivos.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CHAVE_SUB = "admin:instagram:sub";
  const CHAVE_DIAS = "admin:instagram:dias";
  const FORMATOS = { REELS: "🎬 Reel", CAROUSEL_ALBUM: "🗂️ Carrossel", IMAGE: "🖼️ Foto", VIDEO: "📹 Vídeo" };
  const OBJ = {
    seguidores: { nome: "👥 Seguidores", unidade: "seguidores" },
    views_mes: { nome: "▶️ Views nos últimos 30 dias", unidade: "views" },
    posts_semana: { nome: "📅 Posts por semana", unidade: "posts" },
  };
  const DIA = 86400000;

  let secao;
  let dias = 30;
  let dados = null;         // payload do período escolhido
  const caches = new Map(); // days -> { payload, generated_at }
  let pagos = [];
  let pollComentarios = null;
  let mesCal = null;

  // =====================================================================
  // Utilidades
  // =====================================================================
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const curto = (n) => {
    if (n == null || isNaN(n)) return "-";
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (a >= 1e4) return (n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil";
    return U.numero(n);
  };
  const pct = (n) => (n == null ? "-" : n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%");
  const sinal = (n) => (n == null ? "" : (n > 0 ? "+" : "") + U.numero(n));
  const diaSP = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: U.FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
  const dataCurta = (iso) => { const [, m, d] = iso.split("-"); return `${d}/${m}`; };
  const legenda = (t, n = 90) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s || "(sem legenda)"; };
  const capaHTML = (p, cls = "thumb") => p.capa
    ? `<img class="${cls}" src="${U.esc(p.capa)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cls} thumb-vazio',textContent:'🖼️'}))">`
    : `<div class="${cls} thumb-vazio">${p.formato === "REELS" ? "🎬" : "🖼️"}</div>`;

  function aviso(msg, tipo = "info") {
    const el = $("i-aviso");
    if (!msg) { el.classList.add("oculto"); return; }
    el.className = "aviso " + tipo;
    el.innerHTML = msg;
  }

  // =====================================================================
  // Gráfico de linha em canvas puro
  // =====================================================================
  function grafico(canvas, pontos, { cor, faixas = [], marcar = null, formato = curto } = {}) {
    const caixa = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const W = caixa.clientWidth || 300, H = caixa.clientHeight || 220;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const fonte = css("--fonte") || "sans-serif";
    g.font = `12px ${fonte}`;
    if (!pontos.length) {
      g.fillStyle = css("--texto-3"); g.textAlign = "center";
      g.fillText("Sem dados nesse período.", W / 2, H / 2);
      return;
    }
    const pad = { e: 46, d: 12, t: 12, b: 26 };
    const vals = pontos.map((p) => p.v);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const folga = (max - min) * 0.08;
    min = Math.max(0, min - folga);
    max += folga;
    const x = (i) => pad.e + (pontos.length === 1 ? (W - pad.e - pad.d) / 2 : (i / (pontos.length - 1)) * (W - pad.e - pad.d));
    const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

    // Faixas (períodos pagos)
    g.fillStyle = "rgba(255, 200, 87, 0.12)";
    for (const f of faixas) {
      const i0 = pontos.findIndex((p) => p.dia >= f.inicio);
      let i1 = -1; pontos.forEach((p, i) => { if (p.dia <= f.fim) i1 = i; });
      if (i0 >= 0 && i1 >= i0) g.fillRect(x(i0) - 3, pad.t, Math.max(6, x(i1) - x(i0) + 6), H - pad.t - pad.b);
    }

    // Grade e eixo Y
    g.strokeStyle = css("--borda"); g.lineWidth = 1; g.fillStyle = css("--texto-3"); g.textAlign = "right"; g.textBaseline = "middle";
    for (let k = 0; k <= 3; k++) {
      const v = min + ((max - min) * k) / 3;
      const yy = y(v);
      g.beginPath(); g.moveTo(pad.e, yy); g.lineTo(W - pad.d, yy); g.stroke();
      g.fillText(formato(Math.round(v)), pad.e - 8, yy);
    }
    // Eixo X: até 6 datas
    g.textAlign = "center"; g.textBaseline = "top";
    const passo = Math.max(1, Math.ceil(pontos.length / 6));
    pontos.forEach((p, i) => { if (i % passo === 0 || i === pontos.length - 1) g.fillText(dataCurta(p.dia), x(i), H - pad.b + 8); });

    // Área + linha
    const c = cor || css("--cor");
    const grad = g.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, c + "55"); grad.addColorStop(1, c + "00");
    g.beginPath();
    pontos.forEach((p, i) => (i ? g.lineTo(x(i), y(p.v)) : g.moveTo(x(i), y(p.v))));
    g.lineTo(x(pontos.length - 1), H - pad.b); g.lineTo(x(0), H - pad.b); g.closePath();
    g.fillStyle = grad; g.fill();
    g.beginPath();
    pontos.forEach((p, i) => (i ? g.lineTo(x(i), y(p.v)) : g.moveTo(x(i), y(p.v))));
    g.strokeStyle = c; g.lineWidth = 2.2; g.lineJoin = "round"; g.stroke();

    if (marcar) {
      const i = pontos.findIndex((p) => p.dia === marcar);
      if (i >= 0) {
        g.beginPath(); g.arc(x(i), y(pontos[i].v), 5, 0, Math.PI * 2);
        g.fillStyle = c; g.fill(); g.strokeStyle = css("--fundo"); g.lineWidth = 2; g.stroke();
      }
    }

    // Dica ao passar o mouse
    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      let melhor = 0;
      pontos.forEach((p, i) => { if (Math.abs(x(i) - mx) < Math.abs(x(melhor) - mx)) melhor = i; });
      canvas.title = `${dataCurta(pontos[melhor].dia)}: ${U.numero(pontos[melhor].v)}`;
    };
  }

  // =====================================================================
  // Dados
  // =====================================================================
  async function lerCaches() {
    const { data, error } = await sb.from("ig_insights_cache").select("days, payload, generated_at");
    if (error) throw error;
    (data || []).forEach((r) => caches.set(r.days, r));
  }

  async function atualizar(forcar = false, btn = null) {
    const c = caches.get(dias);
    const velho = !c || Date.now() - new Date(c.generated_at).getTime() > 12 * 3600e3;
    if (!forcar && !velho) { dados = c.payload; desenharTudo(); return; }
    if (c) { dados = c.payload; desenharTudo(); }
    $("i-atualizado").textContent = "Buscando os números na Meta...";
    try {
      await U.comCarregando(btn, async () => {
        const r = await U.chamarFunction("ig-insights", { days: dias });
        caches.set(dias, { days: dias, payload: r.payload, generated_at: r.payload.gerado_em });
        dados = r.payload;
      });
      aviso(null);
      desenharTudo();
      if (forcar) U.toast("Números atualizados ✓");
    } catch (e) {
      $("i-atualizado").textContent = c ? `Atualizado em ${U.dataHora(c.generated_at)}` : "";
      aviso(`⚠️ ${U.esc(e.message)}${/token|conect|IG_ACCESS/i.test(e.message) ? ' <button class="btn btn-fantasma btn-p" data-ir-aba="configuracoes">⚙️ Ver Instagram</button>' : ""}`, "erro");
      if (!c) desenharTudo();
    }
  }

  async function carregarPagos() {
    const { data } = await sb.from("ig_periodos_pagos").select("*").order("inicio", { ascending: false });
    pagos = data || [];
  }

  function postsDoCalendario() {
    // O cache com mais posts (de preferência "tudo") alimenta calendário e metas
    let melhor = [];
    for (const c of caches.values()) if ((c.payload?.posts?.length || 0) > melhor.length) melhor = c.payload.posts;
    return melhor;
  }

  // =====================================================================
  // Visão geral
  // =====================================================================
  function desenharTudo() {
    $("i-atualizado").textContent = dados ? `Atualizado em ${U.dataHora(dados.gerado_em)} · ${dados.periodo.desde.split("-").reverse().join("/")} a ${dados.periodo.ate.split("-").reverse().join("/")}` : "Sem dados ainda. Clique em Atualizar.";
    desenharCards();
    desenharGraficos();
    desenharTop();
    desenharPagos();
    desenharPosts();
    desenharObjetivos();
    desenharCalendario();
  }

  function desenharCards() {
    const k = dados?.cards || {};
    const card = (rot, num, sub = "") => `<div class="card card-numero"><div class="rotulo">${rot}</div><div class="numero">${num}</div><div class="variacao">${sub}</div></div>`;
    const varSeg = k.seguidores_var;
    $("i-cards").innerHTML = [
      card("👁️ Alcance", curto(k.alcance), k.alcance_somado ? "soma dos dias (pode contar a mesma pessoa 2x)" : "contas únicas no período"),
      card("👥 Seguidores", curto(k.seguidores), varSeg == null ? "" : `<span style="color:var(${varSeg >= 0 ? "--ok" : "--erro"})">${sinal(varSeg)}</span> no período`),
      card("▶️ Views", curto(k.views), k.visitas_perfil != null ? `${U.numero(k.visitas_perfil)} visitas ao perfil` : ""),
      card("💬 Interações", curto(k.interacoes), k.contas_engajadas != null ? `${U.numero(k.contas_engajadas)} contas engajadas` : ""),
      card("🔖 Salvamentos", curto(k.salvamentos), `${U.numero(k.posts ?? 0)} posts no período`),
      card("📈 Engajamento", pct(k.engajamento), "interações ÷ alcance"),
    ].join("");

    const sobrepostos = dados ? pagos.filter((p) => p.fim >= dados.periodo.desde && p.inicio <= dados.periodo.ate) : [];
    if (sobrepostos.length && !$("i-aviso").classList.contains("erro")) {
      aviso(`💸 Esse período tem ${sobrepostos.length === 1 ? "um intervalo impulsionado" : sobrepostos.length + " intervalos impulsionados"} (${sobrepostos.map((p) => `${U.data(p.inicio + "T12:00")} a ${U.data(p.fim + "T12:00")}`).join(", ")}). Cuidado ao comparar com períodos só orgânicos.`, "info");
    } else if (!sobrepostos.length && !$("i-aviso").classList.contains("erro")) aviso(null);
  }

  function desenharGraficos() {
    const faixas = pagos.map((p) => ({ inicio: p.inicio, fim: p.fim }));
    grafico($("i-g-alcance"), dados?.serie?.alcance || [], { faixas });
    const seg = dados?.serie?.seguidores || [];
    grafico($("i-g-seguidores"), seg, { cor: css("--info"), faixas });
    const est = seg.filter((p) => p.estimado).length;
    $("i-g-seg-nota").textContent = est && seg.length ? "Dias sem foto diária são estimados pelos novos seguidores que a Meta informa (ela não conta quem deixou de seguir)." : "";
  }

  function cardPost(p) {
    return `<button class="card post-card" data-post="${U.esc(p.id)}">
      ${capaHTML(p, "post-capa")}
      <div class="post-card-corpo">
        <div class="linha" style="justify-content:space-between"><span class="badge badge-cor sem-ponto">${FORMATOS[p.formato] || p.formato}</span><span class="muted pequeno">${U.data(p.timestamp)}</span></div>
        <div class="pequeno">${U.esc(legenda(p.caption, 70))}</div>
        <div class="post-numeros"><span>👁️ ${curto(p.reach)}</span><span>▶️ ${curto(p.views)}</span><span>❤️ ${curto(p.likes)}</span><span>🔖 ${curto(p.saved)}</span></div>
      </div>
    </button>`;
  }

  function desenharTop() {
    const ps = dados?.posts || [];
    const top = (dados?.top5 || []).map((id) => ps.find((p) => p.id === id)).filter(Boolean);
    $("i-top5").innerHTML = top.length ? top.map(cardPost).join("")
      : `<div class="vazio" style="grid-column:1/-1"><div class="vazio-emoji">🫙</div><h3>Nenhum post nesse período.</h3><p>Escolha um período maior ali em cima, ou publique algo novo 😉</p></div>`;
  }

  function desenharPagos() {
    U.tabela($("i-pagos"), {
      linhas: pagos,
      vazio: "Nenhum período pago marcado.",
      colunas: [
        { campo: "inicio", titulo: "De", render: (p) => U.data(p.inicio + "T12:00") },
        { campo: "fim", titulo: "Até", render: (p) => U.data(p.fim + "T12:00") },
        { campo: "nota", titulo: "Nota", render: (p) => U.esc(p.nota || "-") },
        { titulo: "", ordenavel: false, render: (p) => `<button class="btn btn-perigo btn-p" data-apagar-pago="${p.id}">🗑️</button>` },
      ],
    });
  }

  function novoPago() {
    const hoje = U.spInput().slice(0, 10);
    const m = U.modal({
      titulo: "💸 Marcar período impulsionado",
      html: `<div class="form-grade">
        <div class="campo"><label>De</label><input class="input" type="date" id="pg-ini" value="${hoje}"></div>
        <div class="campo"><label>Até</label><input class="input" type="date" id="pg-fim" value="${hoje}"></div>
        <div class="campo inteiro"><label>Nota (opcional)</label><input class="input" id="pg-nota" placeholder="Ex.: impulsionei o reel do lançamento"></div></div>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "💾 Salvar", classe: "btn-primario", acao: async (fechar, btn) => {
          const inicio = m.corpo.querySelector("#pg-ini").value, fim = m.corpo.querySelector("#pg-fim").value;
          if (!inicio || !fim || fim < inicio) return U.toast("Confira as datas.", "aviso");
          await U.comCarregando(btn, async () => {
            const { error } = await sb.from("ig_periodos_pagos").insert({ inicio, fim, nota: m.corpo.querySelector("#pg-nota").value.trim() || null });
            if (error) throw error;
          }).catch((e) => U.toast(e.message, "erro"));
          fechar(); await carregarPagos(); desenharTudo(); U.toast("Salvo ✓");
        } },
      ],
    });
  }

  // =====================================================================
  // Posts
  // =====================================================================
  function desenharPosts() {
    const busca = U.semAcento($("i-p-busca").value);
    const fmt = $("i-p-formato").value;
    const linhas = (dados?.posts || []).filter((p) => (!fmt || p.formato === fmt) && (!busca || U.semAcento(p.caption).includes(busca)));
    U.tabela($("i-p-tabela"), {
      linhas,
      vazio: dados ? "Nenhum post com esse filtro." : "Clique em Atualizar pra carregar os posts.",
      colunas: [
        { titulo: "Post", ordenavel: false, render: (p) => `<div class="linha" style="flex-wrap:nowrap;gap:12px">${capaHTML(p)}<span class="pequeno">${U.esc(legenda(p.caption, 60))}</span></div>` },
        { campo: "formato", titulo: "Formato", render: (p) => FORMATOS[p.formato] || p.formato },
        { campo: "timestamp", titulo: "Data", render: (p) => U.data(p.timestamp) },
        { campo: "views", titulo: "Views", render: (p) => curto(p.views) },
        { campo: "reach", titulo: "Alcance", render: (p) => curto(p.reach) },
        { campo: "likes", titulo: "Curtidas", render: (p) => curto(p.likes) },
        { campo: "comments", titulo: "Coment.", render: (p) => curto(p.comments) },
        { campo: "saved", titulo: "Salvos", render: (p) => curto(p.saved) },
        { campo: "shares", titulo: "Compart.", render: (p) => curto(p.shares) },
        { campo: "retencao_s", titulo: "Retenção", render: (p) => (p.retencao_s == null ? "-" : `${p.retencao_s.toLocaleString("pt-BR")}s`) },
      ],
    });
  }

  function abrirPost(id) {
    const p = (dados?.posts || []).find((x) => x.id === id) || postsDoCalendario().find((x) => x.id === id);
    if (!p) return;
    const n = (rot, v) => `<div class="mini-numero"><span>${rot}</span><strong>${v}</strong></div>`;
    const m = U.modal({
      titulo: `${FORMATOS[p.formato] || "Post"} de ${U.data(p.timestamp)}`,
      grande: true,
      html: `<div class="post-detalhe">
        <div>${capaHTML(p, "post-capa-grande")}
          <a class="btn btn-secundario btn-bloco" style="margin-top:10px" href="${U.esc(p.permalink)}" target="_blank" rel="noopener">↗️ Abrir no Instagram</a></div>
        <div>
          <p class="pequeno" style="white-space:pre-wrap;max-height:120px;overflow:auto">${U.esc(p.caption || "(sem legenda)")}</p>
          <div class="mini-numeros">
            ${n("▶️ Views", U.numero(p.views))}${n("👁️ Alcance", U.numero(p.reach))}${n("❤️ Curtidas", U.numero(p.likes))}
            ${n("💬 Comentários", U.numero(p.comments))}${n("🔖 Salvos", U.numero(p.saved))}${n("🔁 Compart.", U.numero(p.shares))}
            ${n("⚡ Interações", U.numero(p.interacoes))}${n("📈 Engajamento", pct(p.engajamento))}
            ${p.retencao_s != null ? n("⏱️ Retenção média", p.retencao_s.toLocaleString("pt-BR") + "s") : ""}
            ${p.tempo_total_s != null ? n("⌛ Tempo assistido", U.numero(Math.round(p.tempo_total_s / 60)) + " min") : ""}
          </div>
          <h3 class="bloco-titulo" style="margin-top:18px">👁️ Alcance da conta perto do dia da publicação</h3>
          <div class="grafico" style="height:180px"><canvas id="pd-graf"></canvas></div>
          ${p.formato === "REELS" ? '<p class="muted pequeno" style="margin-top:8px">A Meta informa o tempo assistido, mas não a duração do vídeo. Compare a retenção com o tamanho do seu reel.</p>' : ""}
        </div></div>`,
    });
    const dia = diaSP(p.timestamp);
    const serie = [...(caches.get(90)?.payload?.serie?.alcance || []), ...(dados?.serie?.alcance || [])];
    const unicos = [...new Map(serie.map((x) => [x.dia, x])).values()].sort((a, b) => a.dia.localeCompare(b.dia));
    const ini = diaSP(new Date(p.timestamp).getTime() - 7 * DIA), fim = diaSP(new Date(p.timestamp).getTime() + 7 * DIA);
    requestAnimationFrame(() => grafico(m.corpo.querySelector("#pd-graf"), unicos.filter((x) => x.dia >= ini && x.dia <= fim), { marcar: dia }));
  }

  // =====================================================================
  // Comentários
  // =====================================================================
  async function carregarComentarios() {
    const { data } = await sb.from("ig_commenter_cache").select("*").eq("id", "atual").maybeSingle();
    desenharComentarios(data);
    clearTimeout(pollComentarios);
    if (data?.status === "processando") pollComentarios = setTimeout(carregarComentarios, 4000);
  }

  function desenharComentarios(c) {
    const st = $("i-c-status");
    const btn = $("i-c-atualizar");
    btn.disabled = c?.status === "processando";
    btn.textContent = c?.status === "processando" ? "⏳ Analisando..." : "🔄 Baixar e analisar";
    if (!c || c.status === "vazio") st.textContent = "Ainda não analisado. Clique em Baixar e analisar.";
    else if (c.status === "processando") st.textContent = "Baixando e analisando em segundo plano. Pode continuar usando o painel.";
    else if (c.status === "erro") st.innerHTML = `<span style="color:var(--erro)">❌ ${U.esc(c.erro || "Deu erro.")}</span>`;
    else st.textContent = `Analisado em ${U.dataHora(c.generated_at)} · ${U.numero(c.payload?.comentarios)} comentários em ${U.numero(c.payload?.posts)} posts`;

    const p = c?.payload || {};
    $("i-c-temas").innerHTML = p.aviso ? `<p class="muted pequeno">${U.esc(p.aviso)}</p>` : (p.temas || []).length
      ? (p.temas || []).map((t) => `<div class="tema"><div class="linha" style="justify-content:space-between"><strong>${U.esc(t.tema)}</strong><span class="badge badge-info sem-ponto">~${U.numero(t.quantidade)}</span></div>
          <p class="muted pequeno">${U.esc(t.resumo)}</p>${(t.exemplos || []).map((e) => `<div class="citacao">“${U.esc(e)}”</div>`).join("")}</div>`).join("")
      : '<p class="muted pequeno">Nada por aqui ainda.</p>';
    $("i-c-fas").innerHTML = (p.top_fas || []).length
      ? `<ol class="lista-fas">${p.top_fas.map((f) => `<li><a href="https://instagram.com/${encodeURIComponent(f.username)}" target="_blank" rel="noopener">@${U.esc(f.username)}</a><span class="muted pequeno">${U.numero(f.comentarios)} comentários</span></li>`).join("")}</ol>`
      : '<p class="muted pequeno">Nada por aqui ainda.</p>';
    const perg = p.perguntas || [];
    $("i-c-perguntas").innerHTML = perg.length ? perg.map((q) => `<div class="card pergunta ${q.destaque ? "destaque" : ""}">
        <div class="linha" style="justify-content:space-between"><a href="https://instagram.com/${encodeURIComponent(q.username)}" target="_blank" rel="noopener"><strong>@${U.esc(q.username)}</strong></a>
          ${q.destaque ? '<span class="badge badge-aviso sem-ponto">⭐ vale responder</span>' : `<span class="muted pequeno">${U.data(q.timestamp)}</span>`}</div>
        <p>“${U.esc(q.texto)}”</p>
        ${q.por_que ? `<p class="muted pequeno">💡 ${U.esc(q.por_que)}</p>` : ""}
        <div class="muted pequeno">no post: ${U.esc(legenda(q.post, 50))}</div>
        <div class="linha">
          <a class="btn btn-secundario btn-p" href="${U.esc(q.permalink)}" target="_blank" rel="noopener">↗️ Abrir no Instagram</a>
          <button class="btn btn-primario btn-p" data-responder="${U.esc(q.comment_id)}">💬 Responder no comentário</button>
        </div></div>`).join("")
      : `<div class="vazio" style="grid-column:1/-1"><div class="vazio-emoji">🎉</div><h3>Nenhuma pergunta sem resposta.</h3><p>Ou ainda não analisamos. Clique em Baixar e analisar.</p></div>`;
    $("i-c-perguntas")._lista = perg;
  }

  function responder(id) {
    const q = ($("i-c-perguntas")._lista || []).find((x) => x.comment_id === id);
    if (!q) return;
    const m = U.modal({
      titulo: `💬 Responder @${q.username}`,
      html: `<div class="citacao" style="margin-bottom:12px">“${U.esc(q.texto)}”</div>
        <div class="campo"><label>Sua resposta (aparece embaixo do comentário, em público)</label>
        <textarea class="textarea" id="rp-texto">${U.esc(q.sugestao || "")}</textarea></div>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "📤 Responder", classe: "btn-primario", acao: async (fechar, btn) => {
          const texto = m.corpo.querySelector("#rp-texto").value.trim();
          if (!texto) return U.toast("Escreva a resposta.", "aviso");
          try {
            await U.comCarregando(btn, () => U.chamarFunction("ig-comments", { acao: "responder", comment_id: id, texto }));
            fechar(); U.toast("Respondido ✓"); carregarComentarios();
          } catch (e) { U.toast(e.message, "erro"); }
        } },
      ],
    });
  }

  // =====================================================================
  // Revisão do dia
  // =====================================================================
  let revisoes = [];
  async function carregarRevisao() {
    const { data } = await sb.from("ig_review_cache").select("*").order("dia", { ascending: false }).limit(30);
    revisoes = data || [];
    desenharRevisao(revisoes[0]);
    U.tabela($("i-r-hist"), {
      linhas: revisoes,
      vazio: "Nenhuma revisão ainda.",
      colunas: [
        { campo: "dia", titulo: "Dia", render: (r) => U.data(r.dia + "T12:00") },
        { titulo: "Resumo", ordenavel: false, render: (r) => r.review ? U.esc(legenda((r.review.acoes || [])[0], 90)) : `<span class="muted">${U.esc(legenda(r.erro, 80))}</span>` },
        { titulo: "", ordenavel: false, render: (r) => `<button class="btn btn-fantasma btn-p" data-ver-revisao="${r.dia}">👀 Ver</button>` },
      ],
    });
  }

  function desenharRevisao(r) {
    const el = $("i-r-hoje");
    if (!r) {
      el.innerHTML = `<div class="vazio"><div class="vazio-emoji">📝</div><h3>Nenhuma revisão ainda.</h3><p>Ela roda sozinha às 11h. Ou clique em Refazer pra gerar agora.</p></div>`;
      return;
    }
    const f = r.facts || {};
    const s = f.semana || {};
    const bloco = (emoji, titulo, itens) => `<div class="card revisao-bloco"><h3 class="bloco-titulo">${emoji} ${titulo}</h3>${
      Array.isArray(itens) ? `<ul>${itens.map((i) => `<li>${U.esc(i)}</li>`).join("")}</ul>` : `<p>${U.esc(itens || "-")}</p>`}</div>`;
    const numeros = `<div class="grade grade-numeros" style="margin-bottom:16px">
      <div class="card card-numero"><div class="rotulo">👁️ Alcance ontem</div><div class="numero">${curto(f.alcance_ontem)}</div></div>
      <div class="card card-numero"><div class="rotulo">📆 Alcance na semana</div><div class="numero">${curto(s.cards?.alcance)}</div>
        <div class="variacao">${s.variacao_pct == null ? "" : `<span style="color:var(${s.variacao_pct >= 0 ? "--ok" : "--erro"})">${s.variacao_pct > 0 ? "+" : ""}${pct(s.variacao_pct)}</span> vs semana anterior`}</div></div>
      <div class="card card-numero"><div class="rotulo">🖼️ Posts na semana</div><div class="numero">${U.numero(s.posts ?? 0)}</div>
        <div class="variacao">${f.dias_sem_postar != null ? `último post há ${f.dias_sem_postar} ${f.dias_sem_postar === 1 ? "dia" : "dias"}` : ""}</div></div>
      <div class="card card-numero"><div class="rotulo">👥 Seguidores na semana</div><div class="numero">${sinal(s.cards?.seguidores_var) || "-"}</div></div></div>`;
    el.innerHTML = `<div class="muted pequeno" style="margin-bottom:12px">Revisão de ${U.data(r.dia + "T12:00")} · gerada em ${U.dataHora(r.created_at)}</div>` + numeros +
      (r.review ? `<div class="grade revisao-grade">
        ${bloco("✅", "O que funcionou", r.review.funcionou)}
        ${bloco("⚠️", "O que não funcionou", r.review.nao_funcionou)}
        ${bloco("🪝", "Ganchos que seguraram", r.review.ganchos)}
        ${bloco("🕐", "Melhores horários", r.review.horarios)}
        <div class="card revisao-bloco revisao-acoes"><h3 class="bloco-titulo">🚀 3 ações pra hoje</h3><ol>${(r.review.acoes || []).map((a) => `<li>${U.esc(a)}</li>`).join("")}</ol></div>
      </div>` : `<div class="aviso info">🤖 ${U.esc(r.erro || "Sem interpretação da IA nesse dia.")} ${/ANTHROPIC/.test(r.erro || "") ? '<button class="btn btn-fantasma btn-p" data-ir-aba="configuracoes">⚙️ Ver integrações</button>' : ""}</div>`);
  }

  async function refazerRevisao(btn) {
    try {
      const r = await U.comCarregando(btn, () => U.chamarFunction("ig-review", {}));
      U.toast(r.ok ? "Revisão pronta ✓" : (r.erro || "Revisão feita só com os números."), r.ok ? "ok" : "aviso", 5000);
    } catch (e) { U.toast(e.message, "erro"); }
    carregarRevisao();
  }

  // =====================================================================
  // Concorrentes
  // =====================================================================
  async function carregarConcorrentes() {
    const [{ data: lista }, { data: fotos }] = await Promise.all([
      sb.from("ig_competitors").select("*").order("created_at"),
      sb.from("ig_competitor_snapshots").select("*").gte("dia", diaSP(Date.now() - 40 * DIA)).order("dia", { ascending: false }),
    ]);
    const porUser = new Map();
    (fotos || []).forEach((f) => { if (!porUser.has(f.username)) porUser.set(f.username, []); porUser.get(f.username).push(f); });
    const semanaAtras = diaSP(Date.now() - 7 * DIA);

    const cards = (lista || []).map((c) => {
      const fs = porUser.get(c.username) || [];
      const ult = fs[0];
      const antiga = fs.find((f) => f.dia <= semanaAtras && f.payload?.followers != null);
      const p = ult?.payload || {};
      const media = p.media || [];
      const recentes = media.filter((m) => Date.now() - new Date(m.timestamp).getTime() < 30 * DIA).length;
      const variacao = antiga && p.followers != null ? p.followers - antiga.payload.followers : null;
      return { c, ult, p, media, ritmo: Math.round((recentes / 30) * 7 * 10) / 10, variacao };
    });

    // O que mais deu certo essa semana entre todos
    const semana = cards.flatMap((x) => x.media.filter((m) => Date.now() - new Date(m.timestamp).getTime() < 7 * DIA).map((m) => ({ ...m, username: x.c.username })))
      .sort((a, b) => ((b.likes || 0) + (b.comments || 0) * 3) - ((a.likes || 0) + (a.comments || 0) * 3)).slice(0, 5);
    $("i-k-destaque").innerHTML = semana.length ? `<div class="card"><h3 class="bloco-titulo">🔥 O que eles postaram que mais deu certo essa semana</h3>
      <div class="grade grade-top">${semana.map((m) => `<a class="card post-card" href="${U.esc(m.permalink)}" target="_blank" rel="noopener">${capaHTML(m, "post-capa")}
        <div class="post-card-corpo"><strong class="pequeno">@${U.esc(m.username)}</strong><div class="pequeno">${U.esc(legenda(m.caption, 60))}</div>
        <div class="post-numeros"><span>❤️ ${curto(m.likes)}</span><span>💬 ${curto(m.comments)}</span></div></div></a>`).join("")}</div></div>` : "";

    $("i-k-grade").innerHTML = cards.length ? cards.map(({ c, ult, p, media, ritmo, variacao }) => `<div class="card concorrente">
        <div class="linha" style="flex-wrap:nowrap">
          ${p.foto ? `<img class="avatar-img" src="${U.esc(p.foto)}" alt="" referrerpolicy="no-referrer">` : '<div class="avatar">👤</div>'}
          <div style="min-width:0;flex:1"><a href="https://instagram.com/${encodeURIComponent(c.username)}" target="_blank" rel="noopener"><strong>@${U.esc(c.username)}</strong></a>
            <div class="muted pequeno">${U.esc(p.nome || "")}</div></div>
          <button class="btn btn-perigo btn-p" data-remover-conc="${U.esc(c.username)}" aria-label="Parar de acompanhar">🗑️</button>
        </div>
        ${ult?.erro ? `<div class="aviso erro pequeno">${U.esc(ult.erro)}</div>` : !ult ? '<p class="muted pequeno">Ainda sem foto. Clique em Atualizar todos.</p>' : `
        <div class="mini-numeros">
          <div class="mini-numero"><span>👥 Seguidores</span><strong>${curto(p.followers)}</strong>${variacao != null ? `<em style="color:var(${variacao >= 0 ? "--ok" : "--erro"})">${sinal(variacao)} na semana</em>` : ""}</div>
          <div class="mini-numero"><span>📅 Ritmo</span><strong>${ritmo.toLocaleString("pt-BR")}/sem</strong></div>
          <div class="mini-numero"><span>🖼️ Posts</span><strong>${curto(p.media_count)}</strong></div>
        </div>
        <div class="posts-grade">${media.map((m) => `<a class="post-mini" href="${U.esc(m.permalink)}" target="_blank" rel="noopener" title="${U.esc(legenda(m.caption, 120))}">${capaHTML(m, "thumb-cheio")}
          <span class="post-mini-num">❤️ ${curto(m.likes)} · 💬 ${curto(m.comments)}</span></a>`).join("")}</div>
        <div class="muted pequeno">foto de ${U.data(ult.dia + "T12:00")}</div>`}
      </div>`).join("")
      : `<div class="vazio" style="grid-column:1/-1"><div class="vazio-emoji">🔭</div><h3>Ninguém sendo acompanhado.</h3><p>Que tal cadastrar 2 perfis que você admira? Precisa ser conta profissional pública.</p></div>`;
  }

  async function adicionarConcorrente(e) {
    e.preventDefault();
    const u = $("i-k-user").value.replace(/^@/, "").trim().toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u)) return U.toast("Digite um @ válido.", "aviso");
    const { count } = await sb.from("ig_competitors").select("username", { count: "exact", head: true });
    if ((count || 0) >= 10) return U.toast("Limite de 10 perfis. Remova um pra adicionar outro.", "aviso");
    const btn = e.submitter;
    try {
      await U.comCarregando(btn, async () => {
        const { error } = await sb.from("ig_competitors").upsert({ username: u });
        if (error) throw error;
        const r = await U.chamarFunction("ig-competitors", { username: u });
        const res = r.resultados?.[0];
        if (res && !res.ok) U.toast(res.erro, "aviso", 6000); else U.toast(`@${u} adicionado ✓`);
      });
      $("i-k-user").value = "";
    } catch (err) { U.toast(err.message, "erro"); }
    carregarConcorrentes();
  }

  // =====================================================================
  // Objetivos + calendário
  // =====================================================================
  let objetivos = [];
  async function carregarObjetivos() {
    const { data } = await sb.from("ig_objetivos").select("*").order("created_at");
    objetivos = data || [];
    desenharObjetivos();
  }

  function valorAtual(tipo) {
    const c30 = caches.get(30)?.payload;
    const posts = postsDoCalendario();
    if (tipo === "seguidores") return (dados || c30)?.cards?.seguidores ?? null;
    if (tipo === "views_mes") return c30?.cards?.views ?? null;
    if (tipo === "posts_semana") return posts.filter((p) => Date.now() - new Date(p.timestamp).getTime() < 7 * DIA).length;
    return null;
  }

  function desenharObjetivos() {
    if (!secao) return;
    $("i-o-lista").innerHTML = objetivos.length ? objetivos.map((o) => {
      const atual = valorAtual(o.tipo);
      const p = atual == null || !o.alvo ? 0 : Math.min(100, Math.round((atual / o.alvo) * 100));
      const falta = o.prazo ? Math.ceil((new Date(o.prazo + "T23:59").getTime() - Date.now()) / DIA) : null;
      return `<div class="card">
        <div class="linha" style="justify-content:space-between"><strong>${U.esc(o.titulo || OBJ[o.tipo].nome)}</strong>
          <div class="linha">${p >= 100 ? '<span class="badge badge-ok">batida 🎉</span>' : ""}<button class="btn btn-perigo btn-p" data-apagar-obj="${o.id}">🗑️</button></div></div>
        <div class="barra"><div class="barra-cheia" style="width:${p}%"></div></div>
        <div class="linha muted pequeno" style="justify-content:space-between"><span>${atual == null ? "sem dado ainda" : `${U.numero(atual)} de ${U.numero(o.alvo)} ${OBJ[o.tipo].unidade}`} (${p}%)</span>
          <span>${falta == null ? "" : falta < 0 ? "prazo passou" : `faltam ${falta} dias`}</span></div></div>`;
    }).join("") : `<div class="vazio"><div class="vazio-emoji">🎯</div><h3>Nenhuma meta.</h3><p>Que tal uma meta de seguidores pro fim do mês? Ela se atualiza sozinha com os dados.</p></div>`;
  }

  function novaMeta() {
    const m = U.modal({
      titulo: "🎯 Nova meta",
      html: `<div class="form-grade">
        <div class="campo inteiro"><label>Tipo</label><select class="select" id="mt-tipo">${Object.entries(OBJ).map(([k, v]) => `<option value="${k}">${v.nome}</option>`).join("")}</select></div>
        <div class="campo"><label>Alvo</label><input class="input" type="number" min="1" id="mt-alvo" placeholder="Ex.: 2000"></div>
        <div class="campo"><label>Prazo (opcional)</label><input class="input" type="date" id="mt-prazo"></div>
        <div class="campo inteiro"><label>Nome (opcional)</label><input class="input" id="mt-titulo" placeholder="Ex.: 2 mil seguidores até dezembro"></div></div>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "💾 Salvar", classe: "btn-primario", acao: async (fechar, btn) => {
          const alvo = Number(m.corpo.querySelector("#mt-alvo").value);
          if (!alvo || alvo <= 0) return U.toast("Defina o alvo.", "aviso");
          try {
            await U.comCarregando(btn, async () => {
              const { error } = await sb.from("ig_objetivos").insert({
                tipo: m.corpo.querySelector("#mt-tipo").value, alvo,
                prazo: m.corpo.querySelector("#mt-prazo").value || null, titulo: m.corpo.querySelector("#mt-titulo").value.trim() || null,
              });
              if (error) throw error;
            });
            fechar(); U.toast("Salvo ✓"); carregarObjetivos();
          } catch (e) { U.toast(e.message, "erro"); }
        } },
      ],
    });
  }

  function desenharCalendario() {
    if (!mesCal) { const [Y, M] = U.spInput().split("-").map(Number); mesCal = { Y, M }; }
    const { Y, M } = mesCal;
    const nomes = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
    $("i-o-mes").textContent = `${nomes[M - 1]} de ${Y}`;
    const porDia = new Map();
    postsDoCalendario().forEach((p) => { const d = diaSP(p.timestamp); porDia.set(d, (porDia.get(d) || 0) + 1); });
    const primeiro = new Date(Date.UTC(Y, M - 1, 1)).getUTCDay();
    const total = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    const hoje = U.spInput().slice(0, 10);
    const z = (n) => String(n).padStart(2, "0");
    let html = ["D", "S", "T", "Q", "Q", "S", "S"].map((d) => `<div class="cal-cab">${d}</div>`).join("");
    for (let i = 0; i < primeiro; i++) html += "<div></div>";
    for (let d = 1; d <= total; d++) {
      const chave = `${Y}-${z(M)}-${z(d)}`;
      const n = porDia.get(chave) || 0;
      html += `<div class="cal-dia ${n ? "postou" : ""} ${chave === hoje ? "hoje" : ""}" title="${n ? `${n} post${n > 1 ? "s" : ""}` : ""}">${d}${n > 1 ? `<small>${n}</small>` : ""}</div>`;
    }
    const noMes = [...porDia.entries()].filter(([k]) => k.startsWith(`${Y}-${z(M)}`)).reduce((s, [, n]) => s + n, 0);
    $("i-o-cal").innerHTML = html + `<div class="cal-rodape muted pequeno">${noMes} ${noMes === 1 ? "post" : "posts"} nesse mês</div>`;
  }

  // =====================================================================
  // Sub-abas e eventos
  // =====================================================================
  function irSub(nome) {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.classList.toggle("ativo", b.dataset.sub === nome));
    secao.querySelectorAll(".subaba").forEach((s) => s.classList.toggle("ativa", s.dataset.sub === nome));
    U.guardar.gravar(CHAVE_SUB, nome);
    if (nome === "visao") requestAnimationFrame(desenharGraficos);
    if (nome === "comentarios") carregarComentarios();
    if (nome === "revisao") carregarRevisao();
    if (nome === "concorrentes") carregarConcorrentes();
    if (nome === "objetivos") { carregarObjetivos(); desenharCalendario(); }
  }

  function ligarEventos() {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.addEventListener("click", () => irSub(b.dataset.sub)));
    $("i-periodo").addEventListener("click", (e) => {
      const b = e.target.closest("[data-dias]");
      if (!b) return;
      dias = Number(b.dataset.dias);
      U.guardar.gravar(CHAVE_DIAS, String(dias));
      $("i-periodo").querySelectorAll("button").forEach((x) => x.classList.toggle("ativo", x === b));
      atualizar(false);
    });
    $("i-atualizar").addEventListener("click", (e) => atualizar(true, e.currentTarget));
    $("i-pago-novo").addEventListener("click", novoPago);
    $("i-pagos").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-apagar-pago]");
      if (!b || !(await U.confirmar("Apagar esse período pago?", { perigo: true, ok: "Apagar" }))) return;
      await sb.from("ig_periodos_pagos").delete().eq("id", b.dataset.apagarPago);
      await carregarPagos(); desenharTudo();
    });
    secao.addEventListener("click", (e) => {
      const p = e.target.closest("[data-post]");
      if (p) abrirPost(p.dataset.post);
    });
    $("i-p-busca").addEventListener("input", desenharPosts);
    $("i-p-formato").addEventListener("change", desenharPosts);
    $("i-p-tabela").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-i]");
      if (!tr) return;
      const busca = U.semAcento($("i-p-busca").value), fmt = $("i-p-formato").value;
      const linhas = (dados?.posts || []).filter((p) => (!fmt || p.formato === fmt) && (!busca || U.semAcento(p.caption).includes(busca)));
      const p = linhas[Number(tr.dataset.i)];
      if (p) abrirPost(p.id);
    });

    $("i-c-atualizar").addEventListener("click", async (e) => {
      try {
        await U.comCarregando(e.currentTarget, () => U.chamarFunction("ig-comments", { acao: "atualizar" }));
        carregarComentarios();
      } catch (err) { U.toast(err.message, "erro"); }
    });
    $("i-c-perguntas").addEventListener("click", (e) => {
      const b = e.target.closest("[data-responder]");
      if (b) responder(b.dataset.responder);
    });

    $("i-r-refazer").addEventListener("click", (e) => refazerRevisao(e.currentTarget));
    $("i-r-hist").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ver-revisao]");
      if (b) { desenharRevisao(revisoes.find((r) => r.dia === b.dataset.verRevisao)); $("i-r-hoje").scrollIntoView({ behavior: "smooth" }); }
    });

    $("i-k-form").addEventListener("submit", adicionarConcorrente);
    $("i-k-atualizar").addEventListener("click", async (e) => {
      try {
        await U.comCarregando(e.currentTarget, () => U.chamarFunction("ig-competitors", { acao: "atualizar" }));
        U.toast("Concorrentes atualizados ✓");
      } catch (err) { U.toast(err.message, "erro"); }
      carregarConcorrentes();
    });
    $("i-k-grade").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-remover-conc]");
      if (!b || !(await U.confirmar(`Parar de acompanhar @${b.dataset.removerConc}?`, { perigo: true, ok: "Parar" }))) return;
      await sb.from("ig_competitors").delete().eq("username", b.dataset.removerConc);
      carregarConcorrentes();
    });

    $("i-o-nova").addEventListener("click", novaMeta);
    $("i-o-lista").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-apagar-obj]");
      if (!b || !(await U.confirmar("Apagar essa meta?", { perigo: true, ok: "Apagar" }))) return;
      await sb.from("ig_objetivos").delete().eq("id", b.dataset.apagarObj);
      carregarObjetivos();
    });
    const mudarMes = (d) => { let { Y, M } = mesCal; M += d; if (M < 1) { M = 12; Y--; } if (M > 12) { M = 1; Y++; } mesCal = { Y, M }; desenharCalendario(); };
    $("i-o-ant").addEventListener("click", () => mudarMes(-1));
    $("i-o-prox").addEventListener("click", () => mudarMes(1));

    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (secao.classList.contains("ativa")) desenharGraficos(); }, 150); });
  }

  window.ABAS = window.ABAS || {};
  window.ABAS.instagram = {
    async iniciar(el) {
      secao = el;
      dias = Number(U.guardar.ler(CHAVE_DIAS, "30"));
      if (![0, 7, 30, 90].includes(dias)) dias = 30;
      $("i-periodo").querySelectorAll("button").forEach((x) => x.classList.toggle("ativo", Number(x.dataset.dias) === dias));
      ligarEventos();
      irSub(U.guardar.ler(CHAVE_SUB, "visao"));
      try {
        await Promise.all([lerCaches(), carregarPagos(), carregarObjetivos()]);
      } catch (e) { aviso("⚠️ " + U.esc(e.message), "erro"); }
      atualizar(false);
    },
    mostrar() {
      if (dados) requestAnimationFrame(desenharGraficos);
    },
  };

  // Usado pela aba 💡 Criativos (variações de um post que bombou)
  window.IG_DADOS = { posts: () => postsDoCalendario().length ? postsDoCalendario() : (dados?.posts || []), caches };
})();
