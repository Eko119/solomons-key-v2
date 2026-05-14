-- 0006_marketing_schema.sql

CREATE TABLE IF NOT EXISTS clients (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  industry        TEXT    NOT NULL,
  target_platform TEXT    NOT NULL,
  brand_voice     TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      TEXT    NOT NULL REFERENCES clients(id),
  platform       TEXT    NOT NULL,
  profile_url    TEXT    NOT NULL,
  display_name   TEXT,
  bio            TEXT,
  follower_count INTEGER,
  recent_posts   TEXT,
  content_hash   TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'unprocessed'
                         CHECK(status IN ('unprocessed','enriched','queued','sent','replied','converted','disqualified')),
  scraped_at     INTEGER NOT NULL,
  enriched_at    INTEGER,
  UNIQUE(content_hash)
);

CREATE TABLE IF NOT EXISTS outreach_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id         TEXT    NOT NULL REFERENCES clients(id),
  lead_id           INTEGER NOT NULL REFERENCES leads(id),
  draft_text        TEXT    NOT NULL,
  queued_at         INTEGER NOT NULL,
  sent_at           INTEGER,
  reply_received_at INTEGER,
  reply_text        TEXT,
  outcome           TEXT    CHECK(outcome IN ('no_reply','replied','converted','bounced') OR outcome IS NULL)
);

CREATE TABLE IF NOT EXISTS content_calendar (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT    NOT NULL REFERENCES clients(id),
  platform      TEXT    NOT NULL,
  post_text     TEXT    NOT NULL,
  scheduled_for INTEGER NOT NULL,
  posted_at     INTEGER,
  status        TEXT    NOT NULL DEFAULT 'scheduled'
                        CHECK(status IN ('scheduled','posted','failed','cancelled'))
);

CREATE TABLE IF NOT EXISTS marketing_analytics (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        TEXT    NOT NULL REFERENCES clients(id),
  period_start     INTEGER NOT NULL,
  period_end       INTEGER NOT NULL,
  leads_scraped    INTEGER NOT NULL DEFAULT 0,
  dms_sent         INTEGER NOT NULL DEFAULT 0,
  replies_received INTEGER NOT NULL DEFAULT 0,
  conversions      INTEGER NOT NULL DEFAULT 0,
  top_performing_hook TEXT,
  computed_at      INTEGER NOT NULL
);
