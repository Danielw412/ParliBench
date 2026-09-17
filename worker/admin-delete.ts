import { HttpError, one, rows } from './db';
import { audit, type Actor } from './audit';
import type { ImpactKind, ImpactReport } from '../shared/admin';

// A single JSON array parameter (?1) carries any number of response IDs into every statement.
const R = '(SELECT value FROM json_each(?1))';
const MATCHUPS = `(SELECT id FROM matchups WHERE response_low IN ${R} OR response_high IN ${R})`;
const ASSIGNMENTS = `(SELECT id FROM arena_assignments WHERE matchup_id IN ${MATCHUPS})`;
const CLAIMS = `(response_id IN ${R} OR government_source_response_id IN ${R} OR opposition_source_response_id IN ${R} OR prediction_response_id IN ${R} OR rebuttal_response_id IN ${R})`;

/** Adds every response whose recorded relationships depend on the seed: Rebuttals built on a source, legacy pipeline stages. */
export async function withDependents(db: D1Database, seed: string[]): Promise<string[]> {
  const found = new Set(seed);
  let frontier = [...seed];
  while (frontier.length) {
    const next = await rows<{ id: string }>(db, `SELECT id FROM responses WHERE government_source_response_id IN ${R} OR opposition_source_response_id IN ${R}
      UNION SELECT response_id FROM opposition_rebuttals WHERE prediction_response_id IN ${R}
      UNION SELECT response_id FROM opposition_preps WHERE prediction_response_id IN ${R} OR rebuttal_response_id IN ${R}`, JSON.stringify(frontier));
    frontier = next.map(r => r.id).filter(id => !found.has(id));
    frontier.forEach(id => found.add(id));
  }
  return [...found];
}

/** Children first, so enforced foreign keys never see an orphan. Votes on removed responses go with them. */
export function deleteResponseStatements(db: D1Database, ids: string[], actor: Actor, reason: string): D1PreparedStatement[] {
  const list = JSON.stringify(ids), run = (sql: string) => db.prepare(sql).bind(list);
  return [
    db.prepare('PRAGMA defer_foreign_keys = ON'),
    run(`DELETE FROM human_metric_votes WHERE vote_id IN ${ASSIGNMENTS}`),
    run(`DELETE FROM human_vote_revisions WHERE vote_id IN ${ASSIGNMENTS}`),
    run(`DELETE FROM human_votes WHERE id IN ${ASSIGNMENTS}`),
    run(`DELETE FROM arena_assignments WHERE matchup_id IN ${MATCHUPS}`),
    run(`DELETE FROM ai_metric_votes WHERE vote_id IN (SELECT id FROM ai_votes WHERE matchup_id IN ${MATCHUPS})`),
    run(`DELETE FROM ai_votes WHERE matchup_id IN ${MATCHUPS}`),
    run(`DELETE FROM matchups WHERE response_low IN ${R} OR response_high IN ${R}`),
    run(`DELETE FROM structured_case_revisions WHERE response_id IN ${R}`),
    run(`DELETE FROM structured_cases WHERE response_id IN ${R}`),
    run(`DELETE FROM response_display_revisions WHERE response_id IN ${R}`),
    run(`DELETE FROM response_revisions WHERE response_id IN ${R}`),
    db.prepare(`INSERT INTO rebuttal_pool_removals(government_response_id,topic_id,core_case_json,frozen_by,frozen_at,removed_by,reason)
      SELECT government_response_id,topic_id,core_case_json,frozen_by,frozen_at,?2,?3 FROM rebuttal_pool WHERE government_response_id IN ${R}`).bind(list, actor.id, reason || 'Source response deleted'),
    run(`DELETE FROM rebuttal_pool WHERE government_response_id IN ${R}`),
    run(`DELETE FROM run_claims WHERE ${CLAIMS}`),
    run(`DELETE FROM opposition_preps WHERE response_id IN ${R} OR prediction_response_id IN ${R} OR rebuttal_response_id IN ${R}`),
    run(`DELETE FROM opposition_rebuttals WHERE response_id IN ${R} OR prediction_response_id IN ${R}`),
    run(`DELETE FROM opposition_predictions WHERE response_id IN ${R}`),
    run(`UPDATE standardized_rebuttal_tasks SET government_response_id=NULL WHERE government_response_id IN ${R}`),
    run(`DELETE FROM responses WHERE id IN ${R}`),
  ];
}

