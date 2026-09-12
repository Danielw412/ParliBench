-- Runs recommended by the scheduler and claimed by an administrator while the model is executed
-- offline. An open claim is an in-progress run: it counts as coverage so the next recommendation
-- does not duplicate it, and it holds the sample number reserved for the response being produced.
CREATE TABLE run_claims (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES systems(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  task TEXT NOT NULL CHECK(task IN ('government','prediction','rebuttal','standardized_rebuttal','full_opposition')),
  standardized_task_id TEXT REFERENCES standardized_rebuttal_tasks(id),
  prediction_response_id TEXT REFERENCES responses(id),
  rebuttal_response_id TEXT REFERENCES responses(id),
  sample INTEGER NOT NULL CHECK(sample > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','filled','released')),
  response_id TEXT REFERENCES responses(id),
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  CHECK((task = 'standardized_rebuttal') = (standardized_task_id IS NOT NULL)),
  CHECK((task IN ('rebuttal','full_opposition')) = (prediction_response_id IS NOT NULL)),
  CHECK((task = 'full_opposition') = (rebuttal_response_id IS NOT NULL))
);
-- One administrator holds one open claim per run slot; concurrent tabs cannot reserve the same sample.
CREATE UNIQUE INDEX run_claim_open_slot ON run_claims(system_id,topic_id,task,coalesce(standardized_task_id,''),sample) WHERE status='open';
CREATE INDEX run_claim_status ON run_claims(status,claimed_at);
