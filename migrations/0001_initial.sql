PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL,
  user_type TEXT NOT NULL CHECK(user_type IN ('Parliamentary Debater','Non-Parliamentary Debater')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE user_settings (user_id TEXT PRIMARY KEY REFERENCES users(id), reveal_names INTEGER NOT NULL DEFAULT 0 CHECK(reveal_names IN (0,1)));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE systems (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  interface TEXT NOT NULL, reasoning TEXT, configuration TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE topics (
  id TEXT PRIMARY KEY, motion TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('Serious','Informal')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE standardized_rebuttal_tasks (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), title TEXT NOT NULL,
  government_response_id TEXT REFERENCES responses(id), case_text TEXT NOT NULL
);
CREATE TABLE responses (
  id TEXT PRIMARY KEY, system_id TEXT NOT NULL REFERENCES systems(id), topic_id TEXT NOT NULL REFERENCES topics(id),
  task TEXT NOT NULL CHECK(task IN ('government','prediction','rebuttal','standardized_rebuttal','full_opposition')),
  standardized_task_id TEXT REFERENCES standardized_rebuttal_tasks(id),
  raw_output TEXT NOT NULL, display_output TEXT NOT NULL, prompt TEXT NOT NULL,
  generated_at TEXT NOT NULL, interface TEXT NOT NULL, reasoning TEXT, configuration TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0), sample INTEGER NOT NULL DEFAULT 1 CHECK(sample > 0),
  context_id TEXT NOT NULL, display_version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  CHECK((task = 'standardized_rebuttal') = (standardized_task_id IS NOT NULL))
);
CREATE UNIQUE INDEX response_sample ON responses(system_id,topic_id,task,coalesce(standardized_task_id,''),sample);
CREATE INDEX response_topic_task ON responses(topic_id,task,active);
CREATE TRIGGER preserve_raw_output BEFORE UPDATE OF raw_output,prompt,system_id,topic_id,task,standardized_task_id,generated_at,interface,reasoning,configuration,duration_ms,sample,context_id ON responses
BEGIN SELECT RAISE(ABORT,'Run provenance is immutable; import a new sample'); END;
CREATE TABLE response_display_revisions (
  response_id TEXT NOT NULL REFERENCES responses(id), version INTEGER NOT NULL, display_output TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(response_id,version)
);
CREATE TABLE opposition_predictions (response_id TEXT PRIMARY KEY REFERENCES responses(id));
CREATE TABLE opposition_rebuttals (
  response_id TEXT PRIMARY KEY REFERENCES responses(id), prediction_response_id TEXT NOT NULL REFERENCES opposition_predictions(response_id),
  fresh_context INTEGER NOT NULL CHECK(fresh_context = 1)
);
CREATE TABLE opposition_preps (
  response_id TEXT PRIMARY KEY REFERENCES responses(id), prediction_response_id TEXT NOT NULL REFERENCES opposition_predictions(response_id),
  rebuttal_response_id TEXT NOT NULL REFERENCES opposition_rebuttals(response_id)
);
CREATE TABLE matchups (
  id TEXT PRIMARY KEY, response_low TEXT NOT NULL REFERENCES responses(id), response_high TEXT NOT NULL REFERENCES responses(id),
  CHECK(response_low < response_high), UNIQUE(response_low,response_high)
);
CREATE INDEX matchup_low ON matchups(response_low);
CREATE INDEX matchup_high ON matchups(response_high);
CREATE TABLE arena_assignments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), matchup_id TEXT NOT NULL REFERENCES matchups(id),
  swapped INTEGER NOT NULL CHECK(swapped IN (0,1)), snapshot_low TEXT NOT NULL, snapshot_high TEXT NOT NULL, context_snapshot TEXT,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(user_id,matchup_id)
);
CREATE INDEX assignment_user_time ON arena_assignments(user_id,issued_at);
CREATE TABLE human_votes (
  id TEXT PRIMARY KEY REFERENCES arena_assignments(id), overall INTEGER NOT NULL CHECK(overall BETWEEN -2 AND 2),
  revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE human_metric_votes (
  vote_id TEXT NOT NULL REFERENCES human_votes(id), metric TEXT NOT NULL CHECK(metric IN ('argument','evidence','creativity','strategy','threat','rebuttal')),
  value INTEGER NOT NULL CHECK(value BETWEEN -2 AND 2), PRIMARY KEY(vote_id,metric)
);
CREATE TABLE human_vote_revisions (
  vote_id TEXT NOT NULL REFERENCES human_votes(id), revision INTEGER NOT NULL, ballot_json TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(vote_id,revision)
);
CREATE TABLE ai_judges (id TEXT PRIMARY KEY, system_id TEXT NOT NULL REFERENCES systems(id), display_name TEXT NOT NULL, version TEXT NOT NULL);
CREATE TABLE ai_votes (
  id TEXT PRIMARY KEY, judge_id TEXT NOT NULL REFERENCES ai_judges(id), matchup_id TEXT NOT NULL REFERENCES matchups(id),
  overall INTEGER NOT NULL CHECK(overall BETWEEN -2 AND 2), explanation TEXT, version TEXT NOT NULL, judged_at TEXT NOT NULL,
  snapshot_low TEXT NOT NULL, snapshot_high TEXT NOT NULL, UNIQUE(judge_id,matchup_id,version)
);
CREATE TABLE ai_metric_votes (
  vote_id TEXT NOT NULL REFERENCES ai_votes(id), metric TEXT NOT NULL CHECK(metric IN ('argument','evidence','creativity','strategy','threat','rebuttal')),
  value INTEGER NOT NULL CHECK(value BETWEEN -2 AND 2), PRIMARY KEY(vote_id,metric)
);
CREATE TABLE benchmark_weights (task TEXT NOT NULL, metric TEXT NOT NULL, weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1), PRIMARY KEY(task,metric));
CREATE TABLE source_weights (id INTEGER PRIMARY KEY CHECK(id=1), human REAL NOT NULL CHECK(human BETWEEN 0 AND 1), ai REAL NOT NULL CHECK(ai BETWEEN 0 AND 1), CHECK(abs(human + ai - 1) < 0.000001));
INSERT INTO source_weights VALUES(1,0.5,0.5);
INSERT INTO benchmark_weights VALUES
('government','argument',0.45),('government','evidence',0.20),('government','creativity',0.20),('government','strategy',0.15),
('prediction','argument',0.30),('prediction','evidence',0.10),('prediction','creativity',0.15),('prediction','strategy',0.15),('prediction','threat',0.30),
('standardized_rebuttal','argument',0.30),('standardized_rebuttal','evidence',0.15),('standardized_rebuttal','creativity',0.10),('standardized_rebuttal','strategy',0.15),('standardized_rebuttal','rebuttal',0.30),
('full_opposition','argument',0.30),('full_opposition','evidence',0.10),('full_opposition','creativity',0.10),('full_opposition','strategy',0.10),('full_opposition','threat',0.15),('full_opposition','rebuttal',0.25);
