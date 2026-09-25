// Configuração pública do painel.
// A chave "anon" (publishable) do Supabase PODE ficar aqui: quem protege os dados é o RLS.
// NUNCA coloque aqui service role, chave da Resend, token do Instagram ou chave de IA.
window.APP_CONFIG = {
  SUPABASE_URL: "COLE_AQUI_A_URL_DO_PROJETO",       // ex.: https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: "COLE_AQUI_A_CHAVE_ANON",       // Project Settings > API Keys > anon / publishable
  NOME: "Pedro Maldanis",
  INSTAGRAM: "pedromaldanis",
  FUSO: "America/Sao_Paulo",
};
