import { HttpError, one, rows } from './db';
import { leaderboard } from './statistics';
import { filterSchema } from './validation';
import { listPrompts } from './prompts';
import { activeResponseSQL, type SystemInfo, type RankingRow } from '../shared/domain';
import type { AdminOverview, AuditEntry, ScoreSummary, SystemDetail, SystemStats, TopicStats } from '../shared/admin';

const ACTIVE = activeResponseSQL('r');
export function summarize(list: RankingRow[], id: string): ScoreSummary | null {
  const index = list.findIndex(r => r.id === id), row = list[index];
  if (!row) return null;
  return { rank: row.comparisons ? list.filter(r => r.comparisons).findIndex(r => r.id === id) + 1 : null, score: row.score, rating: row.rating, win_rate: row.win_rate, comparisons: row.comparisons, ci: row.ci, low_confidence: row.low_confidence };
}
const byKey = <T extends Record<string, unknown>>(list: T[], key: keyof T) => new Map(list.map(r => [String(r[key]), r]));

export async function adminOverview(db: D1Database, env: { GEMINI_API_KEY?: string; ENVIRONMENT?: string }): Promise<AdminOverview> {
  await listPrompts(db);
  const [totals, responsesByTask, systems, topics, cells, claims, recentResponses, recentVotes, audit, rebuttal] = await Promise.all([
    one<AdminOverview['totals']>(db, `SELECT (SELECT count(*) FROM systems) systems,(SELECT count(*) FROM systems WHERE active=1) active_systems,
      (SELECT count(*) FROM topics) topics,(SELECT count(*) FROM topics WHERE active=1) active_topics,
      (SELECT count(*) FROM responses) responses,(SELECT count(*) FROM responses WHERE active=1) active_responses,(SELECT count(*) FROM matchups) matchups,
      (SELECT count(*) FROM human_votes) human_votes,(SELECT count(*) FROM human_votes WHERE updated_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) human_votes_7d,
      (SELECT count(*) FROM ai_votes) ai_votes,(SELECT count(*) FROM ai_judges) ai_judges,
      (SELECT count(*) FROM users) users,(SELECT count(*) FROM users WHERE created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) users_7d,(SELECT count(*) FROM users WHERE is_admin=1) admins,
      (SELECT count(*) FROM arena_assignments aa WHERE NOT EXISTS (SELECT 1 FROM human_votes v WHERE v.id=aa.id)) unvoted_assignments,
      (SELECT count(*) FROM arena_assignments aa WHERE NOT EXISTS (SELECT 1 FROM human_votes v WHERE v.id=aa.id) AND issued_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')) stale_assignments,
      (SELECT count(*) FROM run_claims WHERE status='open') open_claims,(SELECT count(*) FROM rebuttal_pool) pool_sources,
      (SELECT count(*) FROM structured_cases WHERE status='failed') extraction_failed,
      (SELECT count(*) FROM responses r WHERE r.task IN ('government','opposition') AND NOT EXISTS (SELECT 1 FROM structured_cases c WHERE c.response_id=r.id)) extraction_missing`),
    // Retired pipeline rebuttals share the 'rebuttal' identifier, so they are reported separately.
    rows<AdminOverview['responses_by_task'][number]>(db, `SELECT CASE WHEN ${ACTIVE} OR r.task<>'rebuttal' THEN r.task ELSE 'pipeline_rebuttal' END task,count(*) responses,sum(active) active FROM responses r GROUP BY 1 ORDER BY responses DESC`),
    rows<AdminOverview['coverage']['systems'][number]>(db, 'SELECT id,display_name,active FROM systems ORDER BY active DESC,display_name'),
    rows<AdminOverview['coverage']['topics'][number]>(db, 'SELECT id,motion,category,active FROM topics ORDER BY active DESC,category,motion'),
    rows<{ system_id: string; topic_id: string; task: string; responses: number; active: number }>(db, `SELECT system_id,topic_id,task,count(*) responses,sum(active) active FROM responses r WHERE ${ACTIVE} GROUP BY system_id,topic_id,task`),
    rows<{ system_id: string; topic_id: string; task: string; open_claims: number }>(db, "SELECT system_id,topic_id,task,count(*) open_claims FROM run_claims WHERE status='open' GROUP BY system_id,topic_id,task"),
    rows<AdminOverview['recent_responses'][number]>(db, 'SELECT r.id,s.display_name system_name,t.motion,r.task,r.sample,r.generated_at FROM responses r JOIN systems s ON s.id=r.system_id JOIN topics t ON t.id=r.topic_id ORDER BY r.rowid DESC LIMIT 8'),
    rows<AdminOverview['recent_votes'][number]>(db, `SELECT v.id,u.username,coalesce(aa.motion_snapshot,t.motion) motion,coalesce(aa.task_snapshot,r.task) task,v.overall,v.updated_at FROM human_votes v
      JOIN arena_assignments aa ON aa.id=v.id JOIN users u ON u.id=aa.user_id JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low JOIN topics t ON t.id=r.topic_id ORDER BY v.updated_at DESC LIMIT 8`),
    rows<AuditEntry>(db, 'SELECT * FROM admin_audit ORDER BY id DESC LIMIT 8'),
    one<{ n: number }>(db, "SELECT count(*) n FROM prompt_revisions WHERE task='rebuttal'"),
  ]);
  const merged = new Map<string, AdminOverview['coverage']['cells'][number]>();
  for (const c of cells) merged.set(`${c.system_id}|${c.topic_id}|${c.task}`, { ...c, open_claims: 0 });
  for (const c of claims) {
    const key = `${c.system_id}|${c.topic_id}|${c.task}`, cell = merged.get(key);
    if (cell) cell.open_claims = c.open_claims; else merged.set(key, { ...c, responses: 0, active: 0 });
  }
  return { totals: totals!, responses_by_task: responsesByTask, coverage: { systems, topics, cells: [...merged.values()] }, recent_responses: recentResponses, recent_votes: recentVotes, audit,
    configuration: { gemini: !!env.GEMINI_API_KEY, rebuttal_prompt: !!rebuttal?.n, environment: env.ENVIRONMENT || 'unknown' } };
}