interface Plan { report: ImpactReport; ids: string[]; seed: string[] }
async function plan(db: D1Database, kind: ImpactKind, id: string, actor: Actor): Promise<Plan> {
  const empty = { responses: 0, dependent_responses: 0, matchups: 0, assignments: 0, human_votes: 0, ai_votes: 0, claims: 0, pool_sources: 0, judges: 0, sessions: 0, blockers: [] as string[] };
  if (kind === 'judge') {
    const judge = await one<{ display_name: string; votes: number }>(db, 'SELECT display_name,(SELECT count(*) FROM ai_votes WHERE judge_id=j.id) votes FROM ai_judges j WHERE id=?', id);
    if (!judge) throw new HttpError(404, 'AI judge not found');
    return { ids: [], seed: [], report: { ...empty, label: judge.display_name, ai_votes: judge.votes, judges: 1 } };
  }
  if (kind === 'user') {
    const user = await one<{ username: string; is_admin: number; assignments: number; votes: number; sessions: number; prompts: number; frozen: number; admins: number }>(db, `SELECT username,is_admin,
      (SELECT count(*) FROM arena_assignments WHERE user_id=u.id) assignments,(SELECT count(*) FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id WHERE aa.user_id=u.id) votes,
      (SELECT count(*) FROM sessions WHERE user_id=u.id) sessions,(SELECT count(*) FROM prompt_revisions WHERE created_by=u.id) prompts,
      (SELECT count(*) FROM rebuttal_pool WHERE frozen_by=u.id) frozen,(SELECT count(*) FROM users WHERE is_admin=1) admins FROM users u WHERE id=?`, id);
    if (!user) throw new HttpError(404, 'Account not found');
    const blockers: string[] = [];
    if (id === actor.id) blockers.push('You cannot delete the account you are signed in with.');
    if (user.is_admin && user.admins <= 1) blockers.push('ParliBench must keep at least one administrator.');
    if (user.prompts || user.frozen) blockers.push('This account authored prompt revisions or froze Rebuttal sources, which are permanent records. Revoke access and reset the PIN instead.');
    return { ids: [], seed: [], report: { ...empty, label: user.username, assignments: user.assignments, human_votes: user.votes, sessions: user.sessions, blockers } };
  }
  let label: string | undefined, seed: string[];
  if (kind === 'response') {
    const run = await one<{ system_name: string; task: string; sample: number }>(db, 'SELECT s.display_name system_name,r.task,r.sample FROM responses r JOIN systems s ON s.id=r.system_id WHERE r.id=?', id);
    label = run ? `${run.system_name} · ${run.task} · sample ${run.sample}` : undefined;
    seed = run ? [id] : [];
  } else {
    const owner = kind === 'system' ? await one<{ label: string }>(db, 'SELECT display_name label FROM systems WHERE id=?', id) : await one<{ label: string }>(db, 'SELECT motion label FROM topics WHERE id=?', id);
    label = owner?.label;
    seed = (await rows<{ id: string }>(db, `SELECT id FROM responses WHERE ${kind === 'system' ? 'system_id' : 'topic_id'}=?`, id)).map(r => r.id);
  }
  if (!label) throw new HttpError(404, `${kind[0].toUpperCase()}${kind.slice(1)} not found`);
  const ids = await withDependents(db, seed);
  const system = kind === 'system' ? id : '', topic = kind === 'topic' ? id : '';
  const counts = await one<Omit<ImpactReport, 'label' | 'responses' | 'dependent_responses' | 'sessions' | 'blockers'>>(db, `SELECT
    (SELECT count(*) FROM matchups WHERE response_low IN ${R} OR response_high IN ${R}) matchups,
    (SELECT count(*) FROM arena_assignments WHERE matchup_id IN ${MATCHUPS}) assignments,
    (SELECT count(*) FROM human_votes WHERE id IN ${ASSIGNMENTS}) human_votes,
    (SELECT count(*) FROM ai_votes WHERE matchup_id IN ${MATCHUPS} OR judge_id IN (SELECT id FROM ai_judges WHERE system_id=?2)) ai_votes,
    (SELECT count(*) FROM run_claims WHERE ${CLAIMS} OR system_id=?2 OR topic_id=?3) claims,
    (SELECT count(*) FROM rebuttal_pool WHERE government_response_id IN ${R}) pool_sources,
    (SELECT count(*) FROM ai_judges WHERE system_id=?2) judges`, JSON.stringify(ids), system, topic);
  return { ids, seed, report: { ...empty, ...counts!, label, responses: seed.length, dependent_responses: ids.length - seed.length } };
}

