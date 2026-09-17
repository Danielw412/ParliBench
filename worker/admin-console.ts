import { z } from 'zod';
import { HttpError, one, rows } from './db';
import { applicableMetrics, TASKS, type User } from '../shared/domain';
import { id, systemSchema, topicSchema } from './validation';
import { audit, listAudit } from './audit';
import type { AdminOptions } from '../shared/admin';
import type { ExtractorEnv } from './cases';
import { adminOverview, systemDetail, systemStats, topicStats } from './admin-stats';
import { clearAssignments, deleteAiVote, deleteClaim, deleteEntity, deleteHumanVote, impact, unfreezeSource } from './admin-delete';
import { aiVoteDetail, bulkResponses, correctResponse, exportData, humanVoteDetail, listAccounts, listAiVotes, listHumanVotes, listJudges, listResponses, listRuns,
  patchResponse, resetPin, responseDetail, revokeSessions, updateAccount, updateCatalogRecord, updateJudge } from './admin-records';

export interface ConsoleContext {
  db: D1Database; path: string; method: string; url: URL; body: () => Promise<unknown>; me: User;
  env: ExtractorEnv & { PIN_PEPPER: string; ENVIRONMENT?: string }; tokenHash: string; waitUntil: (promise: Promise<unknown>) => void;
}
const reason = (url: URL) => z.string().trim().max(1000).parse(url.searchParams.get('reason') || '');
const ID = '([a-zA-Z0-9_-]+)';

