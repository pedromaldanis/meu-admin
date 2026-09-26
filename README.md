# Painel Pedro Maldanis

Painel de admin só meu: disparo de e-mails, automação do Instagram, revisão do Instagram com dados e IA, e ideias e criativos.

- **Site:** HTML, CSS e JavaScript puros (sem build), publicado no GitHub Pages.
- **Back-end:** Supabase (Auth, Postgres com RLS, Storage, Edge Functions em Deno, pg_cron + pg_net).
- **Fuso:** tudo gravado em `timestamptz` e mostrado em horário de São Paulo (`America/Sao_Paulo`).

## Status das fases

| Fase | O quê | Status |
|---|---|---|
| 1 | Fundação: login, painel, configurações | ✅ pronta |
| 2 | 📧 Disparo de e-mails | ✅ pronta |
| 3 | 🤖 Automação do Instagram | ⏳ |
| 4 | 📊 Revisão do Instagram | ⏳ |
| 5 | 💡 Criativos e ideias | ⏳ |

---

## 1. Arquivos

```
login.html                  tela de login (e-mail e senha)
admin.html                  o painel, com as 5 abas
css/admin.css               visual (cores e fonte da FICHA)
js/config.js                URL do Supabase + chave anon (pública)
js/core.js                  cliente Supabase, toast, modal, datas em SP
js/login.js                 lógica do login
js/admin.js                 guarda de sessão + roteador de abas
js/abas/*.js                uma por aba
supabase/sql/0N-*.sql       SQL de cada fase (pode rodar mais de uma vez)
supabase/functions/<nome>/  Edge Functions
supabase/functions/_shared/ código comum (checagem de admin, x-sched-key, CORS)
supabase/config.toml        verify_jwt de cada function
```

## 2. Primeira vez (FASE 1)

1. **SQL:** Supabase > SQL Editor > cole `supabase/sql/01-fundacao.sql` > Run.
2. **Desligar cadastro público:** Authentication > Sign In / Providers > desmarque "Allow new users to sign up".
3. **Primeiro usuário:** Authentication > Users > Add user > Create new user, com `pedro@pedromaldanis.com.br`, uma senha forte e **Auto Confirm User** ligado.
4. **Virar admin:** rode de novo o `01-fundacao.sql` (ou só o bloco "PRIMEIRO ADMIN" no fim dele). A última consulta tem que mostrar 1 linha com `role = admin`.
5. **config.js:** em Project Settings > API, copie a **Project URL** e a chave **anon / publishable** para `js/config.js`. Essa chave é pública, pode ir pro site. A `service_role` NUNCA.
6. **Function:** `supabase functions deploy status-integracoes --project-ref SEU_REF`.

### Publicar no GitHub Pages

```bash
git remote add origin https://github.com/SEU_USUARIO/meu-admin.git
git push -u origin main
```

No GitHub: Settings > Pages > Source "Deploy from a branch" > Branch `main`, pasta `/ (root)` > Save. Em 1 ou 2 minutos o painel abre em `https://SEU_USUARIO.github.io/meu-admin/login.html`.

O repositório pode ser público: não há nenhuma chave secreta nele (confira sempre com `git grep`, ver seção 7).

### Testar localmente

```bash
python3 -m http.server 8080
```

E abra `http://localhost:8080/login.html`.

---

## 2.1 FASE 2: disparo de e-mails

1. **SQL:** `supabase/sql/02-disparo.sql` (liga `pg_cron` e `pg_net`, cria as tabelas e o robô).
2. **Vault** (uma vez só, guarda a URL e a senha do robô fora do código):
   ```sql
   select vault.create_secret('https://SEU_REF.supabase.co', 'project_url');
   select vault.create_secret('O_MESMO_VALOR_DO_SCHED_SECRET', 'sched_secret');
   ```
   O `sched_secret` do Vault tem que ser **igual** ao secret `SCHED_SECRET` das functions. Se trocar um, troque o outro.
3. **Resend:** domínio verificado (SPF e DKIM) e o secret `RESEND_API_KEY`.
4. **Webhook da Resend:** Resend > Webhooks > Add Webhook, com a URL
   `https://SEU_REF.supabase.co/functions/v1/resend-webhook` e os eventos `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`. Copie o "Signing secret" (`whsec_...`) pro secret `RESEND_WEBHOOK_SECRET`.
   Aberturas e cliques só são contados se "Open tracking" e "Click tracking" estiverem ligados no domínio, na Resend.

### Como o disparo funciona

- **Enviar agora:** o painel busca os destinatários e chama `send-bulk-email` em lotes de 50 (máx. 250 por chamada). Não feche a aba durante o envio.
- **Agendar:** grava em `emails_agendados`. O robô roda a cada minuto, pega 1 agendamento vencido, envia em lotes de 100 e pula quem já recebeu o mesmo assunto com sucesso (dá pra "continuar" um disparo que morreu no meio só reagendando).
- **Trava:** agendamento com 0 destinatários vira `erro`, nunca `enviado`.
- **Lista avulsa:** os e-mails colados viajam junto com o agendamento (`lista_emails`).
- **Cota da Resend:** se acabar, o envio para na hora e diz quantos ficaram de fora.
- **Descadastro:** o rodapé pede pra responder SAIR; marque a pessoa como descadastrada em Contatos. Bounce e reclamação de spam bloqueiam sozinhos (tabela `email_optout`).

## 3. Secrets (Edge Functions)

Configurados com `supabase secrets set NOME=valor --project-ref SEU_REF`. **Nunca** vão pro HTML, pro repositório ou pra tela. A aba ⚙️ Configurações só mostra se cada um existe.

