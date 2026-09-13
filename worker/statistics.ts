import { rows, one } from './db';
import { filterSchema } from './validation';
import { balanceSources, bradleyTerry, preferenceOutcome, wilsonInterval, type Comparison } from './ranking';
import { activeResponseSQL, METRICS, type Metric, type SystemInfo, type Leaderboard } from '../shared/domain';
import type { z } from 'zod';
export type Filters = z.infer<typeof filterSchema>;
interface VoteRow { id: string; a: string; b: string; overall: number; metrics: string; task: string; category: string; source: 'human' | 'ai'; }
export async function comparisonsFor(db: D1Database, f: Filters, userId?: string, pair?: [string,string]) {
  const conditions = [activeResponseSQL('r'), activeResponseSQL('r2'), "(r.task<>'rebuttal' OR r.government_source_response_id=r2.government_source_response_id)"]; const params: string[] = [];
  if (f.category !== 'all') { conditions.push('t.category=?'); params.push(f.category); }
  if (f.task !== 'all') { conditions.push('r.task=?'); params.push(f.task); }
  if (pair) { conditions.push('((r.system_id=? AND r2.system_id=?) OR (r.system_id=? AND r2.system_id=?))'); params.push(pair[0],pair[1],pair[1],pair[0]); }
  const common = `JOIN matchups m ON m.id=ASSIGN_MATCH JOIN responses r ON r.id=m.response_low JOIN responses r2 ON r2.id=m.response_high JOIN topics t ON t.id=r.topic_id`;
  const sources: string[] = []; const values: string[] = [];
  if (userId || f.source !== 'ai') {
    const hc = [...conditions], hp = [...params];
    if (userId) { hc.push('u.id=?'); hp.push(userId); }
    else if (f.subgroup !== 'all') { hc.push('u.user_type=?'); hp.push(f.subgroup); }
    sources.push(`SELECT 'h:'||v.id id,r.system_id a,r2.system_id b,v.overall,r.task,t.category,'human' source,
      (SELECT coalesce(json_group_object(metric,value),'{}') FROM human_metric_votes WHERE vote_id=v.id) metrics
      FROM human_votes v JOIN arena_assignments aa ON aa.id=v.id JOIN users u ON u.id=aa.user_id ${common.replace('ASSIGN_MATCH', 'aa.matchup_id')} WHERE ${hc.join(' AND ')}`);
    values.push(...hp);
  }
  if (!userId && f.source !== 'human') {
    const ac = [...conditions], ap = [...params];
    if (f.judge) { ac.push('v.judge_id=?'); ap.push(f.judge); }
    // Latest imported version per judge/pair; historical versions remain reconstructable.
    ac.push('NOT EXISTS (SELECT 1 FROM ai_votes newer WHERE newer.judge_id=v.judge_id AND newer.matchup_id=v.matchup_id AND (newer.judged_at>v.judged_at OR (newer.judged_at=v.judged_at AND newer.id>v.id)))');
    sources.push(`SELECT 'a:'||v.id id,r.system_id a,r2.system_id b,v.overall,r.task,t.category,'ai' source,
      (SELECT coalesce(json_group_object(metric,value),'{}') FROM ai_metric_votes WHERE vote_id=v.id) metrics
      FROM ai_votes v ${common.replace('ASSIGN_MATCH', 'v.matchup_id')} WHERE ${ac.join(' AND ')}`);
    values.push(...ap);
  }
  const [votes, weightRows, weights] = await Promise.all([
    rows<VoteRow>(db, sources.join(' UNION ALL '), ...values),
    rows<{ task: string; metric: Metric; weight: number }>(db, 'SELECT * FROM benchmark_weights'),
    one<{ human: number; ai: number }>(db, 'SELECT human,ai FROM source_weights WHERE id=1'),
  ]);
  let comparisons: Comparison[] = [];
  const weightMap = new Map(weightRows.map(w => [`${w.task}:${w.metric}`, w.weight]));
  for (const vote of votes) {
    const base = { a: vote.a, b: vote.b, ballot: vote.id, source: vote.source };
    const metrics: Record<string, number> = JSON.parse(vote.metrics);
    if (f.metric === 'overall') comparisons.push({ ...base, outcome: preferenceOutcome(vote.overall), weight: 1 });
    else if (f.metric === 'weighted') {
      const available = Object.entries(metrics).filter(([m]) => (weightMap.get(`${vote.task}:${m}`) || 0) > 0);
      const sum = available.reduce((s, [m]) => s + weightMap.get(`${vote.task}:${m}`)!, 0);
      for (const [m, v] of available) comparisons.push({ ...base, outcome: preferenceOutcome(v), weight: weightMap.get(`${vote.task}:${m}`)! / sum });
    } else if (metrics[f.metric] != null) comparisons.push({ ...base, outcome: preferenceOutcome(metrics[f.metric]), weight: 1 });
  }
  const sourceWeights = weights || { human: 0.5, ai: 0.5 };
  const present = new Set(comparisons.map(c => c.source));
  if (!userId && f.source === 'combined') comparisons = balanceSources(comparisons, sourceWeights.human, sourceWeights.ai);
  return { comparisons, sourceWeights, missing_source: f.source === 'combined' && present.size === 1 ? (present.has('human') ? 'ai' : 'human') : undefined };
}
export async function leaderboard(db: D1Database, f: Filters, userId?: string): Promise<Leaderboard> {
  const [{ comparisons, sourceWeights, missing_source }, systems] = await Promise.all([
    comparisonsFor(db, f, userId), rows<SystemInfo>(db, 'SELECT * FROM systems'),
  ]);
  const participating = new Set(comparisons.flatMap(c => [c.a, c.b]));
  const candidates = systems.filter(s => s.active || participating.has(s.id));
  const metadata = new Map(candidates.map(s => [s.id, s]));
  return { rows: bradleyTerry.fit(candidates.map(s => s.id), comparisons).map(r => ({ ...r, display_name: metadata.get(r.id)!.display_name, provider: metadata.get(r.id)!.provider })),
    comparisons: new Set(comparisons.map(c => c.ballot)).size, method: 'Bradley–Terry · regularized · 95% approximate intervals', source_weights: sourceWeights, missing_source };
}
export async function headToHead(db: D1Database, a: string, b: string) {
  const sections = [
    { label: 'Overall Preference', metric: 'overall' },
    ...METRICS.map(metric => ({ label: metric, metric })),
    ...(['government','opposition','rebuttal'] as const).map(task => ({ label: task, task })),
    ...(['Serious','Informal'] as const).map(category => ({ label: category, category })),
    ...(['human','ai'] as const).map(source => ({ label: source, source })),
  ];
  return Promise.all(sections.map(async s => {
    const { comparisons } = await comparisonsFor(db, filterSchema.parse({ source: 'combined', metric: 'overall', ...s }), undefined, [a,b]);
    const direct = comparisons.filter(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
    const count = new Set(direct.map(c => c.ballot)).size;
    const mass = direct.reduce((sum, c) => sum + c.weight, 0);
    const wins = direct.reduce((sum, c) => sum + c.weight * (c.a === a ? c.outcome : 1 - c.outcome), 0);
    return { label: s.label, comparisons: count, win_rate: mass ? wins / mass : 0.5, ci: wilsonInterval(wins, mass), sufficient: count >= 5 && mass >= 3 };
  }));
}