/** Administrator console routes. The caller has already verified the administrator role. Returns undefined when unmatched. */
export async function adminConsole(c: ConsoleContext): Promise<unknown | undefined> {
  const { db, path, method, url, me } = c;
  const route = (pattern: string, verb: string) => method === verb ? path.match(new RegExp(`^/api/admin/${pattern}$`)) : null;
  let m: RegExpMatchArray | null;

  if (route('overview', 'GET')) return adminOverview(db, c.env);
  if (route('audit', 'GET')) return listAudit(db, url.searchParams);
  if (route('options', 'GET')) {
    const [systems, topics, judges] = await Promise.all([rows<AdminOptions['systems'][number]>(db, 'SELECT id,display_name,active FROM systems ORDER BY active DESC,display_name'),
      rows<AdminOptions['topics'][number]>(db, 'SELECT id,motion,category,active FROM topics ORDER BY active DESC,category,motion'), rows<AdminOptions['judges'][number]>(db, 'SELECT id,display_name FROM ai_judges ORDER BY display_name')]);
    return { systems, topics, judges } satisfies AdminOptions;
  }
  if (route('export', 'GET')) return exportData(db, url.searchParams.get('scope') === 'backup' ? 'backup' : 'corpus', me);
  if ((m = route(`impact/(response|system|topic|judge|user)/${ID}`, 'GET'))) return impact(db, m[1] as 'response', m[2], me);

  if (route('catalog', 'GET')) {
    const [systems, topics, responses, standards, judges, weights, source, users] = await Promise.all([
      rows(db, 'SELECT * FROM systems'), rows(db, 'SELECT * FROM topics'),
      rows(db, 'SELECT r.id,r.system_id,r.topic_id,r.task,r.sample,r.display_version,c.status extraction_status FROM responses r LEFT JOIN structured_cases c ON c.response_id=r.id ORDER BY r.id'),
      rows(db, 'SELECT * FROM standardized_rebuttal_tasks'), rows(db, 'SELECT * FROM ai_judges'),
      rows(db, "SELECT * FROM benchmark_weights WHERE task IN ('government','opposition','rebuttal') AND metric<>'threat'"), one(db, 'SELECT human,ai FROM source_weights WHERE id=1'),
      rows(db, 'SELECT id,username,user_type,created_at,is_admin FROM users ORDER BY is_admin DESC,username COLLATE NOCASE'),
    ]);
    return { systems, topics, responses, standards, judges, weights, source, users };
  }

  // Responses
  if (route('responses', 'GET')) return listResponses(db, url.searchParams);
  if (route('responses/bulk', 'POST')) return bulkResponses(db, await c.body(), me, c.env, c.waitUntil);
  if ((m = route(`responses/${ID}/detail`, 'GET'))) return responseDetail(db, m[1]);
  if ((m = route(`responses/${ID}`, 'GET'))) {
    const response = await one(db, 'SELECT * FROM responses WHERE id=?', m[1]);
    if (!response) throw new HttpError(404, 'Response not found'); return response;
  }
  if ((m = route(`responses/${ID}`, 'PATCH'))) return patchResponse(db, m[1], await c.body(), me);
  if ((m = route(`responses/${ID}`, 'PUT'))) return correctResponse(db, m[1], await c.body(), me, c.env, c.waitUntil);
  if ((m = route(`responses/${ID}`, 'DELETE'))) return deleteEntity(db, 'response', m[1], me, reason(url));

  // Systems and topics
  if (route('system-stats', 'GET')) return systemStats(db);
  if ((m = route(`system-stats/${ID}`, 'GET'))) return systemDetail(db, m[1]);
  if (route('topic-stats', 'GET')) return topicStats(db);
  if ((m = route(`(systems|topics)/${ID}`, 'PUT'))) {
    const table = m[1] as 'systems' | 'topics';
    return updateCatalogRecord(db, table, m[2], (table === 'systems' ? systemSchema : topicSchema).parse(await c.body()), me);
  }
  if ((m = route(`(systems|topics)/${ID}`, 'DELETE'))) return deleteEntity(db, m[1] === 'systems' ? 'system' : 'topic', m[2], me, reason(url));

  // AI judges and judgments
  if (route('judges', 'GET')) return listJudges(db);
  if ((m = route(`judges/${ID}`, 'PUT'))) return updateJudge(db, m[1], await c.body(), me);
  if ((m = route(`judges/${ID}`, 'DELETE'))) return deleteEntity(db, 'judge', m[1], me, reason(url));
  if (route('ai-votes', 'GET')) return listAiVotes(db, url.searchParams);
  if ((m = route(`ai-votes/${ID}`, 'GET'))) return aiVoteDetail(db, m[1]);
  if ((m = route(`ai-votes/${ID}`, 'DELETE'))) return deleteAiVote(db, m[1], me);
  if (route('human-votes', 'GET')) return listHumanVotes(db, url.searchParams);
  if ((m = route(`human-votes/${ID}`, 'GET'))) return humanVoteDetail(db, m[1]);
  if ((m = route(`human-votes/${ID}`, 'DELETE'))) return deleteHumanVote(db, m[1], me);
  if (route('assignments/cleanup', 'POST')) {
    const input = z.object({ older_than_hours: z.number().int().min(1).max(8760).default(24), user_id: id.nullable().default(null) }).strict().parse(await c.body());
    return clearAssignments(db, input.older_than_hours, input.user_id, me);
  }

  // Accounts
  if (route('accounts', 'GET')) return listAccounts(db, url.searchParams);
  if ((m = route(`users/${ID}`, 'PATCH'))) return updateAccount(db, m[1], await c.body(), me);
  if ((m = route(`users/${ID}`, 'DELETE'))) return deleteEntity(db, 'user', m[1], me, reason(url));
  if ((m = route(`users/${ID}/pin`, 'POST'))) return resetPin(db, m[1], await c.body(), me, c.env.PIN_PEPPER, c.tokenHash);
  if ((m = route(`users/${ID}/sessions`, 'DELETE'))) return revokeSessions(db, m[1], me, c.tokenHash);

  // Run records and pool
  if (route('runs', 'GET')) return listRuns(db, url.searchParams);
  if ((m = route(`runs/${ID}`, 'DELETE'))) return deleteClaim(db, m[1], me);
  if ((m = route(`rebuttal-pool/${ID}`, 'DELETE'))) return unfreezeSource(db, m[1], me, reason(url));

  if (route('weights', 'PUT')) {
    const schema = z.object({ source: z.object({ human: z.number().min(0).max(1), ai: z.number().min(0).max(1) }),
      benchmark: z.array(z.object({ task: z.enum(TASKS), metric: id, weight: z.number().min(0).max(1) })) });
    const input = schema.parse(await c.body());
    if (Math.abs(input.source.human + input.source.ai - 1) > 1e-6) throw new HttpError(400, 'Source weights must sum to 1');
    for (const task of TASKS) {
      const entries = input.benchmark.filter(w => w.task === task);
      if (Math.abs(entries.reduce((s, w) => s + w.weight, 0) - 1) > 1e-6 || entries.length !== applicableMetrics(task).length || new Set(entries.map(e => e.metric)).size !== entries.length || entries.some(w => !applicableMetrics(task).includes(w.metric as never))) throw new HttpError(400, `Supply each applicable metric once for ${task}; weights must sum to 1`);
    }
    await db.batch([
      db.prepare('UPDATE source_weights SET human=?,ai=? WHERE id=1').bind(input.source.human, input.source.ai), db.prepare("DELETE FROM benchmark_weights WHERE task IN ('government','opposition','rebuttal')"),
      ...input.benchmark.map(w => db.prepare('INSERT INTO benchmark_weights(task,metric,weight) VALUES(?,?,?)').bind(w.task, w.metric, w.weight)),
      audit(db, me, 'edit', 'weights', null, `Set ranking weights: ${Math.round(input.source.human * 100)}% human / ${Math.round(input.source.ai * 100)}% AI`, input),
    ]);
    return { saved: true };
  }
  return undefined;
}
