-- Recovered from the remote migration history (version 20260610230045); this
-- migration was applied to production without being committed to the repo.
--
-- push_subscriptions — Web Push endpoints registered by the PWA client.

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  keys_p256dh text NOT NULL,
  keys_auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