export async function systemStats(db: D1Database): Promise<SystemStats[]> {
  const [systems, responses, extraction, claims, matchups, human, ai, judges, pool, boards] = await Promise.all([
    rows<SystemInfo>(db, 'SELECT * FROM systems ORDER BY active DESC,display_name'),
    rows<{ system_id: string }>(db, `SELECT system_id,count(*) responses,sum(active) active_responses,sum(task='government') government,sum(task='opposition') opposition,
      sum(CASE WHEN r.task='rebuttal' AND ${ACTIVE} THEN 1 ELSE 0 END) rebuttal,sum(CASE WHEN ${ACTIVE} THEN 0 ELSE 1 END) legacy,
      count(DISTINCT CASE WHEN task IN ('government','opposition') THEN topic_id END) topics_covered,avg(duration_ms) avg_duration_ms,max(generated_at) last_generated_at
      FROM responses r GROUP BY system_id`),
    rows<{ system_id: string }>(db, "SELECT r.system_id,sum(c.status='ready') extraction_ready,sum(c.status='failed') extraction_failed FROM structured_cases c JOIN responses r ON r.id=c.response_id GROUP BY r.system_id"),
    rows<{ system_id: string }>(db, "SELECT system_id,count(*) open_claims FROM run_claims WHERE status='open' GROUP BY system_id"),
    rows<{ system_id: string }>(db, 'SELECT r.system_id,count(*) matchups FROM matchups m JOIN responses r ON r.id=m.response_low OR r.id=m.response_high GROUP BY r.system_id'),
    rows<{ system_id: string }>(db, 'SELECT r.system_id,count(*) human_votes FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low OR r.id=m.response_high GROUP BY r.system_id'),
    rows<{ system_id: string }>(db, 'SELECT r.system_id,count(*) ai_votes FROM ai_votes v JOIN matchups m ON m.id=v.matchup_id JOIN responses r ON r.id=m.response_low OR r.id=m.response_high GROUP BY r.system_id'),
    rows<{ system_id: string }>(db, 'SELECT system_id,count(*) judges FROM ai_judges GROUP BY system_id'),
    rows<{ system_id: string }>(db, 'SELECT r.system_id,count(*) pool_sources FROM rebuttal_pool p JOIN responses r ON r.id=p.government_response_id GROUP BY r.system_id'),
    Promise.all((['human', 'ai', 'combined'] as const).map(source => leaderboard(db, filterSchema.parse({ source })))),
  ]);
  const maps = [responses, extraction, claims, matchups, human, ai, judges, pool].map(list => byKey(list, 'system_id'));
  const zero = { responses: 0, active_responses: 0, government: 0, opposition: 0, rebuttal: 0, legacy: 0, topics_covered: 0, extraction_ready: 0, extraction_failed: 0, open_claims: 0, avg_duration_ms: null, last_generated_at: null, matchups: 0, human_votes: 0, ai_votes: 0, judges: 0, pool_sources: 0 };
  return systems.map(system => {
    const merged: Record<string, unknown> = { ...zero };
    for (const map of maps) for (const [key, value] of Object.entries(map.get(system.id) || {})) if (key !== 'system_id' && value != null) merged[key] = value;
    return { ...system, ...merged, human: summarize(boards[0].rows, system.id), ai: summarize(boards[1].rows, system.id), combined: summarize(boards[2].rows, system.id) } as SystemStats;
  });
}

