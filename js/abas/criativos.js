// Aba 💡 Criativos: quadro de ideias (kanban), editor com roteiro, minha voz, carrossel e roteiros de referência.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CHAVE_SUB = "admin:criativos:sub";
  const STATUS = [
    ["ideia", "💭 Ideia"], ["roteirizando", "✍️ Roteirizando"], ["gravado", "🎥 Gravado"], ["editado", "✂️ Editado"], ["postado", "✅ Postado"],
  ];
  const FORMATO = { reel: "🎬 Reel", carrossel: "🗂️ Carrossel", story: "📱 Story", foto: "🖼️ Foto", live: "🔴 Live" };
  const EMOJI_FMT = { reel: "🎬", carrossel: "🗂️", story: "📱", foto: "🖼️", live: "🔴" };
  const CENAS = [["gancho", "🪝 Gancho"], ["contexto", "🧭 Contexto"], ["virada", "🔄 Virada"], ["prova", "📊 Prova"], ["cta", "📣 CTA"]];
  const CHECK = [["cenario", "Cenário"], ["roupa", "Roupa"], ["broll", "B-roll"], ["cta", "CTA gravado"]];
  const OBJ_ROTULO = { crescer: "🌱 crescer", engajar: "💬 engajar", vender: "💰 vender" };
  const PPS = 2.5; // palavras por segundo na fala normal

  let secao;
  let ideias = [];
  let roteiros = [];
  let carrosseis = [];
  let carrossel = null;
  let pollRoteiros = null;
  let pollEstudo = null;

  // =====================================================================
  // Utilidades
  // =====================================================================
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const linhas = (t) => String(t || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const virgulas = (t) => String(t || "").split(",").map((x) => x.trim()).filter(Boolean);
  const palavras = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;
  const duracao = (r) => {
    const n = CENAS.reduce((s, [c]) => s + palavras(r?.[c]), 0);
    return { n, s: Math.round(n / PPS) };
  };
  const textoRoteiro = (i) => [i.titulo, "", ...CENAS.map(([c, rot]) => `${rot.replace(/^\S+\s/, "").toUpperCase()}\n${i.roteiro?.[c] || "-"}`)].join("\n\n");
  const corte = (t, n) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

  // =====================================================================
  // Quadro (kanban)
  // =====================================================================
  async function carregarIdeias() {
    const { data, error } = await sb.from("ideias").select("*").order("favorita", { ascending: false }).order("ordem").order("created_at", { ascending: false });
    if (error) return U.toast(error.message, "erro");
    ideias = data || [];
    const tags = [...new Set(ideias.flatMap((i) => i.tags || []))].sort();
    const sel = $("c-f-tag"), atual = sel.value;
    sel.innerHTML = '<option value="">Todas as tags</option>' + tags.map((t) => `<option value="${U.esc(t)}">#${U.esc(t)}</option>`).join("");
    sel.value = tags.includes(atual) ? atual : "";
    desenharKanban();
  }

  function filtradas() {
    const b = U.semAcento($("c-busca").value), f = $("c-f-formato").value, t = $("c-f-tag").value;
    return ideias.filter((i) => (!f || i.formato === f) && (!t || (i.tags || []).includes(t)) &&
      (!b || U.semAcento(`${i.titulo} ${i.descricao || ""} ${(i.tags || []).join(" ")}`).includes(b)));
  }

  function desenharKanban() {
    const lista = filtradas();
    $("c-kanban").innerHTML = STATUS.map(([st, rot]) => {
      const col = lista.filter((i) => i.status === st).sort((a, b) => Number(b.favorita) - Number(a.favorita) || a.ordem - b.ordem);
      return `<div class="kanban-coluna" data-coluna="${st}">
        <div class="kanban-cab"><strong>${rot}</strong><span class="badge badge-info sem-ponto">${col.length}</span></div>
        <div class="kanban-lista">${col.map(cardIdeia).join("") || `<div class="kanban-vazio">${st === "ideia" ? "Que tal anotar aquela ideia de ontem? 💭" : "Arraste um card pra cá"}</div>`}</div>
      </div>`;
    }).join("");
  }

  function cardIdeia(i) {
    const d = duracao(i.roteiro);
    return `<div class="ideia-card" draggable="true" data-ideia="${i.id}">
      ${i.capa_url ? `<img class="ideia-capa" src="${U.esc(i.capa_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
      <div class="linha" style="justify-content:space-between;flex-wrap:nowrap;align-items:flex-start">
        <strong class="ideia-titulo">${EMOJI_FMT[i.formato] || "💡"} ${U.esc(i.titulo)}</strong>
        <button class="estrela ${i.favorita ? "on" : ""}" data-fav="${i.id}" aria-label="Favorita">${i.favorita ? "★" : "☆"}</button>
      </div>
      <div class="chips">${(i.tags || []).map((t) => `<span class="tag">#${U.esc(t)}</span>`).join("")}
        ${d.n ? `<span class="muted pequeno">⏱️ ~${d.s}s</span>` : ""}${i.origem === "ia" || i.origem === "comentarios" ? '<span class="muted pequeno">✨</span>' : ""}</div>
    </div>`;
  }

  async function moverIdeia(id, status) {
    const i = ideias.find((x) => x.id === id);
    if (!i || i.status === status) return;
    const ordem = Math.max(0, ...ideias.filter((x) => x.status === status).map((x) => x.ordem || 0)) + 1;
    i.status = status; i.ordem = ordem;
    desenharKanban();
    const { error } = await sb.from("ideias").update({ status, ordem }).eq("id", id);
    if (error) { U.toast(error.message, "erro"); carregarIdeias(); }
    else if (status === "postado" && !i.post_url) marcarPostado(i);
  }

  async function alternarFavorita(id) {
    const i = ideias.find((x) => x.id === id);
    if (!i) return;
    i.favorita = !i.favorita;
    desenharKanban();
    await sb.from("ideias").update({ favorita: i.favorita }).eq("id", id);
  }

  // =====================================================================
  // Editor da ideia
  // =====================================================================
  function abrirEditor(id, base = null) {
    const i = id ? ideias.find((x) => x.id === id) : {
      titulo: "", formato: "reel", status: "ideia", tags: [], descricao: "", roteiro: {}, origem: "manual", ...(base || {}),
    };
    if (!i) return;
    const r = i.roteiro || {};
    const ck = r.checklist || {};
    const m = U.modal({
      titulo: id ? "✏️ Editar ideia" : "➕ Nova ideia",
      grande: true,
      html: `<div class="form-grade">
        <div class="campo inteiro"><label>Título</label><input class="input" id="ed-titulo" value="${U.esc(i.titulo)}" placeholder="Ex.: 3 erros que eu cometi no primeiro ano"></div>
        <div class="campo"><label>Formato</label><select class="select" id="ed-formato">${Object.entries(FORMATO).map(([k, v]) => `<option value="${k}" ${i.formato === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="campo"><label>Status</label><select class="select" id="ed-status">${STATUS.map(([k, v]) => `<option value="${k}" ${i.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="campo"><label>Tags</label><input class="input" id="ed-tags" value="${U.esc((i.tags || []).join(", "))}" placeholder="separadas por vírgula"></div>
        <div class="campo"><label>Agendado pra (opcional)</label><input class="input" type="datetime-local" id="ed-agenda" value="${i.agendado_para ? toLocal(i.agendado_para) : ""}"></div>
        <div class="campo inteiro"><label>Descrição</label><textarea class="textarea" id="ed-desc" style="min-height:70px">${U.esc(i.descricao || "")}</textarea></div>
        <div class="campo inteiro"><label>Capa (link da imagem, opcional)</label><input class="input" id="ed-capa" value="${U.esc(i.capa_url || "")}" placeholder="https://..."></div>
      </div>
      <div class="linha" style="justify-content:space-between;margin:20px 0 10px">
        <h3 class="bloco-titulo" style="margin:0">🎬 Roteiro cena a cena</h3>
        <span class="badge badge-cor sem-ponto" id="ed-duracao">⏱️ 0s</span>
      </div>
      <div class="cenas">${CENAS.map(([c, rot]) => `<div class="campo"><label>${rot}</label><textarea class="textarea cena" data-cena="${c}" style="min-height:64px">${U.esc(r[c] || "")}</textarea></div>`).join("")}</div>
      <h3 class="bloco-titulo" style="margin:18px 0 10px">✅ Checklist de gravação</h3>
      <div class="linha">${CHECK.map(([c, rot]) => `<label class="check"><input type="checkbox" data-check="${c}" ${ck[c] ? "checked" : ""}> ${rot}</label>`).join("")}</div>
      ${i.post_url ? `<p class="pequeno" style="margin-top:14px">✅ Postado: <a href="${U.esc(i.post_url)}" target="_blank" rel="noopener">${U.esc(i.post_url)}</a></p>` : ""}`,
      botoes: [
        ...(id ? [{ texto: "🗑️ Apagar", classe: "btn-perigo", acao: async (fechar) => {
          if (!(await U.confirmar("Apagar essa ideia?", { perigo: true, ok: "Apagar" }))) return;
          await sb.from("ideias").delete().eq("id", id); fechar(); carregarIdeias(); U.toast("Apagada");
        } }] : []),
        { texto: "📋 Copiar roteiro", classe: "btn-fantasma", acao: () => U.copiar(textoRoteiro(ler())) },
        { texto: "✨ Gerar roteiro com IA", classe: "btn-secundario", requer: "ia", acao: async (_f, btn) => {
          const d = ler();
          if (!d.titulo) return U.toast("Escreva o título primeiro.", "aviso");
          try {
            const res = await U.comCarregando(btn, () => U.chamarFunction("ideias-ia", { modo: "roteiro", titulo: d.titulo, descricao: d.descricao, formato: d.formato }));
            CENAS.forEach(([c]) => { m.corpo.querySelector(`[data-cena="${c}"]`).value = res.roteiro[c] || ""; });
            atualizarDuracao(); U.toast("Roteiro pronto ✓");
          } catch (e) { U.toast(e.message, "erro", 6000); }
        } },
        ...(id && i.status !== "postado" ? [{ texto: "✅ Marcar como postado", classe: "btn-secundario", acao: async (fechar) => {
          const ok = await salvar(); if (!ok) return; fechar(); marcarPostado(ideias.find((x) => x.id === id));
        } }] : []),
        { texto: "💾 Salvar", classe: "btn-primario", acao: async (fechar, btn) => { if (await U.comCarregando(btn, salvar)) fechar(); } },
      ],
    });

    function ler() {
      const q = (s) => m.corpo.querySelector(s);
      const rot = { ...(i.roteiro || {}) };
      m.corpo.querySelectorAll("[data-cena]").forEach((t) => { rot[t.dataset.cena] = t.value.trim(); });
      rot.checklist = Object.fromEntries([...m.corpo.querySelectorAll("[data-check]")].map((c) => [c.dataset.check, c.checked]));
      const d = duracao(rot);
      rot.palavras = d.n; rot.duracao_s = d.s;
      const ag = q("#ed-agenda").value;
      return {
        titulo: q("#ed-titulo").value.trim(), formato: q("#ed-formato").value, status: q("#ed-status").value,
        tags: virgulas(q("#ed-tags").value).map((t) => t.replace(/^#/, "").toLowerCase()), descricao: q("#ed-desc").value.trim() || null,
        capa_url: q("#ed-capa").value.trim() || null, agendado_para: ag ? U.spParaISO(ag) : null, roteiro: rot,
      };
    }
    function atualizarDuracao() {
      const d = duracao(ler().roteiro);
      m.corpo.querySelector("#ed-duracao").textContent = `⏱️ ~${d.s}s · ${d.n} palavras`;
    }
    async function salvar() {
      const d = ler();
      if (!d.titulo) { U.toast("A ideia precisa de um título.", "aviso"); return false; }
      const q = id ? sb.from("ideias").update(d).eq("id", id)
        : sb.from("ideias").insert({ ...d, origem: i.origem || "manual", estilo: i.estilo || null, ordem: Date.now() / 1e10 });
      const { error } = await q;
      if (error) { U.toast(error.message, "erro"); return false; }
      U.toast("Salvo ✓"); await carregarIdeias();
      return true;
    }
    m.corpo.addEventListener("input", (e) => { if (e.target.matches("[data-cena]")) atualizarDuracao(); });
    atualizarDuracao();
  }

  function toLocal(iso) {
    const d = new Date(iso);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: U.FUSO, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  function marcarPostado(i) {
    if (!i) return;
    const m = U.modal({
      titulo: "✅ Marcar como postado",
      html: `<div class="campo"><label>Link do post</label><input class="input" id="mp-link" placeholder="https://www.instagram.com/reel/..."></div>
        <p class="muted pequeno" style="margin-top:8px">Com o link, o painel liga essa ideia aos números do post na aba 📊 Instagram.</p>`,
      botoes: [
        { texto: "Agora não", classe: "btn-fantasma", acao: async (fechar) => {
          await sb.from("ideias").update({ status: "postado" }).eq("id", i.id); fechar(); carregarIdeias();
        } },
        { texto: "💾 Salvar", classe: "btn-primario", acao: async (fechar) => {
          const link = m.corpo.querySelector("#mp-link").value.trim();
          if (link && !/^https?:\/\//.test(link)) return U.toast("Cole o link completo.", "aviso");
          const cod = link.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1];
          const post = cod && window.IG_DADOS ? window.IG_DADOS.posts().find((p) => String(p.permalink || "").includes(cod)) : null;
          await sb.from("ideias").update({ status: "postado", post_url: link || null, media_id: post?.id || null,
            capa_url: i.capa_url || post?.capa || null }).eq("id", i.id);
          fechar(); U.toast("Postado ✓ 🎉"); carregarIdeias();
        } },
      ],
    });
  }

  // =====================================================================
  // ✨ Gerar ideias com IA
  // =====================================================================
  function gerarIdeias() {
    const posts = (window.IG_DADOS?.posts() || []).slice().sort((a, b) => (Number(b.reach) || 0) - (Number(a.reach) || 0)).slice(0, 40);
    let modo = "gerar";
    let geradas = [];
    const m = U.modal({
      titulo: "✨ Gerar ideias",
      grande: true,
      html: `<div class="segmentado" id="gi-modos" style="margin-bottom:16px">
          <button data-modo="gerar" class="ativo">🧠 Do meu perfil</button>
          <button data-modo="tema">🎯 A partir de um tema</button>
          <button data-modo="variacoes">🔁 Variações de um post</button></div>
        <div id="gi-entrada"></div>
        <div class="form-acoes" style="justify-content:flex-start;margin-top:12px"><button class="btn btn-primario" id="gi-ir">✨ Gerar 10 ideias</button>
          <span class="muted pequeno" style="align-self:center">Leva uns 30 segundos.</span></div>
        <div id="gi-res" style="margin-top:18px"></div>`,
      botoes: [
        { texto: "Fechar", classe: "btn-fantasma" },
        { texto: "💾 Guardar selecionadas", classe: "btn-primario", acao: async (fechar, btn) => {
          const sel = [...m.corpo.querySelectorAll("[data-guardar]:checked")].map((c) => geradas[Number(c.dataset.guardar)]);
          if (!sel.length) return U.toast("Marque pelo menos 1 ideia.", "aviso");
          await U.comCarregando(btn, async () => {
            const base = Date.now() / 1e10;
            const { error } = await sb.from("ideias").insert(sel.map((g, k) => ({
              titulo: g.titulo, descricao: `${g.por_que}\n\nGancho: “${g.gancho}”`, formato: g.formato, estilo: g.objetivo,
              tags: (g.tags || []).map((t) => String(t).replace(/^#/, "").toLowerCase()).slice(0, 4), origem: g.origem || "ia",
              roteiro: g.roteiro, ordem: base + k / 1e6,
            })));
            if (error) throw error;
          }).then(() => { fechar(); U.toast(`${sel.length} ${sel.length === 1 ? "ideia guardada" : "ideias guardadas"} ✓`); carregarIdeias(); })
            .catch((e) => U.toast(e.message, "erro"));
        } },
      ],
    });
    const entrada = () => {
      m.corpo.querySelector("#gi-entrada").innerHTML = modo === "gerar"
        ? '<p class="muted pequeno">Usa a sua voz (🎙️ Minha voz), os posts que mais deram certo (📊 Instagram) e as perguntas dos comentários.</p>'
        : modo === "tema" ? '<div class="campo"><label>Tema</label><input class="input" id="gi-tema" placeholder="Ex.: como organizar a rotina pra gravar 3 vídeos por semana"></div>'
          : posts.length ? `<div class="campo"><label>Post que bombou</label><select class="select" id="gi-post">${posts.map((p) =>
            `<option value="${U.esc(p.id)}">${U.data(p.timestamp)} · 👁️ ${U.numero(p.reach)} · ${U.esc(corte(p.caption, 70) || "(sem legenda)")}</option>`).join("")}</select></div>`
            : '<p class="muted pequeno">Carregue os posts na aba 📊 Instagram primeiro (botão Atualizar).</p>';
    };
    entrada();
    m.corpo.querySelector("#gi-modos").addEventListener("click", (e) => {
      const b = e.target.closest("[data-modo]"); if (!b) return;
      modo = b.dataset.modo;
      m.corpo.querySelectorAll("#gi-modos button").forEach((x) => x.classList.toggle("ativo", x === b));
      entrada();
    });
    m.corpo.querySelector("#gi-ir").addEventListener("click", async (e) => {
      const body = { modo };
      if (modo === "tema") { body.tema = m.corpo.querySelector("#gi-tema")?.value.trim(); if (!body.tema) return U.toast("Escreva o tema.", "aviso"); }
      if (modo === "variacoes") { body.media_id = m.corpo.querySelector("#gi-post")?.value; if (!body.media_id) return; }
      const res = m.corpo.querySelector("#gi-res");
      res.innerHTML = '<div class="esqueleto" style="height:160px"></div>';
      try {
        const r = await U.comCarregando(e.currentTarget, () => U.chamarFunction("ideias-ia", body));
        geradas = r.ideias || [];
        res.innerHTML = geradas.map((g, k) => `<div class="card ideia-gerada">
          <label class="check" style="align-items:flex-start"><input type="checkbox" data-guardar="${k}">
          <div style="flex:1;min-width:0">
            <div class="linha" style="justify-content:space-between"><strong>${EMOJI_FMT[g.formato] || "💡"} ${U.esc(g.titulo)}</strong>
              <span class="chips"><span class="badge badge-cor sem-ponto">${OBJ_ROTULO[g.objetivo] || g.objetivo}</span><span class="muted pequeno">⏱️ ~${g.roteiro?.duracao_s ?? "?"}s</span></span></div>
            <div class="citacao">🪝 “${U.esc(g.gancho)}”</div>
            <p class="muted pequeno">${U.esc(g.por_que)}</p>
            <details><summary class="pequeno">Ver roteiro</summary>${CENAS.map(([c, rot]) => `<p class="pequeno"><strong>${rot}:</strong> ${U.esc(g.roteiro?.[c] || "")}</p>`).join("")}</details>
          </div></label></div>`).join("") || '<p class="muted">A IA não devolveu ideias. Tente de novo.</p>';
      } catch (err) {
        res.innerHTML = `<div class="aviso erro">${U.esc(err.message)}</div>`;
      }
    });
  }

  // =====================================================================
  // 🎙️ Minha voz
  // =====================================================================
  async function carregarVoz() {
    const { data } = await sb.from("perfil_voz").select("*").eq("id", 1).maybeSingle();
    const v = data || {};
    $("c-v-tom").value = v.tom || "";
    $("c-v-publico").value = v.publico || "";
    $("c-v-pilares").value = (v.pilares || []).join("\n");
    $("c-v-expressoes").value = (v.expressoes || []).join("\n");
    $("c-v-evitar").value = (v.evitar || []).join("\n");
    $("c-v-objetivos").value = (v.objetivos || ["crescer", "engajar", "vender"]).join(", ");
    $("c-v-exemplos").value = (v.exemplos || []).join("\n---\n");
  }

  async function salvarVoz(e) {
    e?.preventDefault();
    const objetivos = virgulas($("c-v-objetivos").value).map((o) => U.semAcento(o)).filter((o) => ["crescer", "engajar", "vender"].includes(o));
    const { error } = await sb.from("perfil_voz").upsert({
      id: 1, tom: $("c-v-tom").value.trim() || null, publico: $("c-v-publico").value.trim() || null,
      pilares: linhas($("c-v-pilares").value), expressoes: linhas($("c-v-expressoes").value), evitar: linhas($("c-v-evitar").value),
      objetivos: [...new Set(objetivos)].length ? [...new Set(objetivos)] : ["crescer", "engajar", "vender"],
      exemplos: $("c-v-exemplos").value.split(/\n\s*-{3,}\s*\n/).map((x) => x.trim()).filter(Boolean),
      updated_at: new Date().toISOString(),
    });
    if (error) { U.toast(error.message, "erro"); return false; }
    U.toast("Salvo ✓");
    return true;
  }

  async function testarVoz(btn) {
    if (!(await salvarVoz())) return;
    const el = $("c-v-teste");
    el.innerHTML = '<div class="esqueleto" style="height:140px"></div>';
    try {
      const r = await U.comCarregando(btn, () => U.chamarFunction("ideias-ia", { modo: "voz" }));
      el.innerHTML = (r.legendas || []).map((l) => `<div class="citacao legenda-teste">${U.esc(l).replace(/\n/g, "<br>")}</div>`).join("") +
        '<p class="muted pequeno" style="margin-top:10px">Não soou como você? Ajuste o tom e cole mais exemplos seus. É o que mais ajuda.</p>';
    } catch (e) { el.innerHTML = `<div class="aviso erro">${U.esc(e.message)}</div>`; }
  }

  // =====================================================================
  // 🎠 Carrossel (canvas 1080x1350)
  // =====================================================================
  const W = 1080, H = 1350;
  const slideVazio = (modelo = "texto") => ({ modelo, titulo: "", texto: "", itens: [] });

  async function carregarCarrosseis() {
    const { data } = await sb.from("carrosseis").select("*").order("updated_at", { ascending: false });
    carrosseis = data || [];
    $("c-k-lista").innerHTML = carrosseis.length ? carrosseis.map((c) => `<button class="lista-item ${carrossel?.id === c.id ? "ativo" : ""}" data-carrossel="${c.id}">
        <strong>${U.esc(c.titulo)}</strong><span class="muted pequeno">${(c.slides || []).length} slides · ${U.data(c.updated_at)}</span></button>`).join("")
      : '<p class="muted pequeno">Nenhum carrossel salvo ainda.</p>';
    if (!carrossel) abrirCarrossel(null);
  }

  function abrirCarrossel(id) {
    const c = id ? carrosseis.find((x) => x.id === id) : null;
    carrossel = c ? JSON.parse(JSON.stringify(c)) : { titulo: "Carrossel sem título", slides: [{ ...slideVazio("capa") }, slideVazio("texto"), slideVazio("lista")] };
    desenharEditorCarrossel();
    $("c-k-lista").querySelectorAll("[data-carrossel]").forEach((b) => b.classList.toggle("ativo", b.dataset.carrossel === carrossel.id));
  }

  function desenharEditorCarrossel() {
    const c = carrossel;
    $("c-k-editor").innerHTML = `
      <div class="linha" style="margin-bottom:14px">
        <input class="input" id="ck-titulo" value="${U.esc(c.titulo)}" style="flex:1;min-width:200px;font-weight:600">
        <button class="btn btn-secundario btn-p" id="ck-ia" data-requer="ia">✨ Textos com IA</button>
        <button class="btn btn-secundario btn-p" id="ck-baixar">⬇️ Baixar PNGs</button>
        <button class="btn btn-primario btn-p" id="ck-salvar">💾 Salvar</button>
        ${c.id ? '<button class="btn btn-perigo btn-p" id="ck-apagar" aria-label="Apagar carrossel">🗑️</button>' : ""}
      </div>
      <div class="slides">${c.slides.map((s, k) => `<div class="slide-item" data-slide="${k}">
          <div class="slide-previa"><canvas width="${W}" height="${H}" data-previa="${k}"></canvas></div>
          <div class="slide-campos">
            <div class="linha" style="justify-content:space-between">
              <strong class="pequeno">Slide ${k + 1}</strong>
              <div class="linha" style="gap:4px">
                <select class="select select-p" data-campo="modelo">${[["capa", "🪝 Capa"], ["texto", "📝 Texto"], ["lista", "📋 Lista"]].map(([v, r]) => `<option value="${v}" ${s.modelo === v ? "selected" : ""}>${r}</option>`).join("")}</select>
                <button class="btn btn-fantasma btn-p" data-acao="subir" ${k === 0 ? "disabled" : ""} aria-label="Subir">↑</button>
                <button class="btn btn-fantasma btn-p" data-acao="descer" ${k === c.slides.length - 1 ? "disabled" : ""} aria-label="Descer">↓</button>
                <button class="btn btn-fantasma btn-p" data-acao="remover" aria-label="Remover">✕</button>
              </div>
            </div>
            <input class="input" data-campo="titulo" value="${U.esc(s.titulo)}" placeholder="${s.modelo === "capa" ? "Gancho grande da capa" : "Título do slide"}">
            <textarea class="textarea" data-campo="texto" style="min-height:70px" placeholder="Texto">${U.esc(s.texto)}</textarea>
            ${s.modelo === "lista" ? `<textarea class="textarea" data-campo="itens" style="min-height:90px" placeholder="1 item por linha">${U.esc((s.itens || []).join("\n"))}</textarea>` : ""}
          </div></div>`).join("")}
      </div>
      <button class="btn btn-secundario btn-bloco" id="ck-mais" style="margin-top:12px" ${c.slides.length >= 10 ? "disabled" : ""}>➕ Adicionar slide</button>`;
    desenharPrevias();
  }

  async function desenharPrevias() {
    await prepararFonte();
    $("c-k-editor").querySelectorAll("[data-previa]").forEach((cv) => desenharSlide(cv, carrossel.slides[Number(cv.dataset.previa)], Number(cv.dataset.previa), carrossel.slides.length));
  }

  let fontePronta = null;
  function prepararFonte() {
    if (!fontePronta) {
      const fam = css("--fonte");
      fontePronta = Promise.all([document.fonts.load(`700 80px ${fam}`), document.fonts.load(`400 40px ${fam}`), document.fonts.load(`600 40px ${fam}`)]).catch(() => null);
    }
    return fontePronta;
  }

  function quebrar(g, texto, max) {
    const out = [];
    String(texto || "").split("\n").forEach((par) => {
      let linha = "";
      par.split(/\s+/).filter(Boolean).forEach((p) => {
        const t = linha ? linha + " " + p : p;
        if (g.measureText(t).width > max && linha) { out.push(linha); linha = p; } else linha = t;
      });
      out.push(linha);
    });
    return out;
  }

  /** Escreve um bloco de texto que diminui a fonte até caber na altura. */
  function bloco(g, texto, { x, y, max, alturaMax, peso, tam, minTam = 28, cor, entrelinha = 1.2 }) {
    const fam = css("--fonte");
    let t = tam, ls;
    do { g.font = `${peso} ${t}px ${fam}`; ls = quebrar(g, texto, max); t -= 4; } while (ls.length * (t + 4) * entrelinha > alturaMax && t >= minTam);
    t += 4;
    g.fillStyle = cor; g.textBaseline = "top";
    ls.forEach((l, k) => g.fillText(l, x, y + k * t * entrelinha));
    return y + ls.length * t * entrelinha;
  }

  function desenharSlide(cv, s, k, total) {
    const g = cv.getContext("2d");
    const cor = css("--cor"), fundo = css("--fundo"), texto = css("--texto"), sobre = css("--cor-texto-sobre"), t2 = css("--texto-2"), fam = css("--fonte");
    const P = 96, larg = W - P * 2;
    const ig = window.APP_CONFIG?.INSTAGRAM ? "@" + String(window.APP_CONFIG.INSTAGRAM).replace(/^@/, "") : (window.APP_CONFIG?.NOME || "");
    g.textAlign = "left";
    if (s.modelo === "capa") {
      g.fillStyle = cor; g.fillRect(0, 0, W, H);
      g.fillStyle = sobre; g.globalAlpha = 0.12; g.beginPath(); g.arc(W - 120, 160, 260, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
      const fim = bloco(g, s.titulo || "Seu gancho aqui", { x: P, y: 300, max: larg, alturaMax: 620, peso: 800, tam: 120, cor: sobre, entrelinha: 1.08 });
      if (s.texto) bloco(g, s.texto, { x: P, y: fim + 40, max: larg, alturaMax: H - fim - 300, peso: 500, tam: 46, cor: sobre, entrelinha: 1.3 });
      g.font = `600 34px ${fam}`; g.fillStyle = sobre; g.textBaseline = "alphabetic";
      g.fillText(ig, P, H - P);
      g.textAlign = "right"; g.fillText("arraste ➜", W - P, H - P);
      return;
    }
    g.fillStyle = fundo; g.fillRect(0, 0, W, H);
    g.fillStyle = cor; g.fillRect(P, P, 120, 12);
    g.font = `600 30px ${fam}`; g.fillStyle = t2; g.textAlign = "right"; g.textBaseline = "top";
    g.fillText(`${k + 1}/${total}`, W - P, P - 8);
    g.textAlign = "left";
    let y = bloco(g, s.titulo || (s.modelo === "lista" ? "Título da lista" : "Título do slide"), { x: P, y: P + 70, max: larg, alturaMax: 340, peso: 800, tam: 80, cor, entrelinha: 1.1 });
    y += 46;
    if (s.modelo === "lista") {
      const itens = (s.itens || []).filter(Boolean);
      if (s.texto) { y = bloco(g, s.texto, { x: P, y, max: larg, alturaMax: 160, peso: 400, tam: 40, cor: t2, entrelinha: 1.3 }) + 36; }
      const espaco = Math.min(200, (H - P - 80 - y) / Math.max(1, itens.length));
      itens.slice(0, 6).forEach((it, n) => {
        const yy = y + n * espaco;
        g.fillStyle = cor; g.beginPath(); g.arc(P + 34, yy + 34, 34, 0, Math.PI * 2); g.fill();
        g.fillStyle = sobre; g.font = `800 36px ${fam}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(n + 1), P + 34, yy + 36);
        g.textAlign = "left";
        bloco(g, it, { x: P + 100, y: yy + 6, max: larg - 100, alturaMax: espaco - 20, peso: 500, tam: 44, cor: texto, entrelinha: 1.25 });
      });
    } else {
      bloco(g, s.texto || "Escreva o texto desse slide.", { x: P, y, max: larg, alturaMax: H - y - P - 80, peso: 400, tam: 50, cor: texto, entrelinha: 1.35 });
    }
    g.font = `600 30px ${fam}`; g.fillStyle = t2; g.textBaseline = "alphabetic"; g.textAlign = "left";
    g.fillText(ig, P, H - P);
  }

  function lerCampoSlide(el) {
    const item = el.closest("[data-slide]"); if (!item) return null;
    const k = Number(item.dataset.slide);
    const s = carrossel.slides[k];
    const campo = el.dataset.campo;
    if (campo === "itens") s.itens = linhas(el.value);
    else if (campo) s[campo] = el.value;
    return { k, campo };
  }

  async function salvarCarrossel(btn) {
    carrossel.titulo = $("ck-titulo").value.trim() || "Carrossel sem título";
    const dados = { titulo: carrossel.titulo, slides: carrossel.slides, modelo: carrossel.slides[0]?.modelo || null, ideia_id: carrossel.ideia_id || null };
    await U.comCarregando(btn, async () => {
      if (carrossel.id) {
        const { error } = await sb.from("carrosseis").update(dados).eq("id", carrossel.id); if (error) throw error;
      } else {
        const { data, error } = await sb.from("carrosseis").insert(dados).select("id").single(); if (error) throw error;
        carrossel.id = data.id;
      }
    }).then(() => { U.toast("Salvo ✓"); carregarCarrosseis(); desenharEditorCarrossel(); }).catch((e) => U.toast(e.message, "erro"));
  }

  async function baixarPNGs(btn) {
    await U.comCarregando(btn, async () => {
      await prepararFonte();
      const nome = U.semAcento(carrossel.titulo || "carrossel").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "carrossel";
      for (let k = 0; k < carrossel.slides.length; k++) {
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        desenharSlide(cv, carrossel.slides[k], k, carrossel.slides.length);
        const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = `${nome}-${String(k + 1).padStart(2, "0")}.png`;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        await new Promise((r) => setTimeout(r, 350));
      }
    });
    U.toast(`${carrossel.slides.length} imagens baixadas ✓`);
  }

  function textosComIA() {
    const opcoes = ideias.filter((i) => i.status !== "postado").slice(0, 60);
    const m = U.modal({
      titulo: "✨ Textos do carrossel com IA",
      html: `<div class="form-grade">
        <div class="campo inteiro"><label>A partir de uma ideia do quadro</label><select class="select" id="ci-ideia"><option value="">(escrever um tema)</option>${opcoes.map((i) => `<option value="${i.id}">${U.esc(corte(i.titulo, 80))}</option>`).join("")}</select></div>
        <div class="campo inteiro"><label>Ou um tema</label><input class="input" id="ci-tema" placeholder="Ex.: 5 sinais de que você precisa mudar de estratégia"></div>
        <div class="campo"><label>Quantos slides</label><input class="input" type="number" id="ci-n" min="3" max="10" value="7"></div></div>
        <p class="muted pequeno" style="margin-top:10px">Os slides atuais serão trocados pelos novos.</p>`,
      botoes: [
        { texto: "Cancelar", classe: "btn-fantasma" },
        { texto: "✨ Gerar", classe: "btn-primario", acao: async (fechar, btn) => {
          const idI = m.corpo.querySelector("#ci-ideia").value;
          const ide = ideias.find((i) => i.id === idI);
          const titulo = ide?.titulo || m.corpo.querySelector("#ci-tema").value.trim();
          if (!titulo) return U.toast("Escolha uma ideia ou escreva o tema.", "aviso");
          try {
            const r = await U.comCarregando(btn, () => U.chamarFunction("ideias-ia", {
              modo: "carrossel", titulo, descricao: ide ? `${ide.descricao || ""}\n${CENAS.map(([c]) => ide.roteiro?.[c] || "").join("\n")}` : "",
              slides: Number(m.corpo.querySelector("#ci-n").value) || 7,
            }));
            carrossel.slides = (r.slides || []).map((s) => ({ modelo: s.modelo, titulo: s.titulo, texto: s.texto, itens: s.itens || [] }));
            if (ide) { carrossel.ideia_id = ide.id; if (carrossel.titulo === "Carrossel sem título") carrossel.titulo = ide.titulo; }
            fechar(); desenharEditorCarrossel(); U.toast("Textos prontos ✓. Revise e salve.");
          } catch (e) { U.toast(e.message, "erro", 6000); }
        } },
      ],
    });
  }

  // =====================================================================
  // 📚 Roteiros de referência
  // =====================================================================
  const FONTE = { instagram: "📸", tiktok: "🎵", youtube: "▶️", outro: "🔗" };
  const ST_ROT = { transcrevendo: ["badge-aviso", "⏳ transcrevendo"], pronto: ["badge-ok", "pronto"], sem_fala: ["badge-info", "só música"], erro: ["badge-erro", "erro"] };

  async function carregarRoteiros() {
    const { data } = await sb.from("roteiros").select("*").order("created_at", { ascending: false });
    roteiros = data || [];
    desenharRoteiros();
    clearTimeout(pollRoteiros);
    if (roteiros.some((r) => r.status === "transcrevendo" && Date.now() - new Date(r.created_at).getTime() < 10 * 60e3)) {
      pollRoteiros = setTimeout(carregarRoteiros, 5000);
    }
  }

  function desenharRoteiros() {
    const b = U.semAcento($("c-r-busca").value), f = $("c-r-filtro").value;
    const lista = roteiros.filter((r) => (!f || r.de_quem === f) &&
      (!b || U.semAcento(`${r.titulo || ""} ${r.perfil || ""} ${r.transcricao || ""} ${(r.tags || []).join(" ")}`).includes(b)));
    $("c-r-grade").innerHTML = lista.length ? lista.map((r) => {
      const [cls, rot] = ST_ROT[r.status] || ["badge-info", r.status];
      return `<button class="card ref-card" data-roteiro="${r.id}">
        ${r.capa_url ? `<img class="ref-capa" src="${U.esc(r.capa_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ref-capa thumb-vazio',textContent:'${FONTE[r.fonte] || "🔗"}'}))">`
          : `<div class="ref-capa thumb-vazio">${FONTE[r.fonte] || "🔗"}</div>`}
        <div class="post-card-corpo">
          <div class="linha" style="justify-content:space-between"><span class="badge ${cls}">${rot}</span>
            <span class="badge ${r.de_quem === "minha" ? "badge-cor" : "badge-info"} sem-ponto">${r.de_quem === "minha" ? "🙋 meu" : "👀 de outra"}</span></div>
          <strong class="pequeno">${FONTE[r.fonte] || ""} ${U.esc(r.titulo || (r.perfil ? "@" + r.perfil : "Vídeo"))}</strong>
          <div class="muted pequeno">${U.esc(corte(r.transcricao || r.erro || "", 110))}</div>
          <div class="chips">${(r.tags || []).map((t) => `<span class="tag">#${U.esc(t)}</span>`).join("")}${r.analise ? '<span class="tag">🧠 estudado</span>' : ""}</div>
        </div></button>`;
    }).join("") : `<div class="vazio" style="grid-column:1/-1"><div class="vazio-emoji">📚</div><h3>Biblioteca vazia.</h3><p>Cole o link de um vídeo que você queria ter feito e clique em Transcrever.</p></div>`;
  }

  async function transcrever(e) {
    e.preventDefault();
    const url = $("c-r-url").value.trim();
    if (!/^https?:\/\//.test(url)) return U.toast("Cole o link completo do vídeo.", "aviso");
    try {
      await U.comCarregando(e.submitter, () => U.chamarFunction("transcrever", {
        url, de_quem: $("c-r-dequem").value, tags: virgulas($("c-r-tags").value).map((t) => t.replace(/^#/, "").toLowerCase()),
      }));
      $("c-r-url").value = ""; $("c-r-tags").value = "";
      U.toast("Transcrevendo em segundo plano ⏳");
      carregarRoteiros();
    } catch (err) { U.toast(err.message, "erro", 6000); }
  }

  function abrirRoteiro(id) {
    const r = roteiros.find((x) => x.id === id);
    if (!r) return;
    const a = r.analise;
    const parado = r.status === "transcrevendo" && Date.now() - new Date(r.created_at).getTime() > 2.5 * 60e3;
    const m = U.modal({
      titulo: `${FONTE[r.fonte] || ""} ${r.titulo || (r.perfil ? "@" + r.perfil : "Roteiro de referência")}`,
      grande: true,
      html: `<p class="pequeno"><a href="${U.esc(r.url)}" target="_blank" rel="noopener">↗️ ${U.esc(corte(r.url, 80))}</a></p>
        ${r.erro ? `<div class="aviso ${r.status === "erro" ? "erro" : "info"}" style="margin:10px 0">${U.esc(r.erro)}</div>` : ""}
        ${parado ? '<div class="aviso info" style="margin:10px 0">Esse vídeo é longo e ainda está na fila da Supadata. Clique em Continuar pra checar de novo.</div>' : ""}
        ${a ? `<div class="grade-2" style="margin:12px 0">
          <div class="card"><div class="muted pequeno">🪝 Gancho (${U.esc(a.tipo_gancho)})</div><p>“${U.esc(a.gancho)}”</p></div>
          <div class="card"><div class="muted pequeno">📣 CTA</div><p>${U.esc(a.cta)}</p></div>
          <div class="card"><div class="muted pequeno">🧭 Desenvolvimento</div><p class="pequeno">${U.esc(a.desenvolvimento)}</p></div>
          <div class="card"><div class="muted pequeno">💬 Expressões</div><div class="chips">${(a.expressoes || []).map((x) => `<span class="tag">${U.esc(x)}</span>`).join("")}</div></div></div>` : ""}
        <h3 class="bloco-titulo" style="margin-top:12px">📝 Transcrição</h3>
        <div class="transcricao">${U.esc(r.transcricao || (r.status === "transcrevendo" ? "Transcrevendo..." : "-"))}</div>`,
      botoes: [
        { texto: "🗑️ Apagar", classe: "btn-perigo", acao: async (fechar) => {
          if (!(await U.confirmar("Apagar esse roteiro da biblioteca?", { perigo: true, ok: "Apagar" }))) return;
          await sb.from("roteiros").delete().eq("id", id); fechar(); carregarRoteiros();
        } },
        ...(parado || r.status === "erro" ? [{ texto: "🔄 Continuar", classe: "btn-secundario", acao: async (fechar, btn) => {
          try {
            if (r.status === "erro") await sb.from("roteiros").update({ status: "transcrevendo", erro: null, job_id: null }).eq("id", id);
            await U.comCarregando(btn, () => U.chamarFunction("transcrever", { acao: "verificar", id }));
            fechar(); carregarRoteiros(); U.toast("Checando de novo ⏳");
          } catch (e) { U.toast(e.message, "erro"); }
        } }] : []),
        ...(r.transcricao ? [{ texto: "📋 Copiar", classe: "btn-fantasma", acao: () => U.copiar(r.transcricao) }] : []),
        { texto: "💡 Virar ideia", classe: "btn-primario", acao: (fechar) => {
          fechar();
          abrirEditor(null, { titulo: r.titulo || (a ? a.assunto : ""), origem: "referencia", capa_url: r.capa_url,
            descricao: `Referência: ${r.url}${a ? `\nGancho que funcionou: “${a.gancho}” (${a.tipo_gancho})` : ""}`, tags: r.tags || [] });
        } },
      ],
    });
    return m;
  }

  async function carregarEstudo() {
    const { data } = await sb.from("ia_resultados").select("*").eq("chave", "estudo_roteiros").maybeSingle();
    const el = $("c-r-estudo");
    clearTimeout(pollEstudo);
    const btn = $("c-r-estudar");
    btn.disabled = data?.status === "processando";
    btn.textContent = data?.status === "processando" ? "⏳ Estudando..." : "🧠 Estudar esses roteiros";
    U.marcarPagos(btn.parentElement);
    if (!data || data.status === "vazio") { el.innerHTML = ""; return; }
    if (data.status === "processando") {
      el.innerHTML = '<div class="aviso info" style="margin-bottom:16px">🧠 Estudando os roteiros em segundo plano. Leva uns 2 minutos.</div>';
      pollEstudo = setTimeout(carregarEstudo, 5000);
      return;
    }
    if (data.status === "erro") { el.innerHTML = `<div class="aviso erro" style="margin-bottom:16px">${U.esc(data.erro)}</div>`; return; }
    const p = data.payload || {};
    const lista = (xs) => `<ul>${(xs || []).map((x) => `<li>${U.esc(x)}</li>`).join("")}</ul>`;
    el.innerHTML = `<div class="card estudo" style="margin-bottom:16px">
      <div class="linha" style="justify-content:space-between"><h3 class="bloco-titulo" style="margin:0">🧠 O que os roteiros ensinam</h3>
        <span class="muted pequeno">${U.numero(p.estudados)} roteiros · ${U.dataHora(p.gerado_em)}</span></div>
      <div class="grade-3" style="margin-top:14px">
        <div><h4>🔥 Assuntos em alta</h4>${lista(p.assuntos_em_alta)}</div>
        <div><h4>💬 Linguagem que prende</h4>${lista(p.linguagem_que_prende)}</div>
        <div><h4>🪝 Padrões de gancho</h4><ul>${(p.padroes_de_gancho || []).map((g) => `<li><strong>${U.esc(g.padrao)}</strong><br><span class="muted pequeno">“${U.esc(g.exemplo)}”</span></li>`).join("")}</ul></div>
      </div>
      <h4 style="margin-top:16px">✍️ 5 roteiros novos no seu assunto</h4>
      <div class="grade" style="margin-top:10px">${(p.roteiros_novos || []).map((r, k) => `<div class="card">
        <strong>${U.esc(r.titulo)}</strong><div class="muted pequeno" style="margin:4px 0 8px">estrutura: ${U.esc(r.estrutura_base)}</div>
        <div class="citacao">🪝 “${U.esc(r.roteiro?.gancho)}”</div>
        <details><summary class="pequeno">Ver roteiro</summary>${CENAS.map(([c, rot]) => `<p class="pequeno"><strong>${rot}:</strong> ${U.esc(r.roteiro?.[c] || "")}</p>`).join("")}</details>
        <button class="btn btn-secundario btn-p" style="margin-top:10px" data-guardar-estudo="${k}">💾 Guardar como ideia</button></div>`).join("")}</div>
    </div>`;
    el._roteiros = p.roteiros_novos || [];
  }

  async function estudar(btn) {
    if (!roteiros.some((r) => r.status === "pronto")) return U.toast("Transcreva pelo menos 1 vídeo antes.", "aviso");
    try {
      await U.comCarregando(btn, () => U.chamarFunction("estudar-roteiros", {}));
      carregarEstudo();
    } catch (e) { U.toast(e.message, "erro", 6000); }
  }

  // =====================================================================
  // Sub-abas e eventos
  // =====================================================================
  function irSub(nome) {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.classList.toggle("ativo", b.dataset.sub === nome));
    secao.querySelectorAll(".subaba").forEach((s) => s.classList.toggle("ativa", s.dataset.sub === nome));
    U.guardar.gravar(CHAVE_SUB, nome);
    if (nome === "quadro") carregarIdeias();
    if (nome === "voz") carregarVoz();
    if (nome === "carrossel") { carregarCarrosseis(); if (!ideias.length) carregarIdeias(); }
    if (nome === "referencias") { carregarRoteiros(); carregarEstudo(); }
  }

  function ligarEventos() {
    secao.querySelectorAll(".subabas [data-sub]").forEach((b) => b.addEventListener("click", () => irSub(b.dataset.sub)));
    $("c-nova").addEventListener("click", () => abrirEditor(null));
    $("c-gerar").addEventListener("click", gerarIdeias);
    ["c-busca", "c-f-formato", "c-f-tag"].forEach((id) => $(id).addEventListener(id === "c-busca" ? "input" : "change", desenharKanban));

    const kb = $("c-kanban");
    kb.addEventListener("click", (e) => {
      const f = e.target.closest("[data-fav]");
      if (f) { e.stopPropagation(); return alternarFavorita(f.dataset.fav); }
      const c = e.target.closest("[data-ideia]");
      if (c) abrirEditor(c.dataset.ideia);
    });
    kb.addEventListener("dragstart", (e) => {
      const c = e.target.closest("[data-ideia]"); if (!c) return;
      e.dataTransfer.setData("text/plain", c.dataset.ideia); e.dataTransfer.effectAllowed = "move";
      c.classList.add("arrastando");
    });
    kb.addEventListener("dragend", (e) => e.target.closest?.("[data-ideia]")?.classList.remove("arrastando"));
    kb.addEventListener("dragover", (e) => {
      const col = e.target.closest("[data-coluna]"); if (!col) return;
      e.preventDefault();
      kb.querySelectorAll(".kanban-coluna").forEach((x) => x.classList.toggle("alvo", x === col));
    });
    kb.addEventListener("dragleave", (e) => { if (!kb.contains(e.relatedTarget)) kb.querySelectorAll(".alvo").forEach((x) => x.classList.remove("alvo")); });
    kb.addEventListener("drop", (e) => {
      const col = e.target.closest("[data-coluna]"); if (!col) return;
      e.preventDefault();
      kb.querySelectorAll(".alvo").forEach((x) => x.classList.remove("alvo"));
      moverIdeia(e.dataTransfer.getData("text/plain"), col.dataset.coluna);
    });

    $("c-v-form").addEventListener("submit", salvarVoz);
    $("c-v-testar").addEventListener("click", (e) => testarVoz(e.currentTarget));

    $("c-k-novo").addEventListener("click", () => abrirCarrossel(null));
    $("c-k-lista").addEventListener("click", (e) => { const b = e.target.closest("[data-carrossel]"); if (b) abrirCarrossel(b.dataset.carrossel); });
    const ed = $("c-k-editor");
    let t;
    const pendentes = new Set();
    ed.addEventListener("input", (e) => {
      if (e.target.id === "ck-titulo") { carrossel.titulo = e.target.value; return; }
      const r = lerCampoSlide(e.target); if (!r) return;
      pendentes.add(r.k);
      clearTimeout(t);
      t = setTimeout(() => {
        pendentes.forEach((k) => {
          const cv = ed.querySelector(`[data-previa="${k}"]`);
          if (cv && carrossel.slides[k]) desenharSlide(cv, carrossel.slides[k], k, carrossel.slides.length);
        });
        pendentes.clear();
      }, 120);
    });
    ed.addEventListener("change", (e) => {
      if (e.target.dataset.campo === "modelo") { lerCampoSlide(e.target); desenharEditorCarrossel(); }
    });
    ed.addEventListener("click", async (e) => {
      const id = e.target.closest("button")?.id;
      if (id === "ck-mais") { carrossel.slides.push(slideVazio()); desenharEditorCarrossel(); return; }
      if (id === "ck-salvar") return salvarCarrossel(e.target.closest("button"));
      if (id === "ck-baixar") return baixarPNGs(e.target.closest("button"));
      if (id === "ck-ia") return textosComIA();
      if (id === "ck-apagar") {
        if (!(await U.confirmar("Apagar esse carrossel?", { perigo: true, ok: "Apagar" }))) return;
        await sb.from("carrosseis").delete().eq("id", carrossel.id); carrossel = null; carregarCarrosseis(); return;
      }
      const ac = e.target.closest("[data-acao]"); if (!ac) return;
      const k = Number(ac.closest("[data-slide]").dataset.slide);
      const sl = carrossel.slides;
      if (ac.dataset.acao === "remover") { if (sl.length <= 1) return U.toast("O carrossel precisa de pelo menos 1 slide.", "aviso"); sl.splice(k, 1); }
      if (ac.dataset.acao === "subir" && k > 0) [sl[k - 1], sl[k]] = [sl[k], sl[k - 1]];
      if (ac.dataset.acao === "descer" && k < sl.length - 1) [sl[k + 1], sl[k]] = [sl[k], sl[k + 1]];
      desenharEditorCarrossel();
    });

    $("c-r-form").addEventListener("submit", transcrever);
    $("c-r-busca").addEventListener("input", desenharRoteiros);
    $("c-r-filtro").addEventListener("change", desenharRoteiros);
    $("c-r-grade").addEventListener("click", (e) => { const c = e.target.closest("[data-roteiro]"); if (c) abrirRoteiro(c.dataset.roteiro); });
    $("c-r-estudar").addEventListener("click", (e) => estudar(e.currentTarget));
    $("c-r-estudo").addEventListener("click", (e) => {
      const b = e.target.closest("[data-guardar-estudo]"); if (!b) return;
      const r = $("c-r-estudo")._roteiros[Number(b.dataset.guardarEstudo)];
      if (r) abrirEditor(null, { titulo: r.titulo, origem: "referencia", descricao: `Estrutura: ${r.estrutura_base}`, roteiro: r.roteiro });
    });
  }

  window.ABAS = window.ABAS || {};
  window.ABAS.criativos = {
    iniciar(el) {
      secao = el;
      ligarEventos();
      irSub(U.guardar.ler(CHAVE_SUB, "quadro"));
    },
    mostrar() {},
  };
})();
