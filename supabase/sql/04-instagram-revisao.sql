-- =====================================================================
-- FASE 4: 📊 Revisão do Instagram (insights, comentários, revisão do dia com IA,
-- concorrentes, objetivos). Pode rodar mais de uma vez sem quebrar.
-- =====================================================================

-- Retrato do perfil por período (7, 30, 90 e 0 = tudo)
create table if not exists public.ig_insights_cache (
  days         int primary key,
  payload      jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

-- Números de cada post (cache pra não gastar as 200 chamadas por hora da Meta)
create table if not exists public.ig_media_insights (
  media_id   text primary key,
  post_ts    timestamptz,
  dados      jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now()
);

-- Foto diária da conta
create table if not exists public.ig_followers_daily (
  dia         date primary key,
  followers   int,
  follows     int,
  media_count int,
  created_at  timestamptz not null default now()
);

-- Comentários dos últimos posts
create table if not exists public.ig_post_comments (
  media_id    text primary key,
  comentarios jsonb not null default '[]'::jsonb,
  n           int not null default 0,
  post_ts     timestamptz,
  permalink   text,
  caption     text,
  updated_at  timestamptz not null default now()
);

-- Análise dos comentários (temas, perguntas sem resposta, top fãs). 1 linha: id = 'atual'
create table if not exists public.ig_commenter_cache (
  id           text primary key default 'atual',
  status       text not null default 'vazio' check (status in ('vazio', 'processando', 'pronto', 'erro')),
  payload      jsonb not null default '{}'::jsonb,
  erro         text,
  generated_at timestamptz,
  updated_at   timestamptz not null default now()
);

-- Revisão diária com IA
create table if not exists public.ig_review_cache (
  dia        date primary key,
  review     jsonb,
  facts      jsonb not null default '{}'::jsonb,
  erro       text,
  created_at timestamptz not null default now()
);

-- Concorrentes
create table if not exists public.ig_competitors (
  username   text primary key,
  nota       text,
  created_at timestamptz not null default now()
);
create table if not exists public.ig_competitor_snapshots (
  username   text not null,
  dia        date not null,
  payload    jsonb not null default '{}'::jsonb,
  erro       text,
  created_at timestamptz not null default now(),
  primary key (username, dia)
);

-- Períodos impulsionados (pra não comparar pago com orgânico)
create table if not exists public.ig_periodos_pagos (
  id         uuid primary key default gen_random_uuid(),
  inicio     date not null,
  fim        date not null,
  nota       text,
  created_at timestamptz not null default now(),
  check (fim >= inicio)
);

-- Objetivos (metas que se atualizam sozinhas)
create table if not exists public.ig_objetivos (
  id         uuid primary key default gen_random_uuid(),
  tipo       text not null check (tipo in ('seguidores', 'views_mes', 'posts_semana')),
  alvo       numeric not null,
  prazo      date,
  titulo     text,
  created_at timestamptz not null default now()
);

-- RLS + permissões: só admin (e as functions, via service_role)
do $$
declare t text;
begin
  foreach t in array array['ig_insights_cache','ig_media_insights','ig_followers_daily','ig_post_comments',
                           'ig_commenter_cache','ig_review_cache','ig_competitors','ig_competitor_snapshots',
                           'ig_periodos_pagos','ig_objetivos']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "só admin" on public.%I', t);
    execute format('create policy "só admin" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
  end loop;
end $$;

-- =====================================================================
-- ROBÔS (pg_cron, horários em UTC: São Paulo = UTC-3)
-- =====================================================================
-- 4h de SP: aquece os insights (7, 30 e 90 dias) e tira a foto dos concorrentes
select cron.schedule(
  'ig-insights-aquecer',
  '0 7 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ig-insights',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sched-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sched_secret')),
    body := '{"acao":"aquecer"}'::jsonb,
    timeout_milliseconds := 5000
  );
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ig-competitors',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sched-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sched_secret')),
    body := '{"acao":"atualizar"}'::jsonb,
    timeout_milliseconds := 5000
  );
  $cron$
);

-- 11h de SP: revisão do dia com IA
select cron.schedule(
  'ig-review-diaria',
  '0 14 * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ig-review',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sched-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sched_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $cron$
);

select jobname, schedule, active from cron.job order by jobname;
