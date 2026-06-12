-- Paddle subscription state, keyed by Cognito user_id (the JWT sub).
-- One row per user; updated by the Paddle webhook (billing.ts).
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                 TEXT PRIMARY KEY,
  plan                    TEXT NOT NULL DEFAULT 'free',   -- free | pro | pro_plus | enterprise
  cycle                   TEXT,                            -- monthly | yearly | null
  status                  TEXT NOT NULL DEFAULT 'inactive',-- Paddle status: active|trialing|past_due|paused|canceled|inactive
  price_id                TEXT,
  paddle_subscription_id  TEXT,
  paddle_customer_id      TEXT,
  current_period_end      TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Look up a subscription by its Paddle id (webhooks that lack custom_data.user_id,
-- e.g. some subscription.updated events, are reconciled via this).
CREATE INDEX IF NOT EXISTS idx_subscriptions_paddle_sub
  ON subscriptions (paddle_subscription_id);
