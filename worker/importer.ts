import { extractImportedCases } from './cases';
import { z } from 'zod';
import { coreCaseForRebuttal, coreCaseSchema, structuredCaseSchema } from '../shared/cases';
import { importSchema, validateMetrics, type ImportData } from './validation';
import { insert, rows } from './db';
import { validateBlindText } from './sanitize';
import { activeResponseSQL, type SystemInfo } from '../shared/domain';

type Run = ImportData['responses'][number];
type Standard = ImportData['standardized_rebuttal_tasks'][number];
function requireRef<T>(map: Map<string, T>, key: string, label: string): T {
  const value = map.get(key); if (!value) throw new Error(`Unknown ${label}: ${key}`); return value;
}
export function sameTask(a: Run, b: Run): boolean {
  return a.id !== b.id && a.system_id !== b.system_id && a.topic_id === b.topic_id && a.task === b.task && a.standardized_task_id === b.standardized_task_id && (a.task !== 'rebuttal' || (!!a.government_source_response_id && a.government_source_response_id === b.government_source_response_id));
}
export async function bulkImport(db: D1Database, input: unknown, claimId?: string) {
  const data = importSchema.parse(input);
  const [oldSystems, oldTopics, oldRuns, oldStandards, oldPredictions, oldRebuttals, oldPreps, oldJudges] = await Promise.all([
    rows<SystemInfo>(db, 'SELECT * FROM systems'), rows<{ id: string }>(db, 'SELECT id FROM topics'),
    rows<Run>(db, 'SELECT * FROM responses'), rows<Standard>(db, 'SELECT * FROM standardized_rebuttal_tasks'),
    rows<ImportData['opposition_predictions'][number]>(db, 'SELECT * FROM opposition_predictions'),
    rows<ImportData['opposition_rebuttals'][number]>(db, 'SELECT * FROM opposition_rebuttals'),
    rows<ImportData['opposition_preps'][number]>(db, 'SELECT * FROM opposition_preps'),
    rows<{ id: string }>(db, 'SELECT id FROM ai_judges'),
  ]);
  const systems = new Map([...oldSystems, ...data.systems].map(v => [v.id, v]));
  const topics = new Map([...oldTopics, ...data.topics].map(v => [v.id, v]));
  const runs = new Map([...oldRuns, ...data.responses].map(v => [v.id, v]));
  const standards = new Map([...oldStandards, ...data.standardized_rebuttal_tasks].map(v => [v.id, v]));
  const predictions = new Map([...oldPredictions, ...data.opposition_predictions].map(v => [v.response_id, v]));
  const rebuttals = new Map([...oldRebuttals, ...data.opposition_rebuttals].map(v => [v.response_id, v]));
  const preps = new Map([...oldPreps, ...data.opposition_preps].map(v => [v.response_id, v]));
  const judges = new Map([...oldJudges, ...data.ai_judges].map(v => [v.id, v]));
  const identities = [...systems.values()].flatMap(s => [s.id, s.display_name, s.provider, s.model, s.interface]);
  for (const [table, list] of Object.entries(data)) {
    const keys = list.map(v => 'id' in v ? v.id : v.response_id);
    if (new Set(keys).size !== keys.length) throw new Error(`Duplicate IDs in ${table}`);
  }
  for (const task of data.standardized_rebuttal_tasks) {
    requireRef(topics, task.topic_id, 'topic');
    if (task.government_response_id) {
      const gov = requireRef(runs, task.government_response_id, 'Government response');
      if (gov.task !== 'government' || gov.topic_id !== task.topic_id) throw new Error('Standardized case must reference Government on the same topic');
    }
    task.case_text = validateBlindText(task.case_text, identities);
  }
  for (const run of data.responses) {
    requireRef(systems, run.system_id, 'system'); requireRef(topics, run.topic_id, 'topic');
    if ((run.task === 'standardized_rebuttal') !== !!run.standardized_task_id) throw new Error('Standardized rebuttal requires a standardized_task_id; other tasks must omit it');
    if (run.standardized_task_id && requireRef(standards, run.standardized_task_id, 'standardized task').topic_id !== run.topic_id) throw new Error('Standardized task topic does not match');
    if (run.task === 'prediction') requireRef(predictions, run.id, 'prediction relationship');
    if (run.task === 'rebuttal' && !run.government_source_response_id) requireRef(rebuttals, run.id, 'historical rebuttal relationship');
    if (run.task !== 'rebuttal' && (run.government_source_response_id || run.opposition_source_response_id || run.rebuttal_input_snapshot)) throw new Error('Case generation receives only the motion');
    if (run.government_source_response_id || run.opposition_source_response_id) {
      if (!run.government_source_response_id || !run.opposition_source_response_id) throw new Error('Rebuttal requires both source cases');
      const gov=requireRef(runs,run.government_source_response_id,'Government source'), opp=requireRef(runs,run.opposition_source_response_id,'own Opposition source');
      if (gov.task!=='government' || opp.task!=='opposition' || gov.topic_id!==run.topic_id || opp.topic_id!==run.topic_id || opp.system_id!==run.system_id) throw new Error('Rebuttal requires same-topic Government and tested system own Opposition');
      const pool=await rows<{core_case_json:string}>(db,'SELECT core_case_json FROM rebuttal_pool WHERE government_response_id=? AND topic_id=?',gov.id,run.topic_id);
      if (!pool.length) throw new Error('Government response must be frozen in the Rebuttal Pool');
      const ready=await rows(db,`SELECT response_id FROM structured_cases WHERE response_id IN (?,?) AND status='ready'`,gov.id,opp.id);
      if (ready.length!==2) throw new Error('Both rebuttal sources require valid structured cases');
      if (!run.rebuttal_input_snapshot) throw new Error('Rebuttal requires an immutable compact input snapshot');
      const snapshot=JSON.parse(run.rebuttal_input_snapshot);
      z.tuple([coreCaseSchema,coreCaseSchema]).parse(snapshot);
      if (JSON.stringify(snapshot[0])!==JSON.stringify(JSON.parse(pool[0].core_case_json))) throw new Error('Government input must match the frozen core case');
      if (!claimId) {
        const own=await rows<{case_json:string}>(db,'SELECT case_json FROM structured_cases WHERE response_id=?',opp.id);
        if (JSON.stringify(snapshot[1])!==JSON.stringify(coreCaseForRebuttal(structuredCaseSchema.parse(JSON.parse(own[0].case_json))))) throw new Error('Opposition input must match the tested system own structured case');
      }
    }
    if (run.task === 'full_opposition') requireRef(preps, run.id, 'full Opposition relationship');
    run.display_output = validateBlindText(run.display_output, identities);
  }
  for (const pred of data.opposition_predictions) if (requireRef(runs, pred.response_id, 'prediction').task !== 'prediction') throw new Error('Prediction relationship requires a prediction run');
  for (const rel of data.opposition_rebuttals) {
    const run = requireRef(runs, rel.response_id, 'rebuttal');
    requireRef(predictions, rel.prediction_response_id, 'prediction relationship');
    const pred = requireRef(runs, rel.prediction_response_id, 'prediction');
    if (run.task !== 'rebuttal' || pred.task !== 'prediction' || run.topic_id !== pred.topic_id || run.context_id === pred.context_id) throw new Error('Rebuttal must use a fresh context and a prediction from the same topic');
  }
  for (const rel of data.opposition_preps) {
    const run = requireRef(runs, rel.response_id, 'full Opposition response');
    const pred = requireRef(runs, rel.prediction_response_id, 'prediction');
    const rebut = requireRef(runs, rel.rebuttal_response_id, 'rebuttal');
    const stage = requireRef(rebuttals, rel.rebuttal_response_id, 'rebuttal relationship');
    if (run.task !== 'full_opposition' || run.topic_id !== pred.topic_id || run.topic_id !== rebut.topic_id || stage.prediction_response_id !== pred.id) throw new Error('Full Opposition stages must reference the same pipeline and topic');
  }
  for (const judge of data.ai_judges) requireRef(systems, judge.system_id, 'judge system');
  const statements: D1PreparedStatement[] = [db.prepare('PRAGMA defer_foreign_keys = ON')];
  if (claimId) statements.push(db.prepare(`UPDATE run_claims SET status='filled',response_id=?,resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).bind(data.responses[0].id,claimId));
  for (const table of ['systems', 'topics', 'standardized_rebuttal_tasks', 'responses', 'opposition_predictions', 'opposition_rebuttals', 'opposition_preps', 'ai_judges'] as const) {
    for (const row of data[table]) statements.push(insert(db, table, row));
  }
  for (const run of data.responses) statements.push(insert(db, 'response_display_revisions', { response_id: run.id, version: 1, display_output: run.display_output }));
  for (const vote of data.ai_votes) {
    requireRef(judges, vote.judge_id, 'AI judge');
    const a = requireRef(runs, vote.response_a, 'response A'), b = requireRef(runs, vote.response_b, 'response B');
    if (!sameTask(a, b)) throw new Error('AI vote responses must be different systems on the same topic/task/case');
    validateMetrics(a.task, vote.metrics);
    const low = a.id < b.id ? a.id : b.id, high = a.id < b.id ? b.id : a.id, sign = a.id < b.id ? 1 : -1;
    const matchupId = `${low}~${high}`;
    statements.push(db.prepare('INSERT OR IGNORE INTO matchups(id,response_low,response_high) VALUES(?,?,?)').bind(matchupId, low, high));
    statements.push(insert(db, 'ai_votes', { id: vote.id, judge_id: vote.judge_id, matchup_id: matchupId, overall: vote.overall * sign, explanation: vote.explanation, version: vote.version, judged_at: vote.judged_at, snapshot_low: sign === 1 ? vote.snapshot_a : vote.snapshot_b, snapshot_high: sign === 1 ? vote.snapshot_b : vote.snapshot_a }));
    for (const [metric, value] of Object.entries(vote.metrics)) if (value != null) statements.push(insert(db, 'ai_metric_votes', { vote_id: vote.id, metric, value: value * sign }));
  }
  // One atomic batch: malformed references/duplicates roll back the entire import.
  // SQL builds canonical pair candidates without a quadratic JS query loop.
  statements.push(db.prepare(`INSERT OR IGNORE INTO matchups(id,response_low,response_high)
    SELECT a.id||'~'||b.id,a.id,b.id FROM responses a JOIN responses b
    ON a.id<b.id AND a.system_id<>b.system_id AND a.topic_id=b.topic_id AND a.task=b.task
    AND coalesce(a.standardized_task_id,'')=coalesce(b.standardized_task_id,'') WHERE ${activeResponseSQL('a')} AND (a.task<>'rebuttal' OR a.government_source_response_id=b.government_source_response_id)`));
  await db.batch(statements);
  await extractImportedCases(db,data.responses.filter(r=>['government','opposition'].includes(r.task)).map(r=>r.id));
  return { imported: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) };
}
