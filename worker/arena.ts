import { caseMarkdown, coreCaseMarkdown, coreCaseSchema, structuredCaseSchema } from '../shared/cases';
import { validateBlindText } from './sanitize';
import { HttpError, one, rows } from './db';
import { activeResponseSQL, applicableMetrics, type ArenaMatch, type Judgment, type Task, type User, type VoteValue } from '../shared/domain';
import { ballot, validateMetrics } from './validation';
import type { Filters } from './statistics';

export function randomSwap(): number { return crypto.getRandomValues(new Uint8Array(1))[0] & 1; }
interface Candidate { id: string; response_low: string; response_high: string; motion: string; category: string; task: Task; a: string; b: string; context: string | null; }
export async function displayRun(db: D1Database, id: string): Promise<string> {
  const run = await one<{ display_output: string; task: string }>(db, 'SELECT display_output,task FROM responses WHERE id=?', id);
  if (!run) throw new HttpError(404, 'Response not found');
  if (['government','opposition'].includes(run.task)) {
    const derived=await one<{case_json:string}>(db,`SELECT c.case_json FROM structured_cases c JOIN responses r ON r.id=c.response_id WHERE c.response_id=? AND c.status='ready' AND r.display_version=1`,id);
    if (derived) {
      try {
        const systems=await rows<{id:string;display_name:string;provider:string;model:string;interface:string}>(db,'SELECT * FROM systems');
        return validateBlindText(caseMarkdown(structuredCaseSchema.parse(JSON.parse(derived.case_json)),run.task),systems.flatMap(s=>[s.id,s.display_name,s.provider,s.model,s.interface]));
      } catch { /* Use validated display text if derived content cannot be blinded safely. */ }
    }
  }
  if (run.task !== 'full_opposition') return run.display_output;
  const stages = await one<{ prediction: string; rebuttal: string }>(db, `SELECT p.display_output prediction,r.display_output rebuttal FROM opposition_preps op JOIN responses p ON p.id=op.prediction_response_id JOIN responses r ON r.id=op.rebuttal_response_id WHERE op.response_id=?`, id);
  if (!stages) throw new HttpError(409, 'Incomplete Opposition pipeline');
  return `## Government argument predictions\n\n${stages.prediction}\n\n## Rebuttals · fresh context\n\n${stages.rebuttal}\n\n## Constructive material\n\n${run.display_output}`;
}
export async function nextMatch(db: D1Database, user: User, filters: Filters): Promise<ArenaMatch | null> {
  const where = [activeResponseSQL('r'), activeResponseSQL('r2'), "(r.task<>'rebuttal' OR r.government_source_response_id=r2.government_source_response_id)", "r.active=1", "r2.active=1", "s.active=1", "s2.active=1", "t.active=1", 'NOT EXISTS(SELECT 1 FROM arena_assignments seen WHERE seen.user_id=? AND seen.matchup_id=m.id)'];
  const params: (string | number)[] = [user.id, user.id, user.id];
  if (filters.category !== 'all') { where.push('t.category=?'); params.push(filters.category); }
  if (filters.task !== 'all') { where.push('r.task=?'); params.push(filters.task); }
  // All samples contribute to a system pair's judgment count. Recency penalizes repeated topics.
  const candidates = await rows<Candidate>(db, `WITH
    judged_pairs AS (SELECT min(a.system_id,b.system_id) sa,max(a.system_id,b.system_id) sb,count(*) n
      FROM human_votes hv JOIN arena_assignments aa ON aa.id=hv.id JOIN matchups mm ON mm.id=aa.matchup_id
      JOIN responses a ON a.id=mm.response_low JOIN responses b ON b.id=mm.response_high GROUP BY sa,sb),
    recent_topics AS (SELECT rr.topic_id FROM arena_assignments aa JOIN matchups mm ON mm.id=aa.matchup_id
      JOIN responses rr ON rr.id=mm.response_low WHERE aa.user_id=? ORDER BY aa.rowid DESC LIMIT 3),
    system_exposure AS (SELECT rr.system_id,count(*) n FROM arena_assignments aa JOIN matchups mm ON mm.id=aa.matchup_id
      JOIN responses rr ON rr.id=mm.response_low OR rr.id=mm.response_high WHERE aa.user_id=? GROUP BY rr.system_id),
    matchup_counts AS (SELECT aa.matchup_id,count(*) n FROM human_votes hv JOIN arena_assignments aa ON aa.id=hv.id GROUP BY aa.matchup_id)
    SELECT m.id,m.response_low,m.response_high,t.motion,t.category,r.task,r.system_id a,r2.system_id b,pool.core_case_json context
    FROM matchups m JOIN responses r ON r.id=m.response_low JOIN responses r2 ON r2.id=m.response_high
    JOIN systems s ON s.id=r.system_id JOIN systems s2 ON s2.id=r2.system_id JOIN topics t ON t.id=r.topic_id
    LEFT JOIN rebuttal_pool pool ON pool.government_response_id=r.government_source_response_id
    LEFT JOIN judged_pairs jp ON jp.sa=min(r.system_id,r2.system_id) AND jp.sb=max(r.system_id,r2.system_id)
    LEFT JOIN system_exposure e1 ON e1.system_id=r.system_id LEFT JOIN system_exposure e2 ON e2.system_id=r2.system_id
    LEFT JOIN matchup_counts mc ON mc.matchup_id=m.id
    WHERE ${where.join(' AND ')}
    ORDER BY (CASE WHEN r.topic_id IN (SELECT topic_id FROM recent_topics) THEN 8 ELSE 0 END)
      +coalesce(jp.n,0)*0.6+coalesce(mc.n,0)*2+(coalesce(e1.n,0)+coalesce(e2.n,0))*1.5
      +(abs(random()%1000)/1000.0)*3 LIMIT 8`, ...params);
  for (const c of candidates) {
    if (c.task==='rebuttal' && c.context) c.context=coreCaseMarkdown(coreCaseSchema.parse(JSON.parse(c.context)));
    const [low, high] = await Promise.all([displayRun(db, c.response_low), displayRun(db, c.response_high)]);
    const id = crypto.randomUUID(), swapped = randomSwap();
    const result = await db.prepare('INSERT OR IGNORE INTO arena_assignments(id,user_id,matchup_id,swapped,snapshot_low,snapshot_high,context_snapshot,motion_snapshot,category_snapshot,task_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, user.id, c.id, swapped, low, high, c.context, c.motion, c.category, c.task).run();
    if (!result.meta.changes) continue; // Another tab won this reservation; uniqueness remains atomic.
    return { id, motion: c.motion, category: c.category, task: c.task, metrics: applicableMetrics(c.task), a: swapped ? high : low, b: swapped ? low : high, context: c.context };
  }
  return null;
}
interface Assignment { id: string; swapped: number; snapshot_low: string; snapshot_high: string; context_snapshot: string | null; task: Task; motion: string; category: string; name_low: string; name_high: string; overall: number | null; updated_at: string; }
export async function getAssignment(db: D1Database, user: User, id: string): Promise<Assignment> {
  const result = await one<Assignment>(db, `SELECT aa.*,coalesce(aa.task_snapshot,r.task) task,coalesce(aa.motion_snapshot,t.motion) motion,coalesce(aa.category_snapshot,t.category) category,s.display_name name_low,s2.display_name name_high,v.overall,v.updated_at
    FROM arena_assignments aa JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low
    JOIN responses r2 ON r2.id=m.response_high JOIN topics t ON t.id=r.topic_id JOIN systems s ON s.id=r.system_id JOIN systems s2 ON s2.id=r2.system_id
    LEFT JOIN human_votes v ON v.id=aa.id WHERE aa.id=? AND aa.user_id=?`, id, user.id);
  if (!result) throw new HttpError(404, 'Judgment not found'); return result;
}
export async function saveVote(db: D1Database, user: User, id: string, input: unknown, edit: boolean) {
  const parsed = ballot.parse(input), assignment = await getAssignment(db, user, id);
  validateMetrics(assignment.task, parsed.metrics);
  if (edit && assignment.overall == null) throw new HttpError(404, 'Vote not found');
  if (!edit && assignment.overall != null) throw new HttpError(409, 'Already judged. Edit the existing judgment instead.');
  const sign = assignment.swapped ? -1 : 1;
  const statements = [edit
    ? db.prepare("UPDATE human_votes SET overall=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(parsed.overall * sign, id)
    : db.prepare('INSERT INTO human_votes(id,overall) VALUES(?,?)').bind(id, parsed.overall * sign)];
  if (edit) statements.push(db.prepare('DELETE FROM human_metric_votes WHERE vote_id=?').bind(id));
  for (const [metric, value] of Object.entries(parsed.metrics)) if (value != null) statements.push(db.prepare('INSERT INTO human_metric_votes(vote_id,metric,value) VALUES(?,?,?)').bind(id, metric, value * sign));
  statements.push(db.prepare('INSERT INTO human_vote_revisions(vote_id,revision,ballot_json) SELECT id,revision,? FROM human_votes WHERE id=?').bind(JSON.stringify({ overall: parsed.overall * sign, metrics: Object.fromEntries(Object.entries(parsed.metrics).map(([k,v]) => [k,v == null ? null : v * sign])) }), id));
  await db.batch(statements);
  return { saved: true, names: user.reveal_names ? { a: assignment.swapped ? assignment.name_high : assignment.name_low, b: assignment.swapped ? assignment.name_low : assignment.name_high } : undefined };
}
export async function judgmentDetail(db: D1Database, user: User, id: string): Promise<Judgment> {
  const a = await getAssignment(db, user, id);
  if (a.overall == null) throw new HttpError(404, 'Vote not found');
  const metricVotes = await rows<{ metric: string; value: number }>(db, 'SELECT metric,value FROM human_metric_votes WHERE vote_id=?', id);
  const sign = a.swapped ? -1 : 1;
  return { id, motion: a.motion, category: a.category, task: a.task, metrics: applicableMetrics(a.task), a: a.swapped ? a.snapshot_high : a.snapshot_low, b: a.swapped ? a.snapshot_low : a.snapshot_high, context: a.context_snapshot,
    overall: a.overall * sign as VoteValue, metric_votes: Object.fromEntries(metricVotes.map(m => [m.metric, m.value * sign])), updated_at: a.updated_at,
    names: user.reveal_names ? { a: a.swapped ? a.name_high : a.name_low, b: a.swapped ? a.name_low : a.name_high } : undefined };
}