export const impact = async (db: D1Database, kind: ImpactKind, id: string, actor: Actor) => (await plan(db, kind, id, actor)).report;

/** Deletes an entity and everything that cannot exist without it, then records what was removed. */
export async function deleteEntity(db: D1Database, kind: ImpactKind, id: string, actor: Actor, reason = '') {
  const { report, ids, seed } = await plan(db, kind, id, actor);
  if (report.blockers.length) throw new HttpError(409, report.blockers.join(' '));
  const statements: D1PreparedStatement[] = [];
  const judgeVotes = (where: string) => [
    db.prepare(`DELETE FROM ai_metric_votes WHERE vote_id IN (SELECT id FROM ai_votes WHERE ${where})`).bind(id),
    db.prepare(`DELETE FROM ai_votes WHERE ${where}`).bind(id),
  ];
  let detail: Record<string, unknown> = { impact: report, deleted_response_ids: ids.slice(0, 2000), reason };
  if (kind === 'response') detail = { ...detail, record: await one(db, 'SELECT * FROM responses WHERE id=?', id) };
  if (kind === 'system' || kind === 'topic') detail = { ...detail, record: await one(db, `SELECT * FROM ${kind === 'system' ? 'systems' : 'topics'} WHERE id=?`, id) };
  if (ids.length) statements.push(...deleteResponseStatements(db, ids, actor, reason));
  if (kind === 'system') statements.push(
    ...judgeVotes('judge_id IN (SELECT id FROM ai_judges WHERE system_id=?)'),
    db.prepare('DELETE FROM ai_judges WHERE system_id=?').bind(id), db.prepare('DELETE FROM run_claims WHERE system_id=?').bind(id),
    db.prepare('DELETE FROM systems WHERE id=?').bind(id));
  if (kind === 'topic') statements.push(
    db.prepare('DELETE FROM run_claims WHERE topic_id=?').bind(id), db.prepare('DELETE FROM standardized_rebuttal_tasks WHERE topic_id=?').bind(id),
    db.prepare('DELETE FROM topics WHERE id=?').bind(id));
  if (kind === 'judge') statements.push(...judgeVotes('judge_id=?'), db.prepare('DELETE FROM ai_judges WHERE id=?').bind(id));
  if (kind === 'user') {
    const mine = '(SELECT id FROM arena_assignments WHERE user_id=?)';
    statements.push(db.prepare('PRAGMA defer_foreign_keys = ON'),
      ...['human_metric_votes WHERE vote_id', 'human_vote_revisions WHERE vote_id', 'human_votes WHERE id'].map(t => db.prepare(`DELETE FROM ${t} IN ${mine}`).bind(id)),
      db.prepare('DELETE FROM arena_assignments WHERE user_id=?').bind(id), db.prepare('DELETE FROM sessions WHERE user_id=?').bind(id),
      db.prepare('DELETE FROM user_settings WHERE user_id=?').bind(id), db.prepare('UPDATE structured_case_revisions SET changed_by=NULL WHERE changed_by=?').bind(id),
      db.prepare('DELETE FROM users WHERE id=?').bind(id));
  }
  const noun = { response: 'response', system: 'system', topic: 'topic', judge: 'AI judge', user: 'account' }[kind];
  const cascade = [report.dependent_responses && `${report.dependent_responses} dependent responses`, report.human_votes && `${report.human_votes} human votes`, report.ai_votes && `${report.ai_votes} AI votes`].filter(Boolean).join(', ');
  statements.push(audit(db, actor, 'delete', kind, id, `Deleted ${noun} ${report.label}${seed.length > 1 ? ` with ${seed.length} responses` : ''}${cascade ? ` (${cascade})` : ''}`, detail));
  await db.batch(statements);
  return { deleted: true, impact: report };
}

