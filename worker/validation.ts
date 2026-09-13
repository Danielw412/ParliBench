import { z } from 'zod';
import { METRICS, HISTORICAL_METRICS, HISTORICAL_TASKS, RUN_TASKS, TASKS, applicableMetrics } from '../shared/domain';
import { HttpError } from './db';
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const short = z.string().trim().min(1).max(300);
export const text = z.string().min(1).max(100000);
export const voteValue = z.number().int().min(-2).max(2);
export const credentials = z.object({ username: z.string().regex(/^[A-Za-z0-9_]{3,24}$/), pin: z.string().regex(/^(?:\d{4}|\d{6})$/, 'PIN must contain exactly 4 or 6 digits') });
export const registration = credentials.extend({ user_type: z.enum(['Parliamentary Debater', 'Non-Parliamentary Debater']) });
export const ballot = z.object({ overall: voteValue, metrics: z.partialRecord(z.enum(METRICS), voteValue.nullable()).default({}) }).strict();
export function validateMetrics(task: string, metrics: Record<string, unknown>) {
  const allowed: readonly string[] = applicableMetrics(task);
  if (Object.keys(metrics).some(m => !allowed.includes(m))) throw new HttpError(400, 'Metric is not applicable to this task');
}
export const filterSchema = z.object({
  category: z.enum(['all', 'Serious', 'Informal']).default('all'),
  task: z.enum(['all', ...TASKS]).default('all'),
  source: z.enum(['human', 'ai', 'combined']).default('human'),
  subgroup: z.enum(['all', 'Parliamentary Debater', 'Non-Parliamentary Debater']).default('all'),
  metric: z.enum(['weighted', 'overall', ...METRICS]).default('overall'),
  judge: id.optional(),
});
export const systemSchema = z.object({ id, display_name: short, provider: short, model: short, interface: short, reasoning: short.nullable().default(null), configuration: z.string().max(5000).default(''), active: z.number().int().min(0).max(1).default(1) }).strict();
export const topicSchema = z.object({ id, motion: text, category: z.enum(['Serious', 'Informal']), active: z.number().int().min(0).max(1).default(1), metadata_json: z.string().max(10000).refine(s => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v); } catch { return false; } }, 'Metadata must be a JSON object').default('{}') }).strict();
export const responseSchema = z.object({
  id, system_id: id, topic_id: id, task: z.enum([...TASKS, ...HISTORICAL_TASKS]), standardized_task_id: id.nullable().default(null),
  government_source_response_id: id.nullable().default(null), opposition_source_response_id: id.nullable().default(null),
  prompt_revision_id: id.nullable().default(null), rebuttal_input_snapshot: text.nullable().default(null),
  raw_output: text, display_output: text, prompt: text, generated_at: z.iso.datetime(), interface: short,
  reasoning: short.nullable().default(null), configuration: z.string().max(5000).default(''), duration_ms: z.number().int().nonnegative().nullable().default(null),
  sample: z.number().int().positive().default(1), context_id: id,
}).strict();
// A scheduled run: which system configuration runs which motion, on which side, continuing which
// Opposition stage. The sample number and response ID are derived by the backend, never supplied.
export const runSlotSchema = z.object({system_id:id,topic_id:id,task:z.enum(RUN_TASKS),government_source_response_id:id.nullable().default(null),opposition_source_response_id:id.nullable().default(null)}).strict();
export const runResultSchema = responseSchema.pick({raw_output:true,display_output:true,generated_at:true,interface:true,reasoning:true,configuration:true,duration_ms:true,context_id:true}).extend({prompt:text.optional()});
export const importSchema = z.object({
  systems: z.array(systemSchema).default([]), topics: z.array(topicSchema).default([]),
  standardized_rebuttal_tasks: z.array(z.object({ id, topic_id: id, title: short, government_response_id: id.nullable().default(null), case_text: text }).strict()).default([]),
  responses: z.array(responseSchema).default([]),
  opposition_predictions: z.array(z.object({ response_id: id }).strict()).default([]),
  opposition_rebuttals: z.array(z.object({ response_id: id, prediction_response_id: id, fresh_context: z.literal(1) }).strict()).default([]),
  opposition_preps: z.array(z.object({ response_id: id, prediction_response_id: id, rebuttal_response_id: id }).strict()).default([]),
  ai_judges: z.array(z.object({ id, system_id: id, display_name: short, version: short }).strict()).default([]),
  ai_votes: z.array(z.object({ id, judge_id: id, response_a: id, response_b: id, overall: voteValue, metrics: z.partialRecord(z.enum(HISTORICAL_METRICS), voteValue.nullable()).default({}), explanation: z.string().max(10000).nullable().default(null), version: short, judged_at: z.iso.datetime(), snapshot_a: text, snapshot_b: text }).strict()).default([]),
}).strict().refine(v => Object.values(v).reduce((n, a) => n + a.length, 0) <= 500, 'Import at most 500 records per batch');
export type ImportData = z.infer<typeof importSchema>;
