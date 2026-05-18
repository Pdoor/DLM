CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  bungie_membership_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id TEXT NOT NULL,
  sub_id TEXT NOT NULL,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sub_id)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS presence (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  online INTEGER NOT NULL,
  name TEXT,
  online_title INTEGER,
  checked_at INTEGER,
  PRIMARY KEY (user_id, friend_id)
);

CREATE INDEX IF NOT EXISTS idx_presence_user_id
ON presence (user_id);
