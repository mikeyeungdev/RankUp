CREATE TABLE players (
  id UUID PRIMARY KEY,
  summoner_name TEXT NOT NULL,
  region TEXT NOT NULL,
  main_role TEXT NOT NULL,
  current_rank TEXT,
  target_rank TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE coached_vods (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  champion TEXT NOT NULL,
  role TEXT NOT NULL,
  matchup TEXT,
  result TEXT CHECK (result IN ('win', 'loss')),
  video_url TEXT NOT NULL,
  audio_url TEXT,
  duration_seconds INTEGER,
  processing_status TEXT NOT NULL DEFAULT 'uploaded' CHECK (
    processing_status IN ('uploaded', 'audio_extracted', 'transcribed', 'analyzed', 'failed')
  ),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE transcript_segments (
  id UUID PRIMARY KEY,
  vod_id UUID NOT NULL REFERENCES coached_vods(id) ON DELETE CASCADE,
  start_seconds INTEGER NOT NULL,
  end_seconds INTEGER,
  speaker TEXT NOT NULL DEFAULT 'coach',
  transcript_text TEXT NOT NULL,
  confidence NUMERIC(4, 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE league_concepts (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (
    category IN ('laning', 'macro', 'vision', 'objective_control', 'jungle_tracking', 'teamfighting')
  )
);

CREATE TABLE segment_concepts (
  segment_id UUID NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES league_concepts(id),
  severity INTEGER CHECK (severity BETWEEN 1 AND 5),
  PRIMARY KEY (segment_id, concept_id)
);

CREATE TABLE ai_reports (
  id UUID PRIMARY KEY,
  vod_id UUID NOT NULL REFERENCES coached_vods(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  important_concepts JSONB NOT NULL,
  recurring_mistakes JSONB NOT NULL,
  recommendations JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE training_goals (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  source_report_id UUID REFERENCES ai_reports(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  target_concept TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
