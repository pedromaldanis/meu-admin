-- =====================================================================
-- FASE 2: DISPARO DE E-MAILS
-- contatos, envios, agendados, optout, eventos do webhook, modelos.
-- Pode rodar quantas vezes quiser.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------
-- Normaliza e-mail: minúsculo e sem espaços
-- ---------------------------------------------------------------------
create or replace function public.normalizar_email()
returns trigger
language plpgsql
as $$
begin
  new.email = lower(trim(new.email));
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- contatos
-- ---------------------------------------------------------------------
create table if not exists public.contatos (
  id            uuid primary key default gen_random_uuid(),
  nome          text,
  email         text not null unique,
  tags          text[] not null default '{}',
  origem        text,
  descadastrado boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists contatos_tags_idx on public.contatos using gin (tags);

drop trigger if exists trg_contatos_email on public.contatos;
create trigger trg_contatos_email before insert or update of email on public.contatos
  for each row execute function public.normalizar_email();

-- ---------------------------------------------------------------------
-- email_envios: 1 linha por destinatário por envio
-- ---------------------------------------------------------------------
create table if not exists public.email_envios (
  id        uuid primary key default gen_random_uuid(),
  email     text not null,
  assunto   text,
  status    text not null check (status in ('ok', 'erro')),
  erro      text,
  resend_id text,
  origem    text not null default 'disparo' check (origem in ('disparo', 'agendado', 'teste')),
  ts        timestamptz not null default now()
);
create index if not exists email_envios_ts_idx on public.email_envios (ts desc);
create index if not exists email_envios_assunto_idx on public.email_envios (assunto, email, status);
create index if not exists email_envios_resend_idx on public.email_envios (resend_id);

-- ---------------------------------------------------------------------
-- emails_agendados
-- ---------------------------------------------------------------------
create table if not exists public.emails_agendados (
  id            uuid primary key default gen_random_uuid(),
  assunto       text not null,
  html          text not null,
  destinatario  text not null,              -- todos | tag:<nome> | lista | teste
  lista_emails  text,                       -- usado quando destinatario = lista
  agendado_para timestamptz not null,
  status        text not null default 'pendente'
                check (status in ('pendente', 'enviando', 'enviado', 'erro', 'cancelado')),
  enviados      int not null default 0,
  falhas        int not null default 0,
  pulados       int not null default 0,
  total         int not null default 0,
  sent_at       timestamptz,
  erro          text,
  lock_at       timestamptz,                -- quando o robô pegou (pra destravar se morrer)
  created_at    timestamptz not null default now()
);
create index if not exists emails_agendados_fila_idx on public.emails_agendados (status, agendado_para);

-- ---------------------------------------------------------------------
-- email_optout: quem NUNCA mais recebe
-- ---------------------------------------------------------------------
create table if not exists public.email_optout (
  email      text primary key,
  motivo     text,
  created_at timestamptz not null default now()
);
drop trigger if exists trg_optout_email on public.email_optout;
create trigger trg_optout_email before insert or update of email on public.email_optout
  for each row execute function public.normalizar_email();

-- ---------------------------------------------------------------------
-- email_eventos: o que o webhook da Resend conta
-- ---------------------------------------------------------------------
create table if not exists public.email_eventos (
  id        uuid primary key default gen_random_uuid(),
  tipo      text not null,                  -- email.delivered, email.opened...
  email     text,
  resend_id text,
  payload   jsonb,
  ts        timestamptz not null default now()
);
create index if not exists email_eventos_resend_idx on public.email_eventos (resend_id, tipo);
create index if not exists email_eventos_ts_idx on public.email_eventos (ts desc);

-- ---------------------------------------------------------------------
-- modelos_email
-- ---------------------------------------------------------------------
create table if not exists public.modelos_email (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null unique,
  assunto    text,
  html       text,
  config     jsonb,                          -- modo texto: corpo, botão etc.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_modelos_updated_at on public.modelos_email;
create trigger trg_modelos_updated_at before update on public.modelos_email
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS + permissões: só admin
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['contatos','email_envios','emails_agendados','email_optout','email_eventos','modelos_email']
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
-- FUNÇÕES
-- =====================================================================

-- Valida formato de e-mail (a Resend recusa o lote inteiro se um estiver quebrado)
create or replace function public.email_valido(p text)
returns boolean
language sql
immutable
as $$
  select p ~* '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$' and p !~ '\.\.';
$$;

-- Monta os destinatários de um alvo. Usada pela tela (contagem) e pelo robô.
-- alvo: todos | tag:<nome> | lista | teste
-- lista: um e-mail por linha; aceita "nome;email" ou "email".
create or replace function public.destinatarios_email(p_alvo text, p_lista text default null)
returns table (email text, nome text)
language plpgsql
stable
set search_path = public
as $$
begin
  if p_alvo = 'todos' then
    return query
      select c.email, c.nome from contatos c
      where not c.descadastrado
        and not exists (select 1 from email_optout o where o.email = c.email)
        and email_valido(c.email);

  elsif p_alvo like 'tag:%' then
    return query
      select c.email, c.nome from contatos c
      where substr(p_alvo, 5) = any (c.tags)
        and not c.descadastrado
        and not exists (select 1 from email_optout o where o.email = c.email)
        and email_valido(c.email);

  elsif p_alvo = 'lista' then
    return query
      with linhas as (
        select trim(l) as l from regexp_split_to_table(coalesce(p_lista, ''), E'[\\n\\r]+') as l
      ), partes as (
        select
          lower(trim(case when position(';' in l) > 0 then split_part(l, ';', 2) else l end)) as e,
          nullif(trim(case when position(';' in l) > 0 then split_part(l, ';', 1) else '' end), '') as n
        from linhas where l <> ''
      ), unicos as (
        select distinct on (p.e) p.e, p.n from partes p where email_valido(p.e)
      )
      select u.e, coalesce(u.n, c.nome)
      from unicos u
      left join contatos c on c.email = u.e
      where not exists (select 1 from email_optout o where o.email = u.e)
        and coalesce(c.descadastrado, false) = false;

  elsif p_alvo = 'teste' then
    return query
      select lower(trim(cf.valor)), coalesce((select valor from configuracoes where chave = 'nome_exibicao'), 'Teste')
      from configuracoes cf
      where cf.chave = 'email_teste' and email_valido(lower(trim(cf.valor)));
  end if;
end;
$$;

create or replace function public.contar_destinatarios(p_alvo text, p_lista text default null)
returns int
language sql
stable
set search_path = public
as $$
  select count(*)::int from public.destinatarios_email(p_alvo, p_lista);
$$;

-- Tags com quantidade de contatos
create or replace function public.contatos_tags()
returns table (tag text, qtd int)
language sql
stable
set search_path = public
as $$
  select t, count(*)::int from contatos, unnest(tags) as t
  where not descadastrado
  group by t order by t;
$$;

-- Importa contatos. p: [{nome, email}]. Junta tags sem apagar as antigas.
create or replace function public.importar_contatos(p jsonb, p_tags text[] default '{}', p_origem text default 'importacao')
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_novos int := 0;
  v_atualizados int := 0;
  v_invalidos int := 0;
  r record;
  v_email text;
  v_existia boolean;
begin
  if not public.is_admin() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'sem permissão';
  end if;
  for r in select * from jsonb_to_recordset(p) as x(nome text, email text) loop
    v_email := lower(trim(r.email));
    if v_email is null or not email_valido(v_email) then
      v_invalidos := v_invalidos + 1;
      continue;
    end if;
    select true into v_existia from contatos where email = v_email;
    insert into contatos (nome, email, tags, origem)
    values (nullif(trim(r.nome), ''), v_email, coalesce(p_tags, '{}'), p_origem)
    on conflict (email) do update set
      nome = coalesce(nullif(trim(excluded.nome), ''), contatos.nome),
      tags = (select coalesce(array_agg(distinct x order by x), '{}') from unnest(contatos.tags || excluded.tags) x);
    if coalesce(v_existia, false) then v_atualizados := v_atualizados + 1; else v_novos := v_novos + 1; end if;
    v_existia := null;
  end loop;
  return jsonb_build_object('novos', v_novos, 'atualizados', v_atualizados, 'invalidos', v_invalidos);
end;
$$;

-- Assuntos já enviados (pro filtro do histórico)
create or replace function public.email_assuntos()
returns table (assunto text, qtd int, ultimo timestamptz)
language sql
stable
set search_path = public
as $$
  select assunto, count(*)::int, max(ts) from email_envios
  where assunto is not null
  group by assunto order by max(ts) desc limit 200;
$$;

-- Números do histórico (com taxas quando o webhook estiver ligado)
create or replace function public.email_stats(p_assunto text default null, p_dias int default 30)
returns jsonb
language sql
stable
set search_path = public
as $$
  with env as (
    select * from email_envios
    where (p_assunto is null or assunto = p_assunto)
      and ts >= now() - make_interval(days => p_dias)
      and origem <> 'teste'
  ), ev as (
    select e.tipo, e.resend_id from email_eventos e
    where e.resend_id in (select resend_id from env where resend_id is not null)
  )
  select jsonb_build_object(
    'enviados',   (select count(*) from env where status = 'ok'),
    'falhas',     (select count(*) from env where status = 'erro'),
    'entregues',  (select count(distinct resend_id) from ev where tipo = 'email.delivered'),
    'abertos',    (select count(distinct resend_id) from ev where tipo = 'email.opened'),
    'cliques',    (select count(distinct resend_id) from ev where tipo = 'email.clicked'),
    'bounces',    (select count(distinct resend_id) from ev where tipo = 'email.bounced'),
    'reclamacoes',(select count(distinct resend_id) from ev where tipo = 'email.complained'),
    'webhook_ativo', exists (select 1 from email_eventos)
  );
$$;

-- O robô pega 1 agendamento por vez, sem risco de dois robôs pegarem o mesmo.
-- Também destrava um que ficou "enviando" por mais de 5 minutos (function morreu).
create or replace function public.pegar_email_agendado()
returns setof public.emails_agendados
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  select id into v_id from emails_agendados
  where (status = 'pendente' and agendado_para <= now())
     or (status = 'enviando' and lock_at < now() - interval '5 minutes')
  order by agendado_para
  limit 1
  for update skip locked;

  if v_id is null then return; end if;

  return query
    update emails_agendados set status = 'enviando', lock_at = now(), erro = null
    where id = v_id
    returning *;
end;
$$;
revoke all on function public.pegar_email_agendado() from public, anon, authenticated;
grant execute on function public.pegar_email_agendado() to service_role;

grant execute on function
  public.email_valido(text),
  public.destinatarios_email(text, text),
  public.contar_destinatarios(text, text),
  public.contatos_tags(),
  public.importar_contatos(jsonb, text[], text),
  public.email_assuntos(),
  public.email_stats(text, int)
to authenticated, service_role;

-- =====================================================================
-- ROBÔ (pg_cron): chama processar-emails-agendados a cada 1 minuto.
-- A URL do projeto e o SCHED_SECRET ficam no Vault (nunca no código).
-- Criados uma vez com:
--   select vault.create_secret('https://SEU_REF.supabase.co', 'project_url');
--   select vault.create_secret('O_MESMO_VALOR_DO_SCHED_SECRET', 'sched_secret');
-- =====================================================================
select cron.schedule(
  'emails-agendados',
  '* * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/processar-emails-agendados',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sched-key', (select decrypted_secret from vault.decrypted_secrets where name = 'sched_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $cron$
);

-- Conferência
select jobname, schedule, active from cron.job where jobname = 'emails-agendados';
