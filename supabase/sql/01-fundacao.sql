-- =====================================================================
-- FASE 1: FUNDAÇÃO
-- usuarios + is_admin() + configuracoes, tudo com RLS.
-- Pode rodar quantas vezes quiser: nada quebra, nada duplica.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Função genérica pra manter updated_at sempre atualizado
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- usuarios: quem pode entrar no painel
-- ---------------------------------------------------------------------
create table if not exists public.usuarios (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  nome       text,
  role       text not null default 'admin',
  created_at timestamptz not null default now()
);

alter table public.usuarios enable row level security;

-- is_admin(): true se o usuário logado tem role='admin'.
-- security definer pra poder ler usuarios sem cair na própria RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

drop policy if exists "usuarios: ler a si mesmo ou admin" on public.usuarios;
create policy "usuarios: ler a si mesmo ou admin"
  on public.usuarios for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "usuarios: admin escreve" on public.usuarios;
create policy "usuarios: admin escreve"
  on public.usuarios for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------
-- configuracoes: chave/valor do painel (remetente, e-mail de teste etc.)
-- ---------------------------------------------------------------------
create table if not exists public.configuracoes (
  chave      text primary key,
  valor      text,
  updated_at timestamptz not null default now()
);

alter table public.configuracoes enable row level security;

drop trigger if exists trg_configuracoes_updated_at on public.configuracoes;
create trigger trg_configuracoes_updated_at
  before update on public.configuracoes
  for each row execute function public.set_updated_at();

drop policy if exists "configuracoes: só admin" on public.configuracoes;
create policy "configuracoes: só admin"
  on public.configuracoes for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Valores iniciais (da FICHA). Não sobrescreve o que você já mudou no painel.
insert into public.configuracoes (chave, valor) values
  ('nome_exibicao',     'Pedro Maldanis'),
  ('instagram_usuario', 'pedromaldanis'),
  ('remetente_nome',    'Pedro Maldanis'),
  ('remetente_email',   'pedro@pedromaldanis.com.br'),
  ('reply_to',          'pedro@pedromaldanis.com.br'),
  ('email_teste',       'pedro@pedromaldanis.com.br'),
  ('ig_conta_teste',    'pedromaldanis')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------
-- PERMISSÕES DA API
-- Projetos novos do Supabase não dão acesso automático às tabelas.
-- Sem estes grants, o painel toma 403 mesmo com RLS certo.
-- Só "authenticated" recebe acesso; quem filtra linha a linha é o RLS.
-- ---------------------------------------------------------------------
revoke all on public.usuarios, public.configuracoes from anon;
revoke truncate, references, trigger on public.usuarios, public.configuracoes from authenticated;
grant select, insert, update, delete on public.usuarios, public.configuracoes to authenticated;

-- ---------------------------------------------------------------------
-- PRIMEIRO ADMIN
-- 1) Crie o usuário em Authentication > Users > Add user
--    (e-mail pedro@pedromaldanis.com.br, senha forte, "Auto Confirm User" ligado).
-- 2) Rode este arquivo (ou só o bloco abaixo). Se o usuário ainda não
--    existir, o insert simplesmente não faz nada.
-- ---------------------------------------------------------------------
insert into public.usuarios (id, email, nome, role)
select id, email, 'Pedro Maldanis', 'admin'
from auth.users
where lower(email) = 'pedro@pedromaldanis.com.br'
on conflict (id) do update set role = 'admin', nome = excluded.nome, email = excluded.email;

-- Conferência: tem que aparecer 1 linha com role = admin
select id, email, nome, role from public.usuarios;
