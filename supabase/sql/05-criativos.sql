-- =====================================================================
-- FASE 5: 💡 Criativos e ideias de conteúdo
-- (voz, quadro de ideias, roteiros de referência, carrosséis). Pode rodar mais de uma vez.
-- =====================================================================

-- Minha voz (1 linha só)
create table if not exists public.perfil_voz (
  id         int primary key default 1 check (id = 1),
  tom        text,
  expressoes text[] not null default '{}',
  evitar     text[] not null default '{}',
  publico    text,
  pilares    text[] not null default '{}',
  exemplos   text[] not null default '{}',
  objetivos  text[] not null default '{crescer,engajar,vender}',
  updated_at timestamptz not null default now()
);
insert into public.perfil_voz (id) values (1) on conflict (id) do nothing;

-- Quadro de ideias
create table if not exists public.ideias (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null,
  descricao     text,
  formato       text not null default 'reel' check (formato in ('reel', 'carrossel', 'story', 'foto', 'live')),
  estilo        text,
  status        text not null default 'ideia' check (status in ('ideia', 'roteirizando', 'gravado', 'editado', 'postado')),
  favorita      boolean not null default false,
  tags          text[] not null default '{}',
  origem        text not null default 'manual' check (origem in ('manual', 'ia', 'comentarios', 'referencia')),
  roteiro       jsonb not null default '{}'::jsonb,
  capa_url      text,
  agendado_para timestamptz,
  media_id      text,
  post_url      text,
  ordem         double precision not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ideias_status_idx on public.ideias (status, favorita desc, ordem);
drop trigger if exists trg_ideias_updated on public.ideias;
create trigger trg_ideias_updated before update on public.ideias
  for each row execute function public.set_updated_at();

-- Biblioteca de roteiros de referência (transcritos)
create table if not exists public.roteiros (
  id          uuid primary key default gen_random_uuid(),
  fonte       text check (fonte in ('instagram', 'tiktok', 'youtube', 'outro')),
  url         text not null,
  perfil      text,
  de_quem     text not null default 'outra' check (de_quem in ('minha', 'outra')),
  titulo      text,
  transcricao text,
  capa_url    text,
  tags        text[] not null default '{}',
  analise     jsonb,
  status      text not null default 'transcrevendo' check (status in ('transcrevendo', 'pronto', 'sem_fala', 'erro')),
  erro        text,
  job_id      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists trg_roteiros_updated on public.roteiros;
create trigger trg_roteiros_updated before update on public.roteiros
  for each row execute function public.set_updated_at();

-- Carrosséis montados
create table if not exists public.carrosseis (
  id         uuid primary key default gen_random_uuid(),
  titulo     text not null default 'Carrossel sem título',
  slides     jsonb not null default '[]'::jsonb,
  modelo     text,
  ideia_id   uuid references public.ideias(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_carrosseis_updated on public.carrosseis;
create trigger trg_carrosseis_updated before update on public.carrosseis
  for each row execute function public.set_updated_at();

-- Resultados de IA que rodam em segundo plano (ex.: "estudar roteiros")
create table if not exists public.ia_resultados (
  chave      text primary key,
  status     text not null default 'vazio' check (status in ('vazio', 'processando', 'pronto', 'erro')),
  payload    jsonb not null default '{}'::jsonb,
  erro       text,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['perfil_voz','ideias','roteiros','carrosseis','ia_resultados']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "só admin" on public.%I', t);
    execute format('create policy "só admin" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
  end loop;
end $$;

select 'FASE 5 pronta' as ok;
