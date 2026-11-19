// ig-insights (--no-verify-jwt: aceita o cron com x-sched-key ou o painel com JWT de admin)
// Monta o retrato do perfil por período (7, 30, 90 dias ou 0 = tudo) e guarda em ig_insights_cache.
// Números de cada post ficam em ig_media_insights, pra não gastar as ~200 chamadas por hora da Meta.
//  POST {days: 30}          -> recalcula esse período e devolve o payload
//  POST {acao: "aquecer"}   -> recalcula 7, 30 e 90 (cron das 4h)
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { exigirAdminOuSched, HttpError, json, servir } from "../_shared/auth.ts";
import { graph } from "../_shared/instagram.ts";

const FUSO = "America/Sao_Paulo";
const DIA = 86_400_000;
const MAX_POSTS_TUDO = 200;
const MAX_CHAMADAS_POSTS = 60; // por execução; o resto usa o cache antigo

type Post = {
  id: string; caption?: string; media_type?: string; media_product_type?: string; timestamp: string;
  permalink?: string; thumbnail_url?: string; media_url?: string; like_count?: number; comments_count?: number;
};
type Numeros = Record<string, number>;

const diaSP = (d: Date | number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
const horaSP = (d: Date | number) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: FUSO, hour: "2-digit", hourCycle: "h23" }).format(new Date(d)));
const segundos = (ms: number) => Math.floor(ms / 1000);
const ehReel = (p: Post) => p.media_product_type === "REELS" || (p.media_type === "VIDEO" && p.media_product_type !== "FEED");

function valorMetrica(m: { values?: { value?: unknown }[]; total_value?: { value?: unknown } }): number {
  const v = m.total_value?.value ?? m.values?.[0]?.value;
  return typeof v === "number" ? v : Number(v) || 0;
}

// ---------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------
async function listarPosts(db: SupabaseClient, desde: number | null): Promise<Post[]> {
  const campos = "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,media_url,like_count,comments_count";
  let url = `/me/media?fields=${campos}&limit=50`;
  const posts: Post[] = [];
  for (let pagina = 0; pagina < 10; pagina++) {
    const r = await graph(db, url);
    if (!r.ok) {
      if (!posts.length) throw new HttpError(502, "A Meta não devolveu os posts: " + (r.json?.error?.message ?? `HTTP ${r.status}`));
      break;
    }
    for (const p of r.json.data ?? []) {
      if (desde && new Date(p.timestamp).getTime() < desde) return posts;
      posts.push(p);
      if (posts.length >= MAX_POSTS_TUDO) return posts;
    }
    const prox = r.json.paging?.next;
    if (!prox) break;
    url = prox;
  }
  return posts;
}

/** Busca (ou reaproveita do cache) os números de cada post. */
async function numerosDosPosts(db: SupabaseClient, posts: Post[]): Promise<Map<string, Numeros>> {
  const ids = posts.map((p) => p.id);
  const cache = new Map<string, { dados: Numeros; fetched_at: string }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("ig_media_insights").select("media_id, dados, fetched_at").in("media_id", ids.slice(i, i + 200));
    for (const r of data ?? []) cache.set(r.media_id, { dados: r.dados, fetched_at: r.fetched_at });
  }

  const agora = Date.now();
  const validade = (p: Post) => {
    const idade = agora - new Date(p.timestamp).getTime();
    return idade < 3 * DIA ? 3 * 3600e3 : idade < 30 * DIA ? DIA : 7 * DIA;
  };
  const vencidos = posts
    .filter((p) => { const c = cache.get(p.id); return !c || agora - new Date(c.fetched_at).getTime() > validade(p); })
    .sort((a, b) => (cache.has(a.id) ? 1 : 0) - (cache.has(b.id) ? 1 : 0) || b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_CHAMADAS_POSTS);

  const base = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"];
  const doReel = ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];
  const buscar = async (p: Post) => {
    const tentativas = ehReel(p) ? [[...base, ...doReel], base] : [base, base.filter((m) => m !== "views")];
    for (const metricas of tentativas) {
      const r = await graph(db, `/${p.id}/insights?metric=${metricas.join(",")}`);
      if (r.ok) {
        const n: Numeros = {};
        for (const m of r.json.data ?? []) n[m.name] = valorMetrica(m);
        return n;
      }
    }
    return null;
  };

  const novos: { media_id: string; post_ts: string; dados: Numeros; fetched_at: string }[] = [];
  for (let i = 0; i < vencidos.length; i += 5) {
    const lote = vencidos.slice(i, i + 5);
    const res = await Promise.all(lote.map(buscar));
    lote.forEach((p, j) => {
      if (res[j]) {
        cache.set(p.id, { dados: res[j]!, fetched_at: new Date().toISOString() });
        novos.push({ media_id: p.id, post_ts: p.timestamp, dados: res[j]!, fetched_at: new Date().toISOString() });
      }
    });
  }
  if (novos.length) await db.from("ig_media_insights").upsert(novos, { onConflict: "media_id" });

  const saida = new Map<string, Numeros>();
  for (const p of posts) saida.set(p.id, cache.get(p.id)?.dados ?? {});
  return saida;
}

