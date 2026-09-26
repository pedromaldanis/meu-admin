-- =====================================================================
-- FASE 3: AUTOMAÇÃO DO INSTAGRAM
-- Comentário ou DM com palavra-chave vira DM automática.
-- Pode rodar quantas vezes quiser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ig_automations
-- flow = {steps:[{id, message, buttons:[{title,next}|{title,url}], assets:[urls],
--                 delay:{value,unit,next}, collect:{field:'email'|'telefone', next}}]}
-- ---------------------------------------------------------------------
create table if not exists public.ig_automations (
  id                    uuid primary key default gen_random_uuid(),
  nome                  text not null,
  active                boolean not null default false,
  trigger_type          text not null default 'comment' check (trigger_type in ('comment', 'dm', 'story_reply')),
  keyword               text,                     -- várias, separadas por vírgula
  match_any             boolean not null default false,
  media_ids             text[] not null default '{}',  -- vazio = todos os posts
  public_reply          text,
  public_reply_variants text[] not null default '{}',
  ask_message           text,
  ask_button            text,
  flow                  jsonb not null default '{"steps":[]}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
drop trigger if exists trg_ig_automations_updated on public.ig_automations;
create trigger trg_ig_automations_updated before update on public.ig_automations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- ig_leads: 1 linha por pessoa que falou com a automação
-- ---------------------------------------------------------------------
create table if not exists public.ig_leads (
  id                   uuid primary key default gen_random_uuid(),
  ig_user_id           text not null unique,
  username             text,
  last_source          text check (last_source in ('comment', 'dm')),
  last_keyword         text,
  last_text            text,
  last_media_id        text,
  automation_id        uuid references public.ig_automations(id) on delete set null,
  flow_step            text,
  link_sent            boolean not null default false,
  interactions         int not null default 0,
  email                text,
  telefone             text,
  expecting            jsonb,                     -- {field, next, automation_id, ate}
  last_inbound_at      timestamptz,               -- define a janela de 24h
  last_manual_reply_at timestamptz,
  tags                 text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists ig_leads_username_idx on public.ig_leads (lower(username));
create index if not exists ig_leads_inbound_idx on public.ig_leads (last_inbound_at desc);
drop trigger if exists trg_ig_leads_updated on public.ig_leads;
create trigger trg_ig_leads_updated before update on public.ig_leads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- ig_deliveries: log de tudo que o robô tentou mandar
-- ---------------------------------------------------------------------
create table if not exists public.ig_deliveries (
  id            uuid primary key default gen_random_uuid(),
  ts            timestamptz not null default now(),
  ig_user_id    text,
  automation_id uuid references public.ig_automations(id) on delete set null,
  canal         text check (canal in ('private_reply', 'dm', 'comment_reply')),
  tipo          text,          -- passo, convite, link, arquivo, resposta_publica, captura, recado, teste
  status        text not null check (status in ('ok', 'erro', 'pulado')),
  motivo        text,
  mid           text
);
create index if not exists ig_deliveries_ts_idx on public.ig_deliveries (ts desc);
create index if not exists ig_deliveries_dedupe_idx on public.ig_deliveries (ig_user_id, automation_id, ts desc);

-- ---------------------------------------------------------------------
-- ig_scheduled: passos com atraso
-- ---------------------------------------------------------------------
create table if not exists public.ig_scheduled (
  id            uuid primary key default gen_random_uuid(),
  ig_user_id    text not null,
  automation_id uuid references public.ig_automations(id) on delete cascade,
  step_id       text not null,
  send_at       timestamptz not null,
  sent          boolean not null default false,
  canceled      boolean not null default false,
  cancel_reason text,
  claimed_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists ig_scheduled_fila_idx on public.ig_scheduled (send_at) where not sent and not canceled;

-- ---------------------------------------------------------------------
-- ig_send_budget: o FREIO (1 linha só)
-- ---------------------------------------------------------------------
create table if not exists public.ig_send_budget (
  id             int primary key default 1 check (id = 1),
  minute_key     text, minute_count int not null default 0,
  hour_key       text, hour_count   int not null default 0,
  day_key        text, day_count    int not null default 0,
  cap_minute     int not null default 10,
  cap_hour       int not null default 60,
  cap_day        int not null default 150,
  err_streak     int not null default 0,
  paused_until   timestamptz,
  paused_reason  text,
  pausado_manual boolean not null default false,
  updated_at     timestamptz not null default now()
);
insert into public.ig_send_budget (id) values (1) on conflict (id) do nothing;

create table if not exists public.ig_pausas (
  id     uuid primary key default gen_random_uuid(),
  ts     timestamptz not null default now(),
  ate    timestamptz,
  motivo text,
  manual boolean not null default false
);

-- ---------------------------------------------------------------------
-- ig_assets: arquivos pra mandar na DM (bucket público ig-assets)
-- ---------------------------------------------------------------------
create table if not exists public.ig_assets (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  tipo       text not null check (tipo in ('image', 'audio', 'video', 'file')),
  url        text not null,
  path       text not null,
  tamanho    bigint,
  created_at timestamptz not null default now()
);

-- ig_bot_sends: mids das mensagens que o robô mandou (pra ignorar o eco)
create table if not exists public.ig_bot_sends (
  mid text primary key,
  ts  timestamptz not null default now()
);

-- ig_token_status: validade do token (o token em si fica no Vault / secret)
create table if not exists public.ig_token_status (
  id           int primary key default 1 check (id = 1),
  expires_at   timestamptz,
  refreshed_at timestamptz,
  ok           boolean,
  erro         text,
  username     text,
  account_id   text,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RLS + permissões: só admin (e as functions, via service_role)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ig_automations','ig_leads','ig_deliveries','ig_scheduled','ig_send_budget',
                           'ig_pausas','ig_assets','ig_bot_sends','ig_token_status']
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
-- FREIO
-- =====================================================================

-- Pede uma vaga pra mandar 1 mensagem. Devolve {ok, motivo}.
create or replace function public.take_send_slot(p_key text default 'dm', p_user text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.ig_send_budget;
  agora_sp timestamp := now() at time zone 'America/Sao_Paulo';
  k_min text := to_char(agora_sp, 'YYYY-MM-DD"T"HH24:MI');
  k_h   text := to_char(agora_sp, 'YYYY-MM-DD"T"HH24');
  k_d   text := to_char(agora_sp, 'YYYY-MM-DD');
begin
  select * into b from ig_send_budget where id = 1 for update;
  if not found then
    insert into ig_send_budget (id) values (1) returning * into b;
  end if;

  if b.pausado_manual then
    return jsonb_build_object('ok', false, 'motivo', 'Freio: pausado manualmente no painel');
  end if;
  if b.paused_until is not null and b.paused_until > now() then
    return jsonb_build_object('ok', false, 'motivo', 'Freio: pausado até ' ||
      to_char(b.paused_until at time zone 'America/Sao_Paulo', 'HH24:MI') || ' (' || coalesce(b.paused_reason, '') || ')');
  end if;

  if b.minute_key is distinct from k_min then b.minute_key := k_min; b.minute_count := 0; end if;
  if b.hour_key   is distinct from k_h   then b.hour_key   := k_h;   b.hour_count   := 0; end if;
  if b.day_key    is distinct from k_d   then b.day_key    := k_d;   b.day_count    := 0; end if;

  if b.day_count >= b.cap_day then
    return jsonb_build_object('ok', false, 'motivo', 'Freio: limite do dia (' || b.cap_day || ') atingido');
  end if;
  if b.hour_count >= b.cap_hour then
    return jsonb_build_object('ok', false, 'motivo', 'Freio: limite da hora (' || b.cap_hour || ') atingido');
  end if;
  if b.minute_count >= b.cap_minute then
    return jsonb_build_object('ok', false, 'motivo', 'Freio: limite do minuto (' || b.cap_minute || ') atingido');
  end if;

  update ig_send_budget set
    minute_key = b.minute_key, minute_count = b.minute_count + 1,
    hour_key = b.hour_key, hour_count = b.hour_count + 1,
    day_key = b.day_key, day_count = b.day_count + 1,
    updated_at = now()
  where id = 1;

  return jsonb_build_object('ok', true);
end;
$$;

-- Registra o resultado. 3 rate limits seguidos pausam tudo por 1 hora.
create or replace function public.record_send_result(p_ok boolean, p_rate_limit boolean default false, p_erro text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_streak int;
begin
  if p_ok then
    update ig_send_budget set err_streak = 0, updated_at = now() where id = 1;
  elsif p_rate_limit then
    update ig_send_budget set err_streak = err_streak + 1, updated_at = now() where id = 1
    returning err_streak into v_streak;
    if v_streak >= 3 then
      update ig_send_budget set
        paused_until = now() + interval '1 hour',
        paused_reason = '3 erros de limite da Meta seguidos',
        err_streak = 0
      where id = 1;
      insert into ig_pausas (ate, motivo, manual)
      values (now() + interval '1 hour', '3 erros de limite seguidos: ' || coalesce(left(p_erro, 200), ''), false);
    end if;
  end if;
end;
$$;

-- Estado do freio pra tela (zera o contador que já virou)
create or replace function public.ig_freio()
returns jsonb
language sql
stable
set search_path = public
as $$
  with b as (select * from ig_send_budget where id = 1),
  k as (
    select to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI') m,
           to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24') h,
           to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD') d
  )
  select jsonb_build_object(
    'minuto', case when b.minute_key = k.m then b.minute_count else 0 end,
    'hora',   case when b.hour_key   = k.h then b.hour_count   else 0 end,
    'dia',    case when b.day_key    = k.d then b.day_count    else 0 end,
    'cap_minute', b.cap_minute, 'cap_hour', b.cap_hour, 'cap_day', b.cap_day,
    'err_streak', b.err_streak,
    'paused_until', case when b.paused_until > now() then b.paused_until end,
    'paused_reason', case when b.paused_until > now() then b.paused_reason end,
    'pausado_manual', b.pausado_manual
  ) from b, k;
$$;

-- Contadores por automação (cards da lista)
create or replace function public.ig_automacao_stats()
returns table (automation_id uuid, leads int, entregas_hoje int, entregas_total int)
language sql
stable
set search_path = public
as $$
  select a.id,
    (select count(*)::int from ig_leads l where l.automation_id = a.id),
    (select count(*)::int from ig_deliveries d where d.automation_id = a.id and d.status = 'ok'
       and d.ts >= (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')),
    (select count(*)::int from ig_deliveries d where d.automation_id = a.id and d.status = 'ok')
  from ig_automations a;
$$;

-- O robô pega passos com atraso vencidos, sem dois robôs pegarem o mesmo
create or replace function public.pegar_ig_agendados(p_limite int default 20)
returns setof public.ig_scheduled
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    update ig_scheduled s set claimed_at = now()
    where s.id in (
      select id from ig_scheduled
      where not sent and not canceled and send_at <= now()
        and (claimed_at is null or claimed_at < now() - interval '5 minutes')
      order by send_at
      limit p_limite
      for update skip locked
    )
    returning s.*;
end;
$$;

-- Token do Instagram renovado fica no Vault (nunca em tabela nem no código)
create or replace function public.ig_token_ler()
returns text
language sql
security definer
set search_path = public, vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'ig_access_token' limit 1;
$$;

create or replace function public.ig_token_salvar(p_token text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'ig_access_token';
  if v_id is null then
    perform vault.create_secret(p_token, 'ig_access_token');
  else
    perform vault.update_secret(v_id, p_token);
  end if;
end;
$$;

revoke all on function public.take_send_slot(text, text), public.record_send_result(boolean, boolean, text),
  public.pegar_ig_agendados(int), public.ig_token_ler(), public.ig_token_salvar(text)
  from public, anon, authenticated;
grant execute on function public.take_send_slot(text, text), public.record_send_result(boolean, boolean, text),
  public.pegar_ig_agendados(int), public.ig_token_ler(), public.ig_token_salvar(text)
  to service_role;
grant execute on function public.ig_freio(), public.ig_automacao_stats() to authenticated, service_role;

-- =====================================================================
-- STORAGE: bucket público ig-assets
-- imagem até 8MB; áudio m4a, vídeo mp4 e PDF até 25MB (MP3 o Instagram recusa)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ig-assets', 'ig-assets', true, 26214400,
  array['image/jpeg','image/png','image/gif','image/webp','audio/mp4','audio/x-m4a','audio/m4a','video/mp4','application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "ig-assets: admin lê" on storage.objects;
create policy "ig-assets: admin lê" on storage.objects for select to authenticated
  using (bucket_id = 'ig-assets' and public.is_admin());
drop policy if exists "ig-assets: admin envia" on storage.objects;
create policy "ig-assets: admin envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'ig-assets' and public.is_admin());
drop policy if exists "ig-assets: admin altera" on storage.objects;
create policy "ig-assets: admin altera" on storage.objects for update to authenticated
  using (bucket_id = 'ig-assets' and public.is_admin());
drop policy if exists "ig-assets: admin apaga" on storage.objects;
create policy "ig-assets: admin apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'ig-assets' and public.is_admin());

-- =====================================================================
-- ROBÔS (pg_cron). Usam project_url e sched_secret do Vault (FASE 2).
-- =====================================================================
select cron.schedule(
  'ig-scheduler',
  '* * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ig-scheduler',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sched-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sched_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $cron$
);

-- Toda segunda, 12h UTC = 9h de São Paulo
select cron.schedule(
  'ig-token-refresh',
  '0 12 * * 1',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/ig-token-refresh',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sched-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sched_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $cron$
);

-- Limpeza: ecos guardados há mais de 7 dias não servem pra nada
select cron.schedule('ig-limpar-ecos', '17 4 * * *', $cron$ delete from public.ig_bot_sends where ts < now() - interval '7 days'; $cron$);

select jobname, schedule, active from cron.job order by jobname;