const RANKING_VIEWS = [
  { label: 'Overall · combined', source: 'combined', task: 'all', metric: 'overall' },
  { label: 'Overall · human judges', source: 'human', task: 'all', metric: 'overall' },
  { label: 'Overall · AI judges', source: 'ai', task: 'all', metric: 'overall' },
  { label: 'Weighted Benchmark · combined', source: 'combined', task: 'all', metric: 'weighted' },
  { label: 'Government Case · combined', source: 'combined', task: 'government', metric: 'overall' },
  { label: 'Opposition Case · combined', source: 'combined', task: 'opposition', metric: 'overall' },
  { label: 'Rebuttal · combined', source: 'combined', task: 'rebuttal', metric: 'overall' },
] as const;
export async function systemDetail(db: D1Database, id: string): Promise<SystemDetail> {
  const system = (await systemStats(db)).find(s => s.id === id);
  if (!system) throw new HttpError(404, 'System not found');
  const [topics, rankings, recent] = await Promise.all([
    rows<SystemDetail['topics'][number]>(db, `SELECT t.id topic_id,t.motion,t.category,t.active,count(CASE WHEN r.task='government' THEN 1 END) government,
      count(CASE WHEN r.task='opposition' THEN 1 END) opposition,count(CASE WHEN r.task='rebuttal' AND ${ACTIVE} THEN 1 END) rebuttal,
      (SELECT count(*) FROM run_claims c WHERE c.topic_id=t.id AND c.system_id=?1 AND c.status='open') open_claims
      FROM topics t LEFT JOIN responses r ON r.topic_id=t.id AND r.system_id=?1 GROUP BY t.id ORDER BY t.active DESC,t.category,t.motion`, id),
    Promise.all(RANKING_VIEWS.map(async ({ label, ...view }) => ({ label, summary: summarize((await leaderboard(db, filterSchema.parse(view))).rows, id) }))),
    rows<SystemDetail['recent'][number]>(db, 'SELECT r.id,r.topic_id,t.motion,r.task,r.sample,r.active,r.generated_at FROM responses r JOIN topics t ON t.id=r.topic_id WHERE r.system_id=? ORDER BY r.rowid DESC LIMIT 12', id),
  ]);
  return { system, topics, rankings, recent };
}

export async function topicStats(db: D1Database): Promise<TopicStats[]> {
  const [topics, claims, pool, matchups, human, ai] = await Promise.all([
    rows<TopicStats>(db, `SELECT t.*,count(r.id) responses,coalesce(sum(r.active),0) active_responses,count(CASE WHEN r.task='government' THEN 1 END) government,
      count(CASE WHEN r.task='opposition' THEN 1 END) opposition,count(CASE WHEN r.task='rebuttal' AND ${ACTIVE} THEN 1 END) rebuttal,
      count(CASE WHEN r.id IS NOT NULL AND NOT ${ACTIVE} THEN 1 END) legacy,count(DISTINCT r.system_id) systems_covered
      FROM topics t LEFT JOIN responses r ON r.topic_id=t.id GROUP BY t.id ORDER BY t.active DESC,t.category,t.motion`),
    rows<{ topic_id: string }>(db, "SELECT topic_id,count(*) open_claims FROM run_claims WHERE status='open' GROUP BY topic_id"),
    rows<{ topic_id: string }>(db, 'SELECT topic_id,count(*) pool_sources FROM rebuttal_pool GROUP BY topic_id'),
    rows<{ topic_id: string }>(db, 'SELECT r.topic_id,count(*) matchups FROM matchups m JOIN responses r ON r.id=m.response_low GROUP BY r.topic_id'),
    rows<{ topic_id: string }>(db, 'SELECT r.topic_id,count(*) human_votes FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id JOIN matchups m ON m.id=aa.matchup_id JOIN responses r ON r.id=m.response_low GROUP BY r.topic_id'),
    rows<{ topic_id: string }>(db, 'SELECT r.topic_id,count(*) ai_votes FROM ai_votes v JOIN matchups m ON m.id=v.matchup_id JOIN responses r ON r.id=m.response_low GROUP BY r.topic_id'),
  ]);
  const maps = [claims, pool, matchups, human, ai].map(list => byKey(list, 'topic_id'));
  return topics.map(topic => {
    const merged: Record<string, unknown> = { open_claims: 0, pool_sources: 0, matchups: 0, human_votes: 0, ai_votes: 0 };
    for (const map of maps) for (const [key, value] of Object.entries(map.get(topic.id) || {})) if (key !== 'topic_id') merged[key] = value;
    return { ...topic, ...merged } as TopicStats;
  });
}