// ---------------------------------------------------------------------
// Conta
// ---------------------------------------------------------------------
/** Janelas de até 30 dias (limite da Meta), da mais antiga pra mais nova. */
function janelas(desde: number, ate: number): [number, number][] {
  const out: [number, number][] = [];
  for (let ini = desde; ini < ate; ini += 30 * DIA) out.push([ini, Math.min(ini + 30 * DIA, ate)]);
  return out;
}

async function serieDiaria(db: SupabaseClient, metrica: string, desde: number, ate: number) {
  const pontos = new Map<string, number>();
  let erro: string | null = null;
  for (const [a, b] of janelas(desde, ate)) {
    const r = await graph(db, `/me/insights?metric=${metrica}&period=day&since=${segundos(a)}&until=${segundos(b)}`);
    if (!r.ok) { erro = r.json?.error?.message ?? `HTTP ${r.status}`; continue; }
    for (const m of r.json.data ?? []) {
      for (const v of m.values ?? []) {
        // end_time marca o fim do dia (meia-noite do Pacífico); o dia é o anterior
        const dia = diaSP(new Date(v.end_time).getTime() - 12 * 3600e3);
        pontos.set(dia, (pontos.get(dia) ?? 0) + (Number(v.value) || 0));
      }
    }
  }
  return { pontos: [...pontos.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([dia, v]) => ({ dia, v })), erro };
}

async function totais(db: SupabaseClient, desde: number, ate: number) {
  const metricas = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "saves", "shares", "profile_views"];
  const soma: Numeros = {};
  let erro: string | null = null;
  const js = janelas(desde, ate);
  for (const [a, b] of js) {
    let r = await graph(db, `/me/insights?metric=${metricas.join(",")}&period=day&metric_type=total_value&since=${segundos(a)}&until=${segundos(b)}`);
    if (!r.ok) {
      // Se alguma métrica não existir nessa conta, pede uma a uma
      erro = r.json?.error?.message ?? `HTTP ${r.status}`;
      for (const m of metricas) {
        r = await graph(db, `/me/insights?metric=${m}&period=day&metric_type=total_value&since=${segundos(a)}&until=${segundos(b)}`);
        if (r.ok) for (const x of r.json.data ?? []) soma[x.name] = (soma[x.name] ?? 0) + valorMetrica(x);
      }
      continue;
    }
    for (const x of r.json.data ?? []) soma[x.name] = (soma[x.name] ?? 0) + valorMetrica(x);
  }
  return { soma, erro, somado: js.length > 1 };
}

