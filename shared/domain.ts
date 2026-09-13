export const METRICS = ['argument', 'evidence', 'creativity', 'strategy', 'rebuttal'] as const;
export const HISTORICAL_METRICS = [...METRICS, 'threat'] as const;
export type Metric = typeof METRICS[number];
export const METRIC_LABELS: Record<Metric, string> = {
  argument: 'Argument Strength', evidence: 'Evidence / Examples', creativity: 'Creativity',
  strategy: 'Strategic Prioritization', rebuttal: 'Rebuttal Quality',
};
export const METRIC_HELP: Record<Metric, string> = {
  argument: 'Logic, warrants, mechanisms, impacts, and robustness.', evidence: 'Relevant, accurate facts, examples, and analogies.',
  creativity: 'Non-obvious arguments that are useful in the round.', strategy: 'Identifies and prioritizes the most important clashes.',
  rebuttal: 'Directly answers the opposing case with persuasive analysis.',
};
export const TASKS = ['government', 'opposition', 'rebuttal'] as const;
export type Task = typeof TASKS[number];
export const HISTORICAL_TASKS = ['prediction', 'standardized_rebuttal', 'full_opposition'] as const;
export const TASK_LABELS: Record<Task, string> = { government: 'Government Case', opposition: 'Opposition Case', rebuttal: 'Rebuttal' };
export function applicableMetrics(task: string): Metric[] {
  return task === 'rebuttal' ? [...METRICS] : METRICS.slice(0, 4);
}
// Shared SQL predicate excludes old pipeline rebuttals, which used the same task identifier.
export const activeResponseSQL = (alias: string) => `(${alias}.task IN ('government','opposition') OR (${alias}.task='rebuttal' AND ${alias}.government_source_response_id IS NOT NULL AND ${alias}.opposition_source_response_id IS NOT NULL))`;
export type VoteValue = -2 | -1 | 0 | 1 | 2;
export const VOTE_OPTIONS = [{ value: 2, label: 'A much better', short: 'A ++' }, { value: 1, label: 'A better', short: 'A +' }, { value: 0, label: 'Tie', short: 'Tie' }, { value: -1, label: 'B better', short: 'B +' }, { value: -2, label: 'B much better', short: 'B ++' }] as const;
export type UserType = 'Parliamentary Debater' | 'Non-Parliamentary Debater';
export interface User { id: string; username: string; user_type: UserType; reveal_names: number; is_admin: number; }
export interface AccountRow { id: string; username: string; user_type: UserType; created_at: string; is_admin: number; }
export interface SystemInfo { id: string; display_name: string; provider: string; model: string; interface: string; reasoning: string | null; configuration: string; active: number; }
export interface RankingRow {
  id: string; display_name?: string; provider?: string; score: number; rating: number; win_rate: number;
  comparisons: number; ci: [number, number]; rating_ci: [number, number]; low_confidence: boolean; component: number;
}
export interface Leaderboard { rows: RankingRow[]; comparisons: number; method: string; source_weights: { human: number; ai: number }; missing_source?: string; }
export interface ArenaMatch {
  id: string; motion: string; category: string; task: Task; metrics: Metric[];
  a: string; b: string; context: string | null;
  names?: { a: string; b: string };
}
export interface BallotInput { overall: VoteValue; metrics: Partial<Record<Metric, VoteValue | null>>; }
export interface Judgment extends ArenaMatch { overall: VoteValue; metric_votes: Partial<Record<Metric, VoteValue | null>>; updated_at: string; }
export const RUN_TASKS = TASKS;
export type RunTask = Task;
export const RUN_TASK_LABELS = TASK_LABELS;
export const taskSide = (task: string) => task === 'government' ? 'Government' : 'Opposition';
export interface RunSlot { system_id: string; topic_id: string; task: RunTask; government_source_response_id: string | null; opposition_source_response_id: string | null; }
export interface PromptRevision { id: string; task: Task; version: number; template: string; created_at: string; created_by: string | null; }
export interface RunPlan extends RunSlot {
  sample: number; system: SystemInfo; topic: { id: string; motion: string; category: string };
  rendered_prompt: string; prompt_revision_id: string; prompt_version: number;
  upstream: { label: string; response_id: string; text: string }[];
}
export interface RunClaim extends RunPlan { claim_id: string; claimed_at: string; }
export interface RunBoard { recommendation: RunPlan | null; queue: RunClaim[]; systems: SystemInfo[]; }
