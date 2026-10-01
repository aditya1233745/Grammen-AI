-- Adds a per-user, per-agent label for the ongoing conversation — e.g.
-- renaming "Mandi Mitra AI" to "iPhone price research" so it's easier to
-- recognize in the sidebar. One label per (user, agent) pair, since each
-- agent still has exactly one continuous conversation, not multiple threads.

CREATE TABLE IF NOT EXISTS conversation_labels (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, agent_id)
);
