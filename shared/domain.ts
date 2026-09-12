export const METRICS = ['argument', 'evidence', 'creativity', 'strategy', 'threat', 'rebuttal'] as const;
export type Metric = typeof METRICS[number];
export const METRIC_LABELS: Record<Metric, string> = {
  argument: 'Argument Strength', evidence: 'Evidence / Examples', creativity: 'Creativity',
  strategy: 'Strategic Prioritization', threat: 'Threat Identification', rebuttal: 'Rebuttal Quality',
};
export const METRIC_HELP: Record<Metric, string> = {
  argument: 'Logic, warrants, mechanisms, impacts, and robustness.', evidence: 'Relevant, accurate facts, examples, and analogies.',
  creativity: 'Non-obvious arguments that are useful in the round.', strategy: 'Identifies and prioritizes the most important clashes.',
  threat: 'Predicts the strongest Government arguments.', rebuttal: 'Directly answers the opposing case with persuasive analysis.',
};
export const TASKS = ['government', 'prediction', 'standardized_rebuttal', 'full_opposition'] as const;
export type Task = typeof TASKS[number];
export const TASK_LABELS: Record<Task, string> = { government: 'Government', prediction: 'Opposition Prediction', standardized_rebuttal: 'Standardized Rebuttal', full_opposition: 'Full Opposition Prep' };
export function applicableMetrics(task: string): Metric[] {
  if (task === 'government') return METRICS.slice(0, 4);
  if (task === 'prediction') return [...METRICS.slice(0, 4), 'threat'];
  if (task === 'standardized_rebuttal') return [...METRICS.slice(0, 4), 'rebuttal'];
  return [...METRICS];
}
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
// A run is one execution of one system configuration on one motion. Rebuttal is a pipeline stage
// rather than an Arena category, so it is a run to schedule but never a task to rank.
export const RUN_TASKS = [...TASKS, 'rebuttal'] as const;
export type RunTask = typeof RUN_TASKS[number];
export const RUN_TASK_LABELS: Record<RunTask, string> = { ...TASK_LABELS, rebuttal: 'Opposition rebuttal (pipeline stage)' };
export const taskSide = (task: string) => task === 'government' ? 'Government' : 'Opposition';
export interface RunSlot { system_id: string; topic_id: string; task: RunTask; standardized_task_id: string | null; prediction_response_id: string | null; rebuttal_response_id: string | null; }
export interface RunPlan extends RunSlot {
  sample: number; system: SystemInfo; topic: { id: string; motion: string; category: string };
  standardized_case: { id: string; title: string; case_text: string } | null;
  upstream: { label: string; response_id: string; text: string }[]; prompt_reference: string | null;
}
export interface RunClaim extends RunPlan { claim_id: string; claimed_at: string; }
export interface RunBoard { recommendation: RunPlan | null; queue: RunClaim[]; }
