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

CREATE TABLE IF NOT EXISTS friend_details_cache (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_details_cache_user_id
ON friend_details_cache (user_id);

CREATE TABLE IF NOT EXISTS raid_events (
  event_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  activity TEXT NOT NULL,
  description TEXT,
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  creator_user_id TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raid_events_starts_at
ON raid_events (starts_at);

CREATE TABLE IF NOT EXISTS raid_participants (
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  membership_id TEXT,
  participant_type TEXT NOT NULL DEFAULT 'auth',
  added_by_user_id TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_raid_participants_event_id
ON raid_participants (event_id);