| Secret | Pra quê | Fase |
|---|---|---|
| `SCHED_SECRET` | senha que o cron manda no header `x-sched-key` (gere com `openssl rand -hex 32`) | 2 |
| `RESEND_API_KEY` | enviar e-mails pela Resend | 2 |
| `RESEND_WEBHOOK_SECRET` | validar a assinatura do webhook da Resend | 2 |
| `IG_ACCESS_TOKEN` | token de longa duração (60 dias) do Instagram | 3 |
| `IG_ACCOUNT_ID` | id numérico da conta do Instagram | 3 |
| `APP_SECRET` | chave secreta do app do **Instagram** (não a do Facebook) | 3 |
| `VERIFY_TOKEN` | texto do handshake do webhook da Meta | 3 |
| `ANTHROPIC_API_KEY` ou `OPENAI_API_KEY` | IA (revisão, ideias, análises) | 4 |
| `SUPADATA_API_KEY` | transcrever vídeos | 5 |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` já existem sozinhos dentro das functions.

---

## 4. Edge Functions

> ⚠️ **ATENÇÃO:** as functions chamadas por **cron** ou **webhook** têm que ser publicadas com `--no-verify-jwt`.
> Se você republicar uma delas **sem** a flag, o cron quebra **em silêncio**: fica tomando 401 a cada minuto e nada é enviado.
> Elas se protegem sozinhas conferindo o header `x-sched-key` (ou a assinatura do webhook).

| Function | Quem chama | Proteção | Deploy | Fase |
|---|---|---|---|---|
| `status-integracoes` | painel | JWT + role admin | normal | 1 |
| `send-bulk-email` | painel | JWT + role admin | normal | 2 |
| `processar-emails-agendados` | cron (1 min) | `x-sched-key` | **`--no-verify-jwt`** | 2 |
| `resend-webhook` | Resend | assinatura Svix | **`--no-verify-jwt`** | 2 |
| `instagram-webhook` | Meta | `X-Hub-Signature-256` | **`--no-verify-jwt`** | 3 |
| `ig-scheduler` | cron (1 min) | `x-sched-key` | **`--no-verify-jwt`** | 3 |
| `ig-token-refresh` | cron (semanal) | `x-sched-key` | **`--no-verify-jwt`** | 3 |
| `ig-media` | painel | JWT + role admin | normal | 3 |
| `ig-test-send` | painel | JWT + role admin | normal | 3 |
| `ig-broadcast` | painel | JWT + role admin | normal | 3 |
| `ig-insights` | painel + cron (4h) | JWT admin ou `x-sched-key` | a definir na FASE 4 | 4 |
| `ig-comments` | painel | JWT + role admin | normal | 4 |
| `ig-review` | painel + cron (11h) | JWT admin ou `x-sched-key` | a definir na FASE 4 | 4 |
| `ig-competitors` | painel | JWT + role admin | normal | 4 |
| `ideias-ia` | painel | JWT + role admin | normal | 5 |
| `transcrever` | painel | JWT + role admin | normal | 5 |
| `estudar-roteiros` | painel | JWT + role admin | normal | 5 |

Deploy normal: `supabase functions deploy NOME --project-ref SEU_REF`
Deploy de cron/webhook: `supabase functions deploy NOME --project-ref SEU_REF --no-verify-jwt`

## 5. Crons (pg_cron + pg_net)

| Cron | Quando | Chama |
|---|---|---|
| `emails-agendados` ✅ | a cada 1 minuto | `processar-emails-agendados` |
| `ig-scheduler` | a cada 1 minuto | `ig-scheduler` |
| `ig-token-refresh` | toda segunda, 9h de SP | `ig-token-refresh` |
| `ig-insights-aquecer` | todo dia, 4h de SP | `ig-insights` |
| `ig-review-diaria` | todo dia, 11h de SP | `ig-review` |

O SQL de cada cron vem na fase correspondente. Ver os crons: `select * from cron.job;`. Ver as últimas execuções: `select * from cron.job_run_details order by start_time desc limit 20;`.

---

## 6. Segurança

- RLS ligado em **todas** as tabelas. Toda policy do painel usa `is_admin()`.
- Nada liberado pra `anon`, a não ser formulário público (se um dia existir).
- Function do painel: confere o JWT e `usuarios.role = 'admin'` antes de qualquer coisa.
- Function de cron/webhook: confere `x-sched-key` ou a assinatura, e é publicada com `--no-verify-jwt`.

## 7. Se quebrar, olhe aqui primeiro

| Sintoma | Causa mais comum |
|---|---|
| Login diz "não tem acesso de admin" | faltou rodar o bloco PRIMEIRO ADMIN do `01-fundacao.sql` |
| Erro 403 / "permission denied for table" | faltou o `grant ... to authenticated` da tabela (projetos novos do Supabase não liberam sozinhos) |
| Tela de login avisa "Falta preencher js/config.js" | URL e chave anon ainda não coladas |
| Card de integrações diz "não respondeu" | function `status-integracoes` não publicada |
| Cron com 401 a cada minuto | function republicada SEM `--no-verify-jwt`, ou `sched_secret` do Vault diferente do `SCHED_SECRET` |
| Agendado não sai | veja `select * from net._http_response order by created desc limit 5;` |
| E-mail não chega | domínio não verificado na Resend, ou caiu no spam |
| "RESEND_API_KEY não configurada" | falta o secret da Resend |
| Agendado virou erro "Nenhum destinatário" | o alvo estava vazio (tag sem ninguém, lista sem e-mail válido) |
| Taxa de abertura sempre "-" | webhook da Resend não cadastrado, ou tracking desligado no domínio |

(A tabela cresce a cada fase.)
