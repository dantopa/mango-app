-- Recovered from the remote migration history (version 20260611163109); this
-- migration was applied to production without being committed to the repo.

-- Auto-learned parser templates from LLM fallback
-- When the LLM successfully extracts a transaction from a new notification format,
-- it stores the pattern here so subsequent identical formats skip the LLM.
CREATE TABLE push_parser_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  package_name text NOT NULL,
  title_pattern text, -- regex pattern to match title (nullable = match any)
  text_pattern text NOT NULL, -- regex pattern to extract amount/merchant from text
  amount_group int NOT NULL DEFAULT 1, -- regex capture group index for amount
  merchant_group int, -- regex capture group index for merchant (nullable = no merchant)
  currency text NOT NULL DEFAULT 'COP',
  account_name text NOT NULL,
  is_expense boolean NOT NULL DEFAULT true, -- false = skip (delivery notifications, etc)
  hit_count int NOT NULL DEFAULT 0, -- how many times this template was used
  last_hit_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_parser_templates_package ON push_parser_templates(user_id, package_name);

COMMENT ON TABLE push_parser_templates IS 'Auto-learned regex templates from LLM fallback. Used to parse push notifications without LLM on subsequent matches.';