export async function unfreezeSource(db: D1Database, responseId: string, actor: Actor, reason: string) {
  const source = await one<{ motion: string; responses: number; claims: number }>(db, `SELECT t.motion,
    (SELECT count(*) FROM responses WHERE government_source_response_id=p.government_response_id) responses,
    (SELECT count(*) FROM run_claims WHERE government_source_response_id=p.government_response_id AND status='open') claims
    FROM rebuttal_pool p JOIN topics t ON t.id=p.topic_id WHERE p.government_response_id=?`, responseId);
  if (!source) throw new HttpError(404, 'That response is not frozen in the Rebuttal Pool');
  if (source.responses || source.claims) throw new HttpError(409, `${source.responses} Rebuttal responses and ${source.claims} in-progress runs answer this frozen case. Delete or release them before removing it, so every system keeps answering the same source.`);
  await db.batch([
    db.prepare(`INSERT INTO rebuttal_pool_removals(government_response_id,topic_id,core_case_json,frozen_by,frozen_at,removed_by,reason) SELECT government_response_id,topic_id,core_case_json,frozen_by,frozen_at,?,? FROM rebuttal_pool WHERE government_response_id=?`).bind(actor.id, reason, responseId),
    db.prepare('DELETE FROM rebuttal_pool WHERE government_response_id=?').bind(responseId),
    audit(db, actor, 'unfreeze', 'rebuttal_pool', responseId, `Removed a frozen Government source for “${source.motion.slice(0, 120)}”`, { reason }),
  ]);
  return { removed: true };
}

export async function deleteHumanVote(db: D1Database, assignmentId: string, actor: Actor) {
  const vote = await one<{ username: string; motion: string | null; overall: number | null }>(db, 'SELECT u.username,aa.motion_snapshot motion,v.overall FROM arena_assignments aa JOIN users u ON u.id=aa.user_id LEFT JOIN human_votes v ON v.id=aa.id WHERE aa.id=?', assignmentId);
  if (!vote) throw new HttpError(404, 'Judgment not found');
  await db.batch([
    ...['human_metric_votes WHERE vote_id=?', 'human_vote_revisions WHERE vote_id=?', 'human_votes WHERE id=?', 'arena_assignments WHERE id=?'].map(t => db.prepare(`DELETE FROM ${t}`).bind(assignmentId)),
    audit(db, actor, 'delete', 'human_vote', assignmentId, `Deleted ${vote.username}’s ${vote.overall == null ? 'unvoted assignment' : 'judgment'}${vote.motion ? ` on “${vote.motion.slice(0, 100)}”` : ''}`),
  ]);
  return { deleted: true };
}
export async function deleteAiVote(db: D1Database, voteId: string, actor: Actor) {
  const vote = await one<{ judge: string; version: string }>(db, 'SELECT j.display_name judge,v.version FROM ai_votes v JOIN ai_judges j ON j.id=v.judge_id WHERE v.id=?', voteId);
  if (!vote) throw new HttpError(404, 'AI judgment not found');
  await db.batch([db.prepare('DELETE FROM ai_metric_votes WHERE vote_id=?').bind(voteId), db.prepare('DELETE FROM ai_votes WHERE id=?').bind(voteId),
    audit(db, actor, 'delete', 'ai_vote', voteId, `Deleted AI judgment ${voteId} from ${vote.judge} (${vote.version})`)]);
  return { deleted: true };
}
/** Unvoted assignments hold matchups a judge abandoned. Clearing old ones returns those pairs to matchmaking. */
export async function clearAssignments(db: D1Database, olderThanHours: number, userId: string | null, actor: Actor) {
  const where = `NOT EXISTS (SELECT 1 FROM human_votes v WHERE v.id=arena_assignments.id) AND issued_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?) ${userId ? 'AND user_id=?' : ''}`;
  const params = [`-${olderThanHours} hours`, ...(userId ? [userId] : [])];
  const count = await one<{ n: number }>(db, `SELECT count(*) n FROM arena_assignments WHERE ${where}`, ...params);
  await db.batch([db.prepare(`DELETE FROM arena_assignments WHERE ${where}`).bind(...params),
    audit(db, actor, 'cleanup', 'assignment', userId, `Cleared ${count?.n || 0} unvoted assignments older than ${olderThanHours} hours`, { older_than_hours: olderThanHours, user_id: userId })]);
  return { cleared: count?.n || 0 };
}
export async function deleteClaim(db: D1Database, claimId: string, actor: Actor) {
  const claim = await one<{ status: string; task: string; sample: number }>(db, 'SELECT status,task,sample FROM run_claims WHERE id=?', claimId);
  if (!claim) throw new HttpError(404, 'Run not found');
  if (claim.status === 'open') throw new HttpError(409, 'Release an in-progress run before deleting its record');
  await db.batch([db.prepare('DELETE FROM run_claims WHERE id=?').bind(claimId), audit(db, actor, 'delete', 'run', claimId, `Deleted ${claim.status} ${claim.task} run record (sample ${claim.sample})`)]);
  return { deleted: true };
}
