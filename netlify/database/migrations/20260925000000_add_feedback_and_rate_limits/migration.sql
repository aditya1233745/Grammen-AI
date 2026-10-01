-- Thumbs up/down feedback, one rating per message (a user can change their
-- mind, hence the upsert-friendly primary key on message_id alone).
CREATE TABLE IF NOT EXISTS message_feedback (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- A simple request log used for rate limiting. Netlify Functions are
-- stateless between invocations, so an in-memory counter wouldn't work
-- reliably — this uses Postgres instead as the shared, persistent counter.
-- Old rows are cleaned up automatically by the rate-limit check itself
-- (see checkRateLimit in api.mts), so this table never grows unbounded.
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id SERIAL PRIMARY KEY,
  rate_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_key_time ON rate_limit_log (rate_key, created_at);
