// Administrator console API shapes. Public API types stay in domain.ts.
import type { PromptRevision, SystemInfo, UserType } from './domain';

/** Lightweight choices for admin filters and forms. */
export interface AdminOptions { systems: { id: string; display_name: string; active: number }[]; topics: { id: string; motion: string; category: string; active: number }[]; judges: { id: string; display_name: string }[]; }
export interface Page<T> { rows: T[]; total: number; offset: number; limit: number; }
export interface AuditEntry { id: number; actor_id: string | null; actor_username: string; action: string; entity: string; entity_id: string | null; summary: string; detail_json: string; created_at: string; }
export type ImpactKind = 'response' | 'system' | 'topic' | 'judge' | 'user';
/** What a deletion removes. Blockers explain why it cannot proceed at all. */
export interface ImpactReport {
  label: string; responses: number; dependent_responses: number; matchups: number; assignments: number; human_votes: number;
  ai_votes: number; claims: number; pool_sources: number; judges: number; sessions: number; blockers: string[];
}

export interface ScoreSummary { rank: number | null; score: number; rating: number; win_rate: number; comparisons: number; ci: [number, number]; low_confidence: boolean; }
export interface CoverageCell { system_id: string; topic_id: string; task: string; responses: number; active: number; open_claims: number; }
export interface AdminOverview {
  totals: {
    systems: number; active_systems: number; topics: number; active_topics: number; responses: number; active_responses: number;
    matchups: number; human_votes: number; human_votes_7d: number; ai_votes: number; ai_judges: number; users: number; users_7d: number; admins: number;
    unvoted_assignments: number; stale_assignments: number; open_claims: number; pool_sources: number; extraction_failed: number; extraction_missing: number;
  };
  responses_by_task: { task: string; responses: number; active: number }[];
  coverage: { systems: { id: string; display_name: string; active: number }[]; topics: { id: string; motion: string; category: string; active: number }[]; cells: CoverageCell[] };
  recent_responses: { id: string; system_name: string; motion: string; task: string; sample: number; generated_at: string }[];
  recent_votes: { id: string; username: string; motion: string; task: string; overall: number; updated_at: string }[];
  audit: AuditEntry[];
  configuration: { gemini: boolean; rebuttal_prompt: boolean; environment: string };
}
export interface SystemStats extends SystemInfo {
  responses: number; active_responses: number; government: number; opposition: number; rebuttal: number; legacy: number;
  topics_covered: number; extraction_ready: number; extraction_failed: number; open_claims: number; avg_duration_ms: number | null;
  last_generated_at: string | null; matchups: number; human_votes: number; ai_votes: number; judges: number; pool_sources: number;
  human: ScoreSummary | null; ai: ScoreSummary | null; combined: ScoreSummary | null;
}
export interface SystemDetail {
  system: SystemStats;
  topics: { topic_id: string; motion: string; category: string; active: number; government: number; opposition: number; rebuttal: number; open_claims: number }[];
  rankings: { label: string; summary: ScoreSummary | null }[];
  recent: { id: string; topic_id: string; motion: string; task: string; sample: number; active: number; generated_at: string }[];
}
export interface TopicStats {
  id: string; motion: string; category: 'Serious' | 'Informal'; active: number; metadata_json: string;
  responses: number; active_responses: number; government: number; opposition: number; rebuttal: number; legacy: number;
  systems_covered: number; open_claims: number; pool_sources: number; matchups: number; human_votes: number; ai_votes: number;
}

export interface AdminResponseRow {
  id: string; system_id: string; system_name: string; topic_id: string; motion: string; category: string; task: string; sample: number;
  active: number; generated_at: string; interface: string; duration_ms: number | null; display_version: number; provenance_revision: number;
  raw_length: number; extraction_status: string | null; frozen: number; legacy: number; matchups: number; human_votes: number; ai_votes: number;
}
export interface ResponseRecord {
  id: string; system_id: string; topic_id: string; task: string; standardized_task_id: string | null;
  government_source_response_id: string | null; opposition_source_response_id: string | null; prompt_revision_id: string | null;
  rebuttal_input_snapshot: string | null; raw_output: string; display_output: string; prompt: string; generated_at: string;
  interface: string; reasoning: string | null; configuration: string; duration_ms: number | null; sample: number; context_id: string;
  display_version: number; active: number; provenance_revision: number;
}
export interface ResponseDetail {
  response: ResponseRecord; system_name: string | null; motion: string; category: string;
  structure: { status: string; method: string; revision: number; error: string | null } | null;
  counts: { matchups: number; assignments: number; human_votes: number; ai_votes: number; dependents: number };
  frozen_at: string | null; claim: { id: string; status: string; claimed_at: string; resolved_at: string | null } | null;
  revisions: { revision: number; snapshot_json: string; changed_by: string | null; reason: string; created_at: string }[];
  display_revisions: { version: number; display_output: string; changed_at: string }[];
}
/** Fields an administrator may correct. Topic, task, sources, and prompt revision stay fixed. */
export const CORRECTABLE_FIELDS = ['raw_output', 'prompt', 'generated_at', 'interface', 'reasoning', 'configuration', 'duration_ms', 'context_id', 'sample', 'system_id'] as const;

export interface AdminJudge { id: string; system_id: string; display_name: string; version: string; system_name: string; votes: number; latest_judged_at: string | null; }
export interface AdminAiVote {
  id: string; judge_id: string; judge_name: string; overall: number; metrics: string; version: string; judged_at: string; has_explanation: number;
  task: string; motion: string; response_low: string; response_high: string; system_low: string; system_high: string;
}
export interface AdminAiVoteDetail extends AdminAiVote { explanation: string | null; snapshot_low: string; snapshot_high: string; }
export interface AdminHumanVote {
  id: string; user_id: string; username: string; user_type: UserType; overall: number; metrics: string; revision: number; updated_at: string;
  task: string; motion: string; response_low: string; response_high: string; system_low: string; system_high: string;
}
export interface AdminHumanVoteDetail extends AdminHumanVote { snapshot_low: string; snapshot_high: string; context_snapshot: string | null; swapped: number; issued_at: string; }
export interface AdminAccount {
  id: string; username: string; user_type: UserType; created_at: string; is_admin: number; reveal_names: number;
  votes: number; assignments: number; last_vote_at: string | null; sessions: number; authored: number;
}
export interface RunHistoryRow {
  id: string; system_id: string; system_name: string; topic_id: string; motion: string; task: string; sample: number;
  status: 'open' | 'filled' | 'released'; response_id: string | null; claimed_at: string; resolved_at: string | null; prompt_version: number | null;
}
export interface PromptUsage extends PromptRevision { claims: number; responses: number; }
