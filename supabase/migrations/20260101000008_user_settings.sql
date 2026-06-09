-- =============================================================================
-- Maquinita — User Settings (per-user configuration)
-- =============================================================================
-- Per-user configuration table. One row per user.
-- Stores budget ceiling for the semaphore and future settings.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  budget_ceiling_usd numeric(14, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_settings IS 'Per-user configuration. One row per user.';
COMMENT ON COLUMN public.user_settings.budget_ceiling_usd IS 'Monthly budget ceiling in USD for the semaphore.';

-- RLS: owner-only
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_settings: owner read" ON public.user_settings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_settings: owner write" ON public.user_settings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_settings: owner update" ON public.user_settings FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_settings: owner delete" ON public.user_settings FOR DELETE USING (auth.uid() = user_id);
