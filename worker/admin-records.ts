import { z } from 'zod';
import { HttpError, one, rows } from './db';
import { id, short, text } from './validation';
import { audit, type Actor } from './audit';
import { hashPin } from './auth';
import { extractCase, extractImportedCases, type ExtractorEnv } from './cases';
import { deleteResponseStatements, withDependents } from './admin-delete';
import { matchupStatement } from './importer';
import { validateBlindText } from './sanitize';
import { activeResponseSQL, TASKS, type SystemInfo } from '../shared/domain';
import { CORRECTABLE_FIELDS, type AdminAccount, type AdminAiVote, type AdminAiVoteDetail, type AdminHumanVote, type AdminHumanVoteDetail, type AdminJudge,
  type AdminResponseRow, type Page, type ResponseDetail, type ResponseRecord, type RunHistoryRow } from '../shared/admin';

const paging = { offset: z.coerce.number().int().min(0).max(1000000).default(0), limit: z.coerce.number().int().min(1).max(200).default(50) };
const query = <T extends z.ZodRawShape>(shape: T, params: URLSearchParams) => z.object({ ...shape, ...paging }).parse(Object.fromEntries(params));
const ACTIVE = (alias: string) => activeResponseSQL(alias);
async function page<T>(db: D1Database, select: string, from: string, where: string[], values: (string | number)[], order: string, offset: number, limit: number): Promise<Page<T>> {
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [total, list] = await Promise.all([
    one<{ n: number }>(db, `SELECT count(*) n ${from} ${clause}`, ...values),
    rows<T>(db, `SELECT ${select} ${from} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...values, limit, offset),
  ]);
  return { rows: list, total: total?.n || 0, offset, limit };
}
const identities = async (db: D1Database) => (await rows<SystemInfo>(db, 'SELECT * FROM systems')).flatMap(s => [s.id, s.display_name, s.provider, s.model, s.interface]);
function blind(value: string, known: string[]) {
  try { return validateBlindText(value, known); } catch (error) { throw new HttpError(400, (error as Error).message); }
}

// Responses ---------------------------------------------------------------------------------------
const taskFilter = z.enum(['all', ...TASKS, 'legacy']).default('all');
function taskWhere(task: string, alias: string, where: string[], values: (string | number)[]) {
  if (task === 'legacy') where.push(`NOT ${ACTIVE(alias)}`);
  else if (task !== 'all') { where.push(`${alias}.task=? AND ${ACTIVE(alias)}`); values.push(task); }
}
export async function listResponses(db: D1Database, params: URLSearchParams): Promise<Page<AdminResponseRow>> {
  const f = query({ system: id.optional(), topic: id.optional(), task: taskFilter, active: z.enum(['all', '1', '0']).default('all'),
    extraction: z.enum(['all', 'ready', 'failed', 'missing']).default('all'), frozen: z.enum(['all', '1']).default('all'), q: z.string().trim().max(200).default(''),
    sort: z.enum(['newest', 'oldest', 'system', 'topic', 'votes', 'longest']).default('newest') }, params);
  const where: string[] = [], values: (string | number)[] = [];
  if (f.system) { where.push('r.system_id=?'); values.push(f.system); }
  if (f.topic) { where.push('r.topic_id=?'); values.push(f.topic); }
  taskWhere(f.task, 'r', where, values);
  if (f.active !== 'all') { where.push('r.active=?'); values.push(Number(f.active)); }
  if (f.extraction === 'missing') where.push("r.task IN ('government','opposition') AND c.response_id IS NULL");
  else if (f.extraction !== 'all') { where.push('c.status=?'); values.push(f.extraction); }
  if (f.frozen === '1') where.push('p.government_response_id IS NOT NULL');
  if (f.q) { where.push('(instr(lower(r.id),lower(?))>0 OR instr(lower(t.motion),lower(?))>0 OR instr(lower(r.raw_output),lower(?))>0 OR instr(lower(r.context_id),lower(?))>0)'); values.push(f.q, f.q, f.q, f.q); }
  const votes = '(SELECT count(*) FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id JOIN matchups m ON m.id=aa.matchup_id WHERE m.response_low=r.id OR m.response_high=r.id)';
  const order = { newest: 'r.rowid DESC', oldest: 'r.rowid', system: 's.display_name,t.motion,r.task,r.sample', topic: 't.motion,r.task,s.display_name,r.sample', votes: `${votes} DESC,r.rowid DESC`, longest: 'length(r.raw_output) DESC' }[f.sort];
  return page<AdminResponseRow>(db, `r.id,r.system_id,s.display_name system_name,r.topic_id,t.motion,t.category,r.task,r.sample,r.active,r.generated_at,r.interface,r.duration_ms,
    r.display_version,r.provenance_revision,length(r.raw_output) raw_length,c.status extraction_status,p.government_response_id IS NOT NULL frozen,CASE WHEN ${ACTIVE('r')} THEN 0 ELSE 1 END legacy,
    (SELECT count(*) FROM matchups m WHERE m.response_low=r.id OR m.response_high=r.id) matchups,${votes} human_votes,
    (SELECT count(*) FROM ai_votes v JOIN matchups m ON m.id=v.matchup_id WHERE m.response_low=r.id OR m.response_high=r.id) ai_votes`,
  'FROM responses r JOIN systems s ON s.id=r.system_id JOIN topics t ON t.id=r.topic_id LEFT JOIN structured_cases c ON c.response_id=r.id LEFT JOIN rebuttal_pool p ON p.government_response_id=r.id',
  where, values, order, f.offset, f.limit);
}

export async function responseDetail(db: D1Database, responseId: string): Promise<ResponseDetail> {
  const response = await one<ResponseRecord & { system_name: string | null; motion: string; category: string }>(db, 'SELECT r.*,s.display_name system_name,t.motion,t.category FROM responses r LEFT JOIN systems s ON s.id=r.system_id JOIN topics t ON t.id=r.topic_id WHERE r.id=?', responseId);
  if (!response) throw new HttpError(404, 'Response not found');
  const [structure, counts, pool, claim, revisions, display, dependents] = await Promise.all([
    one<ResponseDetail['structure']>(db, 'SELECT status,method,revision,error FROM structured_cases WHERE response_id=?', responseId),
    one<Omit<ResponseDetail['counts'], 'dependents'>>(db, `SELECT (SELECT count(*) FROM matchups WHERE response_low=?1 OR response_high=?1) matchups,
      (SELECT count(*) FROM arena_assignments aa JOIN matchups m ON m.id=aa.matchup_id WHERE m.response_low=?1 OR m.response_high=?1) assignments,
      (SELECT count(*) FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id JOIN matchups m ON m.id=aa.matchup_id WHERE m.response_low=?1 OR m.response_high=?1) human_votes,
      (SELECT count(*) FROM ai_votes v JOIN matchups m ON m.id=v.matchup_id WHERE m.response_low=?1 OR m.response_high=?1) ai_votes`, responseId),
    one<{ frozen_at: string }>(db, 'SELECT frozen_at FROM rebuttal_pool WHERE government_response_id=?', responseId),
    one<ResponseDetail['claim']>(db, 'SELECT id,status,claimed_at,resolved_at FROM run_claims WHERE response_id=? ORDER BY claimed_at DESC LIMIT 1', responseId),
    rows<ResponseDetail['revisions'][number]>(db, 'SELECT revision,snapshot_json,changed_by,reason,created_at FROM response_revisions WHERE response_id=? ORDER BY revision DESC', responseId),
    rows<ResponseDetail['display_revisions'][number]>(db, 'SELECT version,display_output,changed_at FROM response_display_revisions WHERE response_id=? ORDER BY version DESC', responseId),
    withDependents(db, [responseId]),
  ]);
  const { system_name, motion, category, ...record } = response;
  return { response: record, system_name, motion, category, structure, counts: { ...counts!, dependents: dependents.length - 1 }, frozen_at: pool?.frozen_at || null, claim, revisions, display_revisions: display };
}

const correctionSchema = z.object({
  raw_output: text.optional(), prompt: text.optional(), generated_at: z.iso.datetime().optional(), interface: short.optional(),
  reasoning: short.nullable().optional(), configuration: z.string().max(5000).optional(), duration_ms: z.number().int().nonnegative().nullable().optional(),
  context_id: id.optional(), sample: z.number().int().positive().optional(), system_id: id.optional(),
  display_output: text.optional(), reason: z.string().trim().max(1000).default(''), reextract: z.boolean().default(false),
}).strict();
/** Corrects provenance in place while recording the exact prior state; topic, task, and sources never change. */
export async function correctResponse(db: D1Database, responseId: string, input: unknown, actor: Actor, env: ExtractorEnv, waitUntil: (p: Promise<unknown>) => void) {
  const parsed = correctionSchema.parse(input);
  const current = await one<ResponseRecord>(db, 'SELECT * FROM responses WHERE id=?', responseId);
  if (!current) throw new HttpError(404, 'Response not found');
  const changes = CORRECTABLE_FIELDS.filter(field => parsed[field] !== undefined && parsed[field] !== current[field]);
  const display = parsed.display_output !== undefined && parsed.display_output !== current.display_output ? blind(parsed.display_output, await identities(db)) : null;
  const reextract = parsed.reextract && ['government', 'opposition'].includes(current.task);
  if (!changes.length && display === null && !reextract) throw new HttpError(400, 'Nothing changed');
  const system = parsed.system_id ?? current.system_id, sample = parsed.sample ?? current.sample;
  if (changes.includes('system_id')) {
    if (!await one(db, 'SELECT id FROM systems WHERE id=?', system)) throw new HttpError(400, `Unknown system: ${system}`);
    if (current.opposition_source_response_id) throw new HttpError(409, 'A Rebuttal belongs to the system whose own Opposition case it answered. Delete it and record a new run instead.');
    const use = await one<{ rebuttals: number; claims: number; clash: number }>(db, `SELECT (SELECT count(*) FROM responses WHERE opposition_source_response_id=?1) rebuttals,
      (SELECT count(*) FROM run_claims WHERE opposition_source_response_id=?1 AND status='open') claims,
      (SELECT count(*) FROM matchups m JOIN responses o ON o.id=CASE WHEN m.response_low=?1 THEN m.response_high ELSE m.response_low END WHERE (m.response_low=?1 OR m.response_high=?1) AND o.system_id=?2) clash`, responseId, system);
    if (use!.rebuttals || use!.claims) throw new HttpError(409, 'Rebuttals were built on this Opposition case as the tested system’s own case. Delete those Rebuttals before reassigning it.');
    if (use!.clash) throw new HttpError(409, 'This response has already been compared against a response from that system. Delete it and re-import it under the correct system instead.');
  }
  if (changes.includes('system_id') || changes.includes('sample')) {
    const taken = await one<{ n: number }>(db, `SELECT (SELECT count(*) FROM responses WHERE system_id=?1 AND topic_id=?2 AND task=?3 AND coalesce(standardized_task_id,'')=?4 AND sample=?5 AND id<>?6)
      +(SELECT count(*) FROM run_claims WHERE system_id=?1 AND topic_id=?2 AND task=?3 AND sample=?5 AND (status='open' OR (status='filled' AND response_id<>?6))) n`,
    system, current.topic_id, current.task, current.standardized_task_id || '', sample, responseId);
    if (taken?.n) throw new HttpError(409, `Sample ${sample} is already recorded or reserved for that system, topic, and task`);
  }
  const statements: D1PreparedStatement[] = [];
  if (changes.length) statements.push(
    db.prepare(`INSERT INTO response_revisions(response_id,revision,snapshot_json,changed_by,reason) SELECT id,provenance_revision,json_object(${CORRECTABLE_FIELDS.map(f => `'${f}',${f}`).join(',')}),?,? FROM responses WHERE id=?`).bind(actor.id, parsed.reason, responseId),
    // Column names come only from CORRECTABLE_FIELDS.
    db.prepare(`UPDATE responses SET ${changes.map(f => `${f}=?`).join(',')},provenance_revision=provenance_revision+1 WHERE id=?`).bind(...changes.map(f => parsed[f] as string | number | null), responseId));
  if (display !== null) statements.push(
    db.prepare('UPDATE responses SET display_output=?,display_version=display_version+1 WHERE id=?').bind(display, responseId),
    db.prepare('INSERT INTO response_display_revisions(response_id,version,display_output) SELECT id,display_version,display_output FROM responses WHERE id=?').bind(responseId));
  if (changes.includes('system_id')) statements.push(matchupStatement(db));
  const described = [...changes, ...(display !== null ? ['display_output'] : []), ...(reextract ? ['structure (re-extracted)'] : [])];
  statements.push(audit(db, actor, 'correct', 'response', responseId, `Corrected ${described.join(', ')}`, { reason: parsed.reason, previous: Object.fromEntries(changes.map(f => [f, current[f]])), revision: current.provenance_revision }));
  await db.batch(statements);
  if (reextract) {
    // Mark the old derived case stale so a failed parse of corrected text cannot leave outdated structure in use.
    await db.batch([
      db.prepare(`UPDATE structured_cases SET status='failed',case_json=NULL,method='pending',error='Raw output corrected; extraction pending',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE response_id=?`).bind(responseId),
      db.prepare('INSERT OR IGNORE INTO structured_case_revisions(response_id,revision,case_json,method,changed_by) SELECT response_id,revision,case_json,method,? FROM structured_cases WHERE response_id=?').bind(actor.id, responseId),
    ]);
    if (env.GEMINI_API_KEY) waitUntil(extractImportedCases(db, [responseId], env)); else await extractCase(db, responseId, env);
  }
  return { saved: true, changed: described, queued_extraction: reextract && !!env.GEMINI_API_KEY };
}

const patchSchema = z.object({ display_output: z.string().min(1).max(100000).optional(), active: z.union([z.literal(0), z.literal(1)]).optional() }).strict();
export async function patchResponse(db: D1Database, responseId: string, input: unknown, actor: Actor) {
  const parsed = patchSchema.parse(input);
  if (parsed.display_output === undefined && parsed.active === undefined) throw new HttpError(400, 'Nothing to change');
  if (!await one(db, 'SELECT id FROM responses WHERE id=?', responseId)) throw new HttpError(404, 'Response not found');
  const statements: D1PreparedStatement[] = [];
  if (parsed.display_output !== undefined) {
    const clean = blind(parsed.display_output, await identities(db));
    statements.push(db.prepare('UPDATE responses SET display_output=?,display_version=display_version+1 WHERE id=?').bind(clean, responseId),
      db.prepare('INSERT INTO response_display_revisions(response_id,version,display_output) SELECT id,display_version,display_output FROM responses WHERE id=?').bind(responseId));
  }
  if (parsed.active !== undefined) statements.push(db.prepare('UPDATE responses SET active=? WHERE id=?').bind(parsed.active, responseId));
  const summary = [parsed.display_output !== undefined && 'Revised display text', parsed.active !== undefined && (parsed.active ? 'Activated' : 'Deactivated')].filter(Boolean).join('; ');
  statements.push(audit(db, actor, parsed.display_output !== undefined ? 'display' : 'status', 'response', responseId, summary));
  await db.batch(statements);
  return { saved: true };
}

const bulkSchema = z.object({ ids: z.array(id).min(1).max(200), action: z.enum(['activate', 'deactivate', 'delete', 'retry_extraction']), reason: z.string().trim().max(1000).default('') }).strict();
export async function bulkResponses(db: D1Database, input: unknown, actor: Actor, env: ExtractorEnv, waitUntil: (p: Promise<unknown>) => void) {
  const { ids, action, reason } = bulkSchema.parse(input);
  const existing = (await rows<{ id: string; task: string }>(db, 'SELECT id,task FROM responses WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify([...new Set(ids)])));
  if (!existing.length) throw new HttpError(404, 'None of those responses exist');
  const found = existing.map(r => r.id);
  if (action === 'delete') {
    const all = await withDependents(db, found);
    await db.batch([...deleteResponseStatements(db, all, actor, reason),
      audit(db, actor, 'delete', 'response', null, `Bulk deleted ${found.length} responses${all.length > found.length ? ` and ${all.length - found.length} dependents` : ''}`, { ids: all, reason })]);
    return { affected: all.length };
  }
  if (action === 'retry_extraction') {
    const cases = existing.filter(r => ['government', 'opposition'].includes(r.task)).map(r => r.id);
    await db.batch([audit(db, actor, 'extract', 'response', null, `Retried extraction for ${cases.length} cases`, { ids: cases })]);
    if (env.GEMINI_API_KEY) waitUntil(extractImportedCases(db, cases, env)); else await extractImportedCases(db, cases, env);
    return { affected: cases.length, queued: !!env.GEMINI_API_KEY };
  }
  const active = action === 'activate' ? 1 : 0;
  await db.batch([db.prepare('UPDATE responses SET active=? WHERE id IN (SELECT value FROM json_each(?))').bind(active, JSON.stringify(found)),
    audit(db, actor, 'status', 'response', null, `${active ? 'Activated' : 'Deactivated'} ${found.length} responses`, { ids: found, reason })]);
  return { affected: found.length };
}

// Catalog records ---------------------------------------------------------------------------------
export async function updateCatalogRecord(db: D1Database, table: 'systems' | 'topics', recordId: string, parsed: Record<string, string | number | null>, actor: Actor) {
  if (parsed.id !== recordId) throw new HttpError(400, 'ID cannot change');
  const before = await one<Record<string, unknown>>(db, `SELECT * FROM ${table} WHERE id=?`, recordId);
  if (!before) throw new HttpError(404, 'Record not found');
  const values = Object.entries(parsed).filter(([k]) => k !== 'id');
  const changed = values.filter(([k, v]) => before[k] !== v).map(([k]) => k);
  const noun = table === 'systems' ? 'system' : 'topic', label = String(before.display_name ?? before.motion).slice(0, 120);
  const summary = changed.length === 1 && changed[0] === 'active' ? `${parsed.active ? 'Activated' : 'Deactivated'} ${noun} ${label}` : `Edited ${noun} ${label}${changed.length ? `: ${changed.join(', ')}` : ' (no changes)'}`;
  await db.batch([db.prepare(`UPDATE ${table} SET ${values.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).bind(...values.map(([, v]) => v), recordId),
    audit(db, actor, changed.length === 1 && changed[0] === 'active' ? 'status' : 'edit', noun, recordId, summary, { before: Object.fromEntries(changed.map(k => [k, before[k]])) })]);
  return { saved: true };
}

// AI judges and votes -----------------------------------------------------------------------------
export const listJudges = (db: D1Database) => rows<AdminJudge>(db, `SELECT j.*,coalesce(s.display_name,j.system_id) system_name,(SELECT count(*) FROM ai_votes WHERE judge_id=j.id) votes,
  (SELECT max(judged_at) FROM ai_votes WHERE judge_id=j.id) latest_judged_at FROM ai_judges j LEFT JOIN systems s ON s.id=j.system_id ORDER BY j.display_name`);
const judgeSchema = z.object({ display_name: short, version: short, system_id: id }).strict();
export async function updateJudge(db: D1Database, judgeId: string, input: unknown, actor: Actor) {
  const parsed = judgeSchema.parse(input);
  const before = await one<{ display_name: string }>(db, 'SELECT display_name FROM ai_judges WHERE id=?', judgeId);
  if (!before) throw new HttpError(404, 'AI judge not found');
  if (!await one(db, 'SELECT id FROM systems WHERE id=?', parsed.system_id)) throw new HttpError(400, `Unknown system: ${parsed.system_id}`);
  await db.batch([db.prepare('UPDATE ai_judges SET display_name=?,version=?,system_id=? WHERE id=?').bind(parsed.display_name, parsed.version, parsed.system_id, judgeId),
    audit(db, actor, 'edit', 'judge', judgeId, `Edited AI judge ${before.display_name}`, parsed)]);
  return { saved: true };
}

const PAIR_JOIN = 'JOIN matchups m ON m.id=MATCH JOIN responses r ON r.id=m.response_low JOIN responses r2 ON r2.id=m.response_high JOIN systems s ON s.id=r.system_id JOIN systems s2 ON s2.id=r2.system_id JOIN topics t ON t.id=r.topic_id';
const voteFilters = { system: id.optional(), topic: id.optional(), task: taskFilter };
function pairWhere(f: { system?: string; topic?: string; task: string }, where: string[], values: (string | number)[]) {
  if (f.system) { where.push('(r.system_id=? OR r2.system_id=?)'); values.push(f.system, f.system); }
  if (f.topic) { where.push('r.topic_id=?'); values.push(f.topic); }
  taskWhere(f.task, 'r', where, values);
}
const AI_SELECT = `v.id,v.judge_id,j.display_name judge_name,v.overall,v.version,v.judged_at,v.explanation IS NOT NULL has_explanation,r.task,t.motion,m.response_low,m.response_high,
  s.display_name system_low,s2.display_name system_high,(SELECT coalesce(json_group_object(metric,value),'{}') FROM ai_metric_votes WHERE vote_id=v.id) metrics`;
const AI_FROM = `FROM ai_votes v JOIN ai_judges j ON j.id=v.judge_id ${PAIR_JOIN.replace('MATCH', 'v.matchup_id')}`;
export async function listAiVotes(db: D1Database, params: URLSearchParams) {
  const f = query({ ...voteFilters, judge: id.optional() }, params);
  const where: string[] = [], values: (string | number)[] = [];
  if (f.judge) { where.push('v.judge_id=?'); values.push(f.judge); }
  pairWhere(f, where, values);
  return page<AdminAiVote>(db, AI_SELECT, AI_FROM, where, values, 'v.judged_at DESC,v.id', f.offset, f.limit);
}
export async function aiVoteDetail(db: D1Database, voteId: string) {
  const vote = await one<AdminAiVoteDetail>(db, `SELECT ${AI_SELECT},v.explanation,v.snapshot_low,v.snapshot_high ${AI_FROM} WHERE v.id=?`, voteId);
  if (!vote) throw new HttpError(404, 'AI judgment not found'); return vote;
}
const HUMAN_SELECT = `v.id,aa.user_id,u.username,u.user_type,v.overall,v.revision,v.updated_at,coalesce(aa.task_snapshot,r.task) task,coalesce(aa.motion_snapshot,t.motion) motion,
  m.response_low,m.response_high,s.display_name system_low,s2.display_name system_high,(SELECT coalesce(json_group_object(metric,value),'{}') FROM human_metric_votes WHERE vote_id=v.id) metrics`;
const HUMAN_FROM = `FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id JOIN users u ON u.id=aa.user_id ${PAIR_JOIN.replace('MATCH', 'aa.matchup_id')}`;
export async function listHumanVotes(db: D1Database, params: URLSearchParams) {
  const f = query({ ...voteFilters, user: id.optional(), subgroup: z.enum(['all', 'Parliamentary Debater', 'Non-Parliamentary Debater']).default('all') }, params);
  const where: string[] = [], values: (string | number)[] = [];
  if (f.user) { where.push('aa.user_id=?'); values.push(f.user); }
  if (f.subgroup !== 'all') { where.push('u.user_type=?'); values.push(f.subgroup); }
  pairWhere(f, where, values);
  return page<AdminHumanVote>(db, HUMAN_SELECT, HUMAN_FROM, where, values, 'v.updated_at DESC,v.id', f.offset, f.limit);
}
export async function humanVoteDetail(db: D1Database, voteId: string) {
  const vote = await one<AdminHumanVoteDetail>(db, `SELECT ${HUMAN_SELECT},aa.snapshot_low,aa.snapshot_high,aa.context_snapshot,aa.swapped,aa.issued_at ${HUMAN_FROM} WHERE v.id=?`, voteId);
  if (!vote) throw new HttpError(404, 'Judgment not found'); return vote;
}

// Accounts ----------------------------------------------------------------------------------------
export async function listAccounts(db: D1Database, params: URLSearchParams) {
  const f = query({ q: z.string().trim().max(40).default(''), role: z.enum(['all', 'admin', 'user']).default('all') }, params);
  const where: string[] = [], values: (string | number)[] = [];
  if (f.q) { where.push('instr(lower(u.username),lower(?))>0'); values.push(f.q); }
  if (f.role !== 'all') { where.push('u.is_admin=?'); values.push(f.role === 'admin' ? 1 : 0); }
  return page<AdminAccount>(db, `u.id,u.username,u.user_type,u.created_at,u.is_admin,coalesce(us.reveal_names,0) reveal_names,
    (SELECT count(*) FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id WHERE aa.user_id=u.id) votes,(SELECT count(*) FROM arena_assignments aa WHERE aa.user_id=u.id) assignments,
    (SELECT max(v.updated_at) FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id WHERE aa.user_id=u.id) last_vote_at,
    (SELECT count(*) FROM sessions x WHERE x.user_id=u.id AND x.expires_at>${Date.now()}) sessions,
    (SELECT count(*) FROM prompt_revisions p WHERE p.created_by=u.id)+(SELECT count(*) FROM rebuttal_pool p WHERE p.frozen_by=u.id) authored`,
  'FROM users u LEFT JOIN user_settings us ON us.user_id=u.id', where, values, 'u.is_admin DESC,u.username COLLATE NOCASE', f.offset, f.limit);
}
const accountSchema = z.object({ is_admin: z.boolean().optional(), user_type: z.enum(['Parliamentary Debater', 'Non-Parliamentary Debater']).optional(), username: z.string().regex(/^[A-Za-z0-9_]{3,24}$/, 'Usernames use 3–24 letters, digits, or underscores').optional() }).strict();
export async function updateAccount(db: D1Database, accountId: string, input: unknown, actor: Actor) {
  const parsed = accountSchema.parse(input);
  const target = await one<{ id: string; username: string; is_admin: number; user_type: string }>(db, 'SELECT id,username,is_admin,user_type FROM users WHERE id=?', accountId);
  if (!target) throw new HttpError(404, 'Account not found');
  // The last administrator cannot be demoted, including by themselves, or nobody could grant the role back.
  if (target.is_admin && parsed.is_admin === false) {
    const remaining = await one<{ n: number }>(db, 'SELECT count(*) n FROM users WHERE is_admin=1 AND id<>?', target.id);
    if (!remaining?.n) throw new HttpError(400, target.id === actor.id ? 'You are the only administrator. Promote another account before removing your own access.' : 'ParliBench must keep at least one administrator.');
  }
  if (parsed.username && await one(db, 'SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?', parsed.username, target.id)) throw new HttpError(409, 'That username is already taken');
  const updates = Object.entries({ is_admin: parsed.is_admin === undefined ? undefined : parsed.is_admin ? 1 : 0, user_type: parsed.user_type, username: parsed.username }).filter(([, v]) => v !== undefined) as [string, string | number][];
  if (!updates.length) throw new HttpError(400, 'Nothing to change');
  const summary = updates.map(([k, v]) => k === 'is_admin' ? (v ? 'granted administrator access' : 'revoked administrator access') : k === 'username' ? `renamed to ${v}` : `set type to ${v}`).join('; ');
  await db.batch([db.prepare(`UPDATE users SET ${updates.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).bind(...updates.map(([, v]) => v), target.id),
    audit(db, actor, 'account', 'user', target.id, `${target.username}: ${summary}`)]);
  const next = await one<{ id: string; username: string; is_admin: number; user_type: string }>(db, 'SELECT id,username,is_admin,user_type FROM users WHERE id=?', target.id);
  return { saved: true, ...next! };
}
export async function resetPin(db: D1Database, accountId: string, input: unknown, actor: Actor, pepper: string, keepSession: string) {
  const { pin } = z.object({ pin: z.string().regex(/^(?:\d{4}|\d{6})$/, 'PIN must contain exactly 4 or 6 digits') }).strict().parse(input);
  if (!pepper || pepper.length < 32) throw new HttpError(503, 'Authentication secret is not configured');
  const target = await one<{ username: string }>(db, 'SELECT username FROM users WHERE id=?', accountId);
  if (!target) throw new HttpError(404, 'Account not found');
  const salt = crypto.randomUUID(), hash = await hashPin(pin, salt, pepper);
  await db.batch([db.prepare('UPDATE users SET pin_hash=?,pin_salt=? WHERE id=?').bind(hash, salt, accountId),
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(accountId, keepSession),
    db.prepare('DELETE FROM rate_limits WHERE key=?').bind(`account:${target.username.toLowerCase()}`),
    audit(db, actor, 'account', 'user', accountId, `${target.username}: PIN reset and other sessions signed out`)]);
  return { saved: true };
}
export async function revokeSessions(db: D1Database, accountId: string, actor: Actor, keepSession: string) {
  const target = await one<{ username: string }>(db, 'SELECT username FROM users WHERE id=?', accountId);
  if (!target) throw new HttpError(404, 'Account not found');
  const result = await db.batch([db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(accountId, keepSession),
    audit(db, actor, 'account', 'user', accountId, `${target.username}: signed out of every other session`)]);
  return { revoked: result[0].meta.changes };
}

// Runs and export ---------------------------------------------------------------------------------
export async function listRuns(db: D1Database, params: URLSearchParams) {
  const f = query({ status: z.enum(['all', 'open', 'filled', 'released']).default('all'), system: id.optional(), topic: id.optional(), task: z.enum(['all', ...TASKS]).default('all') }, params);
  const where: string[] = [], values: (string | number)[] = [];
  if (f.status !== 'all') { where.push('c.status=?'); values.push(f.status); }
  if (f.system) { where.push('c.system_id=?'); values.push(f.system); }
  if (f.topic) { where.push('c.topic_id=?'); values.push(f.topic); }
  if (f.task !== 'all') { where.push('c.task=?'); values.push(f.task); }
  return page<RunHistoryRow>(db, 'c.id,c.system_id,coalesce(s.display_name,c.system_id) system_name,c.topic_id,coalesce(t.motion,c.topic_id) motion,c.task,c.sample,c.status,c.response_id,c.claimed_at,c.resolved_at,p.version prompt_version',
    'FROM run_claims c LEFT JOIN systems s ON s.id=c.system_id LEFT JOIN topics t ON t.id=c.topic_id LEFT JOIN prompt_revisions p ON p.id=c.prompt_revision_id', where, values, 'c.claimed_at DESC', f.offset, f.limit);
}
const BACKUP_TABLES = ['systems', 'topics', 'responses', 'response_revisions', 'response_display_revisions', 'structured_cases', 'structured_case_revisions', 'prompt_revisions',
  'rebuttal_pool', 'rebuttal_pool_removals', 'run_claims', 'matchups', 'arena_assignments', 'human_votes', 'human_metric_votes', 'human_vote_revisions', 'ai_judges', 'ai_votes',
  'ai_metric_votes', 'benchmark_weights', 'source_weights', 'standardized_rebuttal_tasks', 'opposition_predictions', 'opposition_rebuttals', 'opposition_preps', 'user_settings', 'admin_audit'] as const;
/** corpus: re-importable systems, topics, case responses, judges and their votes. backup: every benchmark table, without credentials. */
export async function exportData(db: D1Database, scope: string, actor: Actor) {
  const exported_at = new Date().toISOString();
  let data: Record<string, unknown>;
  if (scope === 'backup') {
    const [tables, users] = await Promise.all([Promise.all(BACKUP_TABLES.map(t => rows(db, `SELECT * FROM ${t}`))), rows(db, 'SELECT id,username,user_type,created_at,is_admin FROM users')]);
    data = { format: 'parlibench-backup-v1', exported_at, tables: { ...Object.fromEntries(BACKUP_TABLES.map((t, i) => [t, tables[i]])), users } };
  } else {
    const [systems, topics, responses, ai_judges, votes] = await Promise.all([
      rows(db, 'SELECT id,display_name,provider,model,interface,reasoning,configuration,active FROM systems ORDER BY id'),
      rows(db, 'SELECT id,motion,category,active,metadata_json FROM topics ORDER BY id'),
      rows(db, "SELECT id,system_id,topic_id,task,raw_output,display_output,prompt,generated_at,interface,reasoning,configuration,duration_ms,sample,context_id FROM responses WHERE task IN ('government','opposition') ORDER BY rowid"),
      rows(db, 'SELECT id,system_id,display_name,version FROM ai_judges ORDER BY id'),
      rows<{ metrics: string }>(db, `SELECT v.id,v.judge_id,m.response_low response_a,m.response_high response_b,v.overall,v.explanation,v.version,v.judged_at,v.snapshot_low snapshot_a,v.snapshot_high snapshot_b,
        (SELECT coalesce(json_group_object(metric,value),'{}') FROM ai_metric_votes WHERE vote_id=v.id) metrics FROM ai_votes v JOIN matchups m ON m.id=v.matchup_id
        JOIN responses r ON r.id=m.response_low WHERE r.task IN ('government','opposition') ORDER BY v.judged_at,v.id`),
    ]);
    data = { systems, topics, responses, ai_judges, ai_votes: votes.map(v => ({ ...v, metrics: JSON.parse(v.metrics) })) };
  }
  await db.batch([audit(db, actor, 'export', 'benchmark', null, `Exported ${scope === 'backup' ? 'a full backup' : 'the case corpus'}`)]);
  return data;
}
