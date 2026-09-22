-- Initial schema: user accounts + per-agent chat history.
-- Applied automatically by Netlify on deploy (and by `netlify dev` locally).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- For role='user': content is a JSON string (the plain message text).
  -- For role='assistant': content is a JSON object { raw, display } —
  -- see netlify/functions/api.mts for what those hold.
  content JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_user_agent ON messages (user_id, agent_id, id);
