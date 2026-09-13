-- Preserve historical data while extending task constraints. D1 keeps foreign keys enabled.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE prompt_revisions (
 id TEXT PRIMARY KEY, task TEXT NOT NULL CHECK(task IN ('government','opposition','rebuttal')),
 version INTEGER NOT NULL, template TEXT NOT NULL, created_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(task,version)
);
CREATE TRIGGER immutable_prompt_revision BEFORE UPDATE ON prompt_revisions BEGIN SELECT RAISE(ABORT,'Prompt revisions are immutable'); END;
CREATE TRIGGER keep_prompt_revision BEFORE DELETE ON prompt_revisions BEGIN SELECT RAISE(ABORT,'Prompt revisions are historical records'); END;
CREATE TABLE responses_next (
  id TEXT PRIMARY KEY, system_id TEXT NOT NULL REFERENCES systems(id), topic_id TEXT NOT NULL REFERENCES topics(id),
  task TEXT NOT NULL CHECK(task IN ('government','opposition','prediction','rebuttal','standardized_rebuttal','full_opposition')),
  standardized_task_id TEXT REFERENCES standardized_rebuttal_tasks(id),
  government_source_response_id TEXT REFERENCES responses(id),
  opposition_source_response_id TEXT REFERENCES responses(id),
  prompt_revision_id TEXT REFERENCES prompt_revisions(id),
  rebuttal_input_snapshot TEXT,
  raw_output TEXT NOT NULL, display_output TEXT NOT NULL, prompt TEXT NOT NULL,
  generated_at TEXT NOT NULL, interface TEXT NOT NULL, reasoning TEXT, configuration TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0), sample INTEGER NOT NULL DEFAULT 1 CHECK(sample > 0),
  context_id TEXT NOT NULL, display_version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  CHECK((task = 'standardized_rebuttal') = (standardized_task_id IS NOT NULL))
);
INSERT INTO responses_next (id,system_id,topic_id,task,standardized_task_id,raw_output,display_output,prompt,generated_at,interface,reasoning,configuration,duration_ms,sample,context_id,display_version,active) SELECT id,system_id,topic_id,task,standardized_task_id,raw_output,display_output,prompt,generated_at,interface,reasoning,configuration,duration_ms,sample,context_id,display_version,active FROM responses;
DROP TABLE responses;
ALTER TABLE responses_next RENAME TO responses;
CREATE UNIQUE INDEX response_sample ON responses(system_id,topic_id,task,coalesce(standardized_task_id,''),sample);
CREATE INDEX response_topic_task ON responses(topic_id,task,active);
CREATE TRIGGER preserve_raw_output BEFORE UPDATE OF raw_output,prompt,system_id,topic_id,task,standardized_task_id,generated_at,interface,reasoning,configuration,duration_ms,sample,context_id,government_source_response_id,opposition_source_response_id,prompt_revision_id,rebuttal_input_snapshot ON responses
BEGIN SELECT RAISE(ABORT,'Run provenance is immutable; import a new sample'); END;
CREATE TABLE run_claims_next (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES systems(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  task TEXT NOT NULL CHECK(task IN ('government','opposition','prediction','rebuttal','standardized_rebuttal','full_opposition')),
  standardized_task_id TEXT REFERENCES standardized_rebuttal_tasks(id),
  prediction_response_id TEXT REFERENCES responses(id),
  rebuttal_response_id TEXT REFERENCES responses(id),
  government_source_response_id TEXT REFERENCES responses(id),
  opposition_source_response_id TEXT REFERENCES responses(id),
  prompt_revision_id TEXT REFERENCES prompt_revisions(id),
  rendered_prompt TEXT,
  plan_snapshot TEXT,
  sample INTEGER NOT NULL CHECK(sample > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','filled','released')),
  response_id TEXT REFERENCES responses(id),
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  CHECK((task = 'standardized_rebuttal') = (standardized_task_id IS NOT NULL)),
  CHECK(task <> 'full_opposition' OR prediction_response_id IS NOT NULL),
  CHECK((task = 'full_opposition') = (rebuttal_response_id IS NOT NULL))
);
INSERT INTO run_claims_next (id,system_id,topic_id,task,standardized_task_id,prediction_response_id,rebuttal_response_id,sample,status,response_id,claimed_at,resolved_at) SELECT id,system_id,topic_id,task,standardized_task_id,prediction_response_id,rebuttal_response_id,sample,status,response_id,claimed_at,resolved_at FROM run_claims;
DROP TABLE run_claims;
ALTER TABLE run_claims_next RENAME TO run_claims;
CREATE UNIQUE INDEX run_claim_open_slot ON run_claims(system_id,topic_id,task,coalesce(standardized_task_id,''),sample) WHERE status='open';
CREATE INDEX run_claim_status ON run_claims(status,claimed_at);
-- Old unsnapshotted claims cannot safely receive a new template. Retain them as released history.
UPDATE run_claims SET status='released',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='open';
CREATE TRIGGER immutable_claim_prompt BEFORE UPDATE OF rendered_prompt,prompt_revision_id,plan_snapshot,system_id,topic_id,task,sample,government_source_response_id,opposition_source_response_id ON run_claims BEGIN SELECT RAISE(ABORT,'Claim provenance is immutable'); END;
CREATE TABLE structured_cases (
 response_id TEXT PRIMARY KEY REFERENCES responses(id), status TEXT NOT NULL CHECK(status IN ('ready','failed')),
 case_json TEXT, method TEXT NOT NULL, error TEXT, revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE structured_case_revisions (
 response_id TEXT NOT NULL REFERENCES responses(id), revision INTEGER NOT NULL, case_json TEXT,
 method TEXT NOT NULL, changed_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(response_id,revision)
);
CREATE TABLE rebuttal_pool (
 government_response_id TEXT PRIMARY KEY REFERENCES responses(id), topic_id TEXT NOT NULL REFERENCES topics(id),
 core_case_json TEXT NOT NULL, frozen_by TEXT REFERENCES users(id),
 frozen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER immutable_rebuttal_pool BEFORE UPDATE ON rebuttal_pool BEGIN SELECT RAISE(ABORT,'Frozen Government sources are immutable'); END;
CREATE TRIGGER keep_rebuttal_pool BEFORE DELETE ON rebuttal_pool BEGIN SELECT RAISE(ABORT,'Frozen Government sources are historical records'); END;
INSERT INTO benchmark_weights VALUES
('opposition','argument',0.45),('opposition','evidence',0.20),('opposition','creativity',0.20),('opposition','strategy',0.15),
('rebuttal','argument',0.30),('rebuttal','evidence',0.15),('rebuttal','creativity',0.10),('rebuttal','strategy',0.15),('rebuttal','rebuttal',0.30);

CREATE TRIGGER resolve_open_claim BEFORE UPDATE OF status ON run_claims WHEN NEW.status='filled' AND OLD.status<>'open' BEGIN SELECT RAISE(ABORT,'Claim is no longer open'); END;
CREATE TRIGGER protect_reserved_sample BEFORE INSERT ON responses WHEN EXISTS(
 SELECT 1 FROM run_claims c WHERE c.system_id=NEW.system_id AND c.topic_id=NEW.topic_id AND c.task=NEW.task AND c.sample=NEW.sample AND (c.status='open' OR (c.status='filled' AND c.response_id<>NEW.id))
) BEGIN SELECT RAISE(ABORT,'This sample is reserved by a started run'); END;
CREATE TRIGGER protect_imported_sample BEFORE INSERT ON run_claims WHEN EXISTS(
 SELECT 1 FROM responses r WHERE r.system_id=NEW.system_id AND r.topic_id=NEW.topic_id AND r.task=NEW.task AND r.sample=NEW.sample
) BEGIN SELECT RAISE(ABORT,'This sample has already been imported'); END;
-- SQLite's deferred counter does not recognize restored references after DROP + RENAME.
-- Check actual integrity before returning to immediate enforcement; any orphan aborts the batch.
CREATE TABLE migration_0005_integrity (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO migration_0005_integrity SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE migration_0005_integrity;
PRAGMA defer_foreign_keys = OFF;
