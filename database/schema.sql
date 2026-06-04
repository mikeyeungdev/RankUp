CREATE TABLE IF NOT EXISTS rankup_reviews (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  file_name TEXT NOT NULL,
  saved_as TEXT,
  transcript TEXT,
  analysis_summary TEXT,
  analysis_mode TEXT,
  confidence TEXT,
  transcribe_provider TEXT,
  analysis_provider TEXT,
  local_whisper_model TEXT,
  ollama_model TEXT,
  word_count INTEGER,
  segment_count INTEGER NOT NULL DEFAULT 0,
  raw_review JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS rankup_review_segments (
  id BIGSERIAL PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
  start_seconds INTEGER NOT NULL,
  end_seconds INTEGER,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rankup_focus_areas (
  id BIGSERIAL PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  why_it_matters TEXT,
  evidence TEXT,
  frequency INTEGER
);

CREATE TABLE IF NOT EXISTS rankup_recurring_mistakes (
  id BIGSERIAL PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
  mistake TEXT NOT NULL,
  fix TEXT,
  evidence TEXT
);

CREATE TABLE IF NOT EXISTS rankup_training_goals (
  id BIGSERIAL PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  target_concept TEXT,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rankup_knowledge_sources (
  id BIGSERIAL PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES rankup_reviews(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  title TEXT,
  score INTEGER
);
