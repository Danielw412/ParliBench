-- Administrator console: audited corrections and explicit removals instead of silent mutation.
-- A corrected response keeps every earlier state in response_revisions. The provenance trigger still
-- rejects any update that does not first record the exact state it replaces, and structural
-- relationships (topic, task, sources, prompt revision) remain fixed for the life of the response.
ALTER TABLE responses ADD COLUMN provenance_revision INTEGER NOT NULL DEFAULT 1 CHECK(provenance_revision > 0);
CREATE TABLE response_revisions (
 response_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
 changed_by TEXT, reason TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(response_id,revision)
);
DROP TRIGGER preserve_raw_output;
CREATE TRIGGER preserve_raw_output BEFORE UPDATE OF raw_output,prompt,system_id,topic_id,task,standardized_task_id,generated_at,interface,reasoning,configuration,duration_ms,sample,context_id,government_source_response_id,opposition_source_response_id,prompt_revision_id,rebuttal_input_snapshot,provenance_revision ON responses
WHEN NEW.provenance_revision <> OLD.provenance_revision + 1
 OR NEW.topic_id IS NOT OLD.topic_id OR NEW.task IS NOT OLD.task OR NEW.standardized_task_id IS NOT OLD.standardized_task_id
 OR NEW.government_source_response_id IS NOT OLD.government_source_response_id OR NEW.opposition_source_response_id IS NOT OLD.opposition_source_response_id
 OR NEW.prompt_revision_id IS NOT OLD.prompt_revision_id OR NEW.rebuttal_input_snapshot IS NOT OLD.rebuttal_input_snapshot
 OR NOT EXISTS (SELECT 1 FROM response_revisions h WHERE h.response_id=OLD.id AND h.revision=OLD.provenance_revision)
BEGIN SELECT RAISE(ABORT,'Run provenance is immutable; import a new sample'); END;
-- A frozen Government source can leave the pool only through an explicit, recorded removal.
CREATE TABLE rebuttal_pool_removals (
 government_response_id TEXT NOT NULL, topic_id TEXT NOT NULL, core_case_json TEXT NOT NULL, frozen_by TEXT, frozen_at TEXT NOT NULL,
 removed_by TEXT, reason TEXT NOT NULL DEFAULT '', removed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
DROP TRIGGER keep_rebuttal_pool;
CREATE TRIGGER keep_rebuttal_pool BEFORE DELETE ON rebuttal_pool WHEN NOT EXISTS (
 SELECT 1 FROM rebuttal_pool_removals x WHERE x.government_response_id=OLD.government_response_id AND x.frozen_at=OLD.frozen_at
) BEGIN SELECT RAISE(ABORT,'Frozen Government sources are historical records'); END;
-- Actor usernames are snapshotted, so the log outlives deleted accounts. No foreign keys by design.
CREATE TABLE admin_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_username TEXT NOT NULL, action TEXT NOT NULL,
 entity TEXT NOT NULL, entity_id TEXT, summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX admin_audit_time ON admin_audit(created_at);
CREATE INDEX response_system_task ON responses(system_id,task);
CREATE INDEX assignment_matchup ON arena_assignments(matchup_id);
CREATE INDEX ai_vote_matchup ON ai_votes(matchup_id);
CREATE INDEX human_vote_time ON human_votes(updated_at);