// ---------------------------------------------------------------------
// Monta o retrato de um período
// ---------------------------------------------------------------------
async function montar(db: SupabaseClient, days: number, todosPosts: Post[], nums: Map<string, Numeros>, conta: Record<string, number>) {
  const agora = Date.now();
  const diasConta = days > 0 ? days : 90; // a Meta só guarda ~90 dias de números da conta
  const desde = agora - diasConta * DIA;
  const posts = days > 0 ? todosPosts.filter((p) => new Date(p.timestamp).getTime() >= desde) : todosPosts;

  const [alcance, novos, tot] = await Promise.all([
    serieDiaria(db, "reach", desde, agora),
    serieDiaria(db, "follower_count", Math.max(desde, agora - 30 * DIA), agora),
    totais(db, desde, agora),
  ]);

  // Seguidores por dia: fotos diárias quando existem; senão, conta de trás pra frente com os novos seguidores
  const { data: fotos } = await db.from("ig_followers_daily").select("dia, followers").gte("dia", diaSP(desde)).order("dia");
  const fotosMap = new Map((fotos ?? []).map((f: { dia: string; followers: number }) => [f.dia, f.followers]));
  const seguidoresSerie: { dia: string; v: number; estimado?: boolean }[] = [];
  let total = conta.followers_count ?? 0;
  const novosMap = new Map(novos.pontos.map((p) => [p.dia, p.v]));
  for (let t = agora; t >= desde; t -= DIA) {
    const dia = diaSP(t);
    const foto = fotosMap.get(dia);
    if (foto != null) total = foto;
    seguidoresSerie.unshift({ dia, v: total, ...(foto == null ? { estimado: true } : {}) });
    total = Math.max(0, total - (novosMap.get(dia) ?? 0));
  }
  const seguidoresInicio = seguidoresSerie[0]?.v ?? conta.followers_count;

  const linhas = posts.map((p) => {
    const n = nums.get(p.id) ?? {};
    const reach = n.reach ?? 0;
    const inter = n.total_interactions ?? ((n.likes ?? p.like_count ?? 0) + (n.comments ?? p.comments_count ?? 0) + (n.shares ?? 0) + (n.saved ?? 0));
    return {
      id: p.id, caption: (p.caption ?? "").slice(0, 400), formato: ehReel(p) ? "REELS" : p.media_type, timestamp: p.timestamp,
      permalink: p.permalink, capa: p.thumbnail_url || (p.media_type !== "VIDEO" ? p.media_url : null),
      views: n.views ?? null, reach: n.reach ?? null,
      likes: n.likes ?? p.like_count ?? null, comments: n.comments ?? p.comments_count ?? null,
      shares: n.shares ?? null, saved: n.saved ?? null, interacoes: inter,
      retencao_s: n.ig_reels_avg_watch_time != null ? Math.round(n.ig_reels_avg_watch_time / 100) / 10 : null,
      tempo_total_s: n.ig_reels_video_view_total_time != null ? Math.round(n.ig_reels_video_view_total_time / 1000) : null,
      engajamento: reach ? Math.round((inter / reach) * 1000) / 10 : null,
    };
  });

  const somaPosts = (k: "views" | "reach" | "saved" | "interacoes") => linhas.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  const alcanceTotal = tot.soma.reach ?? alcance.pontos.reduce((s, p) => s + p.v, 0);
  const interacoes = tot.soma.total_interactions ?? somaPosts("interacoes");

  // Melhores horários: alcance médio por faixa de hora de publicação
  const porHora = new Map<number, { n: number; reach: number }>();
  for (const l of linhas) {
    const h = horaSP(l.timestamp);
    const x = porHora.get(h) ?? { n: 0, reach: 0 };
    x.n++; x.reach += Number(l.reach) || 0;
    porHora.set(h, x);
  }
  const horarios = [...porHora.entries()].map(([hora, x]) => ({ hora, posts: x.n, alcance_medio: Math.round(x.reach / x.n) }))
    .sort((a, b) => b.alcance_medio - a.alcance_medio);

  return {
    days, gerado_em: new Date().toISOString(),
    periodo: { desde: diaSP(desde), ate: diaSP(agora), dias_conta: diasConta },
    conta,
    cards: {
      alcance: alcanceTotal,
      alcance_somado: tot.somado || tot.soma.reach == null,
      seguidores: conta.followers_count ?? null,
      seguidores_var: conta.followers_count != null && seguidoresInicio != null ? conta.followers_count - seguidoresInicio : null,
      views: tot.soma.views ?? somaPosts("views"),
      interacoes,
      salvamentos: tot.soma.saves ?? somaPosts("saved"),
      engajamento: alcanceTotal ? Math.round((interacoes / alcanceTotal) * 1000) / 10 : null,
      visitas_perfil: tot.soma.profile_views ?? null,
      contas_engajadas: tot.soma.accounts_engaged ?? null,
      posts: linhas.length,
    },
    serie: { alcance: alcance.pontos, seguidores: seguidoresSerie },
    posts: linhas,
    top5: [...linhas].sort((a, b) => (Number(b.reach) || 0) - (Number(a.reach) || 0)).slice(0, 5).map((l) => l.id),
    horarios,
    avisos: [alcance.erro, novos.erro, tot.erro].filter(Boolean),
  };
}

servir(async (req) => {
  const { db } = await exigirAdminOuSched(req);
  const body = await req.json().catch(() => ({}));
  const lista: number[] = body.acao === "aquecer" ? [7, 30, 90] : [Number(body.days ?? 30)];
  for (const d of lista) if (![0, 7, 30, 90].includes(d)) throw new HttpError(400, "Período inválido (use 7, 30, 90 ou 0 = tudo).");

  // Conta + foto do dia
  const me = await graph(db, "/me?fields=id,user_id,username,followers_count,follows_count,media_count");
  if (!me.ok) throw new HttpError(502, "Não consegui ler a conta do Instagram: " + (me.json?.error?.message ?? `HTTP ${me.status}`));
  const conta = { followers_count: me.json.followers_count, follows_count: me.json.follows_count, media_count: me.json.media_count };
  await db.from("ig_followers_daily").upsert({
    dia: diaSP(Date.now()), followers: conta.followers_count ?? null, follows: conta.follows_count ?? null, media_count: conta.media_count ?? null,
  }, { onConflict: "dia" });

  const maior = lista.includes(0) ? 0 : Math.max(...lista);
  const posts = await listarPosts(db, maior > 0 ? Date.now() - maior * DIA : null);
  const nums = await numerosDosPosts(db, posts);

  let ultimo = null;
  for (const d of lista) {
    const payload = await montar(db, d, posts, nums, { ...conta, username: me.json.username } as unknown as Record<string, number>);
    await db.from("ig_insights_cache").upsert({ days: d, payload, generated_at: new Date().toISOString() }, { onConflict: "days" });
    ultimo = payload;
  }
  return json({ ok: true, payload: lista.length === 1 ? ultimo : undefined, periodos: lista });
});
