CREATE TABLE players (
  id UUID PRIMARY KEY,
  summoner_name TEXT NOT NULL,
  region TEXT NOT NULL,
  main_role TEXT NOT NULL,
  current_rank TEXT,
  target_rank TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vods (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  champion TEXT NOT NULL,
  role TEXT NOT NULL,
  matchup TEXT,
  result TEXT CHECK (result IN ('win', 'loss')),
  video_url TEXT NOT NULL,
  game_duration_seconds INTEGER,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE annotations (
  id UUID PRIMARY KEY,
  vod_id UUID NOT NULL REFERENCES vods(id) ON DELETE CASCADE,
  timestamp_seconds INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('macro', 'positioning', 'objective_control', 'mechanics', 'decision_making')
  ),
  severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE training_goals (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  target_category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ai_reports (
  id UUID PRIMARY KEY,
  vod_id UUID NOT NULL REFERENCES vods(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  recurring_mistakes JSONB NOT NULL,
  recommendations JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
