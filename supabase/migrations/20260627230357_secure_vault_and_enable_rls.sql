-- Recovered from the remote migration history (version 20260627230357); this
-- migration was applied to production without being committed to the repo.

-- 1. Cerrar funciones de vault (secretos abiertos al público)
REVOKE EXECUTE ON FUNCTION public.vault_read_secret(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_write_secret(text, text) FROM anon, authenticated;

ALTER FUNCTION public.vault_write_secret(text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.vault_read_secret(text) SET search_path = public, pg_temp;

-- 2. RLS en tablas del ingest
ALTER TABLE public.push_ingest_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_parser_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_category_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfer_classification_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all" ON public.push_ingest_log
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "owner_all" ON public.push_parser_templates
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "owner_all" ON public.merchant_category_rules
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "owner_all" ON public.transfer_classification_rules
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 3. push_subscriptions (cliente web autenticado)
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
