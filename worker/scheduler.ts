import { HttpError, one, rows } from './db';
import { bulkImport } from './importer';
import { runResultSchema, runSlotSchema } from './validation';
import { activeResponseSQL, taskSide, type PromptRevision, type RunBoard, type RunClaim, type RunPlan, type RunSlot, type SystemInfo } from '../shared/domain';
import { coreCaseForRebuttal, structuredCaseSchema } from '../shared/cases';
import { listPrompts, renderPrompt } from './prompts';

interface TopicRow { id: string; motion: string; category: string }
interface SlotRow { system_id: string; topic_id: string; task: string; std: string; active_runs: number; top_sample: number }
interface CaseRow { id: string; system_id: string; topic_id: string; case_json: string }
interface PoolRow { government_response_id: string; topic_id: string; core_case_json: string }
interface ClaimRow extends RunSlot { id: string; sample: number; claimed_at: string; rendered_prompt: string; prompt_revision_id: string; plan_snapshot: string }
export interface Candidate extends RunSlot { sample: number }
export interface Coverage { systems: SystemInfo[]; topics: TopicRow[]; slots: SlotRow[]; oppositions: CaseRow[]; pool: PoolRow[]; prompts: PromptRevision[]; claims: ClaimRow[]; }
const slotKey = (system: string, topic: string, task: string, source: string | null) => [system, topic, task, source || ''].join('|');
const sameSlot = (a: RunSlot, b: RunSlot) => slotKey(a.system_id,a.topic_id,a.task,a.government_source_response_id) === slotKey(b.system_id,b.topic_id,b.task,b.government_source_response_id) && a.opposition_source_response_id === b.opposition_source_response_id;
export async function loadCoverage(db: D1Database): Promise<Coverage> {
  const [systems,topics,slots,oppositions,pool,prompts,claims] = await Promise.all([
    rows<SystemInfo>(db,'SELECT * FROM systems WHERE active=1 ORDER BY display_name'),
    rows<TopicRow>(db,'SELECT id,motion,category FROM topics WHERE active=1 ORDER BY id'),
    rows<SlotRow>(db,`SELECT system_id,topic_id,task,coalesce(government_source_response_id,'') std,sum(CASE WHEN ${activeResponseSQL('r')} THEN active ELSE 0 END) active_runs,max(sample) top_sample FROM responses r WHERE r.task IN ('government','opposition','rebuttal') GROUP BY system_id,topic_id,task,std`),
    rows<CaseRow>(db,`SELECT r.id,r.system_id,r.topic_id,c.case_json FROM responses r JOIN structured_cases c ON c.response_id=r.id WHERE r.active=1 AND r.task='opposition' AND c.status='ready' ORDER BY r.sample,r.id`),
    rows<PoolRow>(db,`SELECT p.* FROM rebuttal_pool p JOIN responses r ON r.id=p.government_response_id JOIN structured_cases c ON c.response_id=r.id WHERE r.active=1 AND c.status='ready'`),
    listPrompts(db), rows<ClaimRow>(db,`SELECT * FROM run_claims WHERE status='open' AND plan_snapshot IS NOT NULL ORDER BY claimed_at`),
  ]);
  for (const claim of claims) {
    const existing = slots.find(s=>slotKey(s.system_id,s.topic_id,s.task,s.std)===slotKey(claim.system_id,claim.topic_id,claim.task,claim.government_source_response_id));
    if (existing) { existing.active_runs++; existing.top_sample=Math.max(existing.top_sample,claim.sample); }
    else slots.push({system_id:claim.system_id,topic_id:claim.topic_id,task:claim.task,std:claim.government_source_response_id || '',active_runs:1,top_sample:claim.sample});
  }
  return {systems,topics,slots,oppositions,pool,prompts,claims};
}
export function buildCandidates(coverage: Coverage, systemId?: string): Candidate[] {
  const candidates: Candidate[] = [];
  const add = (slot: RunSlot) => {
    // Sample uniqueness remains global to system/topic/task, including historical pipeline rebuttals.
    const top = coverage.slots.filter(s=>s.system_id===slot.system_id && s.topic_id===slot.topic_id && s.task===slot.task).reduce((n,s)=>Math.max(n,s.top_sample),0);
    candidates.push({...slot,sample:top+1});
  };
  for (const system of coverage.systems.filter(s=>!systemId || s.id===systemId)) for (const topic of coverage.topics) {
    for (const task of ['government','opposition'] as const) if (coverage.prompts.some(p=>p.task===task)) add({system_id:system.id,topic_id:topic.id,task,government_source_response_id:null,opposition_source_response_id:null});
    if (!coverage.prompts.some(p=>p.task==='rebuttal')) continue;
    const own = coverage.oppositions.find(r=>r.system_id===system.id && r.topic_id===topic.id);
    if (!own) continue;
    for (const source of coverage.pool.filter(p=>p.topic_id===topic.id)) add({system_id:system.id,topic_id:topic.id,task:'rebuttal',government_source_response_id:source.government_response_id,opposition_source_response_id:own.id});
  }
  return candidates;
}
// Lower sorts first. Repeating a covered slot outweighs every other term combined, so an untested
// combination always wins; once everything is covered the same terms order the least-tested work.
const WEIGHT = { repeat: 40, pair: 8, system: 6, topic: 5, systemSide: 4, datasetSide: 2, spread: 2.5 };
const unitRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const ratio = (value: number, max: number) => max > 0 ? value / max : 0;

export function rankCandidates(coverage: Coverage, random: () => number = unitRandom, systemId?: string): Candidate[] {
  const candidates = buildCandidates(coverage, systemId);
  const totals = { slot: new Map<string, number>(), pair: new Map<string, number>(), system: new Map<string, number>(), topic: new Map<string, number>(), systemSide: new Map<string, number>(), side: new Map<string, number>() };
  const add = (into: Map<string, number>, key: string, runs: number) => into.set(key, (into.get(key) || 0) + runs);
  for (const slot of coverage.slots) {
    const side = taskSide(slot.task);
    add(totals.slot, slotKey(slot.system_id, slot.topic_id, slot.task, slot.std), slot.active_runs);
    add(totals.pair, [slot.system_id, slot.topic_id].join('|'), slot.active_runs);
    add(totals.system, slot.system_id, slot.active_runs);
    add(totals.topic, slot.topic_id, slot.active_runs);
    add(totals.systemSide, [slot.system_id, side].join('|'), slot.active_runs);
    add(totals.side, side, slot.active_runs);
  }
  // Independent cases have symmetric topic capacity on each side.
  const capacity = (_side: string) => Math.max(1, coverage.topics.length);
  const density = (source: Map<string, number>, prefix: string, side: string) => (source.get(prefix + side) || 0) / capacity(side);
  const sideShare = (source: Map<string, number>, prefix: string, side: string) => {
    const busiest = Math.max(density(source, prefix, 'Government'), density(source, prefix, 'Opposition'));
    return busiest > 0 ? density(source, prefix, side) / busiest : 0;
  };
  const runsOf = (source: Map<string, number>, key: string) => source.get(key) || 0;
  const pairRuns = (c: Candidate) => runsOf(totals.pair, [c.system_id, c.topic_id].join('|'));
  const systemRuns = (c: Candidate) => runsOf(totals.system, c.system_id);
  const topicRuns = (c: Candidate) => runsOf(totals.topic, c.topic_id);
  const peak = (of: (c: Candidate) => number) => candidates.reduce((max, c) => Math.max(max, of(c)), 0);
  const peaks = { pair: peak(pairRuns), system: peak(systemRuns), topic: peak(topicRuns) };
  const score = (c: Candidate) => {
    const side = taskSide(c.task);
    return WEIGHT.repeat * runsOf(totals.slot, slotKey(c.system_id, c.topic_id, c.task, c.government_source_response_id))
      + WEIGHT.pair * ratio(pairRuns(c), peaks.pair)
      + WEIGHT.system * ratio(systemRuns(c), peaks.system)
      + WEIGHT.topic * ratio(topicRuns(c), peaks.topic)
      + WEIGHT.systemSide * sideShare(totals.systemSide, c.system_id + '|', side)
      + WEIGHT.datasetSide * sideShare(totals.side, '', side)
      + WEIGHT.spread * random();
  };
  return candidates.map(candidate => ({ candidate, score: score(candidate) })).sort((a, b) => a.score - b.score).map(entry => entry.candidate);
}

function planFor(coverage: Coverage, candidate: Candidate): RunPlan {
  const system=coverage.systems.find(s=>s.id===candidate.system_id), topic=coverage.topics.find(t=>t.id===candidate.topic_id);
  const prompt=coverage.prompts.filter(p=>p.task===candidate.task).sort((a,b)=>b.version-a.version)[0];
  if (!system || !topic || !prompt) throw new HttpError(409,'That run is unavailable');
  const inputs: Record<string,string>={MOTION:topic.motion};
  const upstream: RunPlan['upstream']=[];
  if (candidate.task==='rebuttal') {
    const government=coverage.pool.find(p=>p.government_response_id===candidate.government_source_response_id);
    const opposition=coverage.oppositions.find(p=>p.id===candidate.opposition_source_response_id);
    if (!government || !opposition) throw new HttpError(409,'Required frozen source or structured Opposition case is unavailable');
    inputs.GOVERNMENT_CASE=government.core_case_json;
    inputs.OPPOSITION_CASE=JSON.stringify(coreCaseForRebuttal(structuredCaseSchema.parse(JSON.parse(opposition.case_json))));
    upstream.push({label:'Frozen Government case',response_id:government.government_response_id,text:inputs.GOVERNMENT_CASE},{label:'Own Opposition case',response_id:opposition.id,text:inputs.OPPOSITION_CASE});
  }
  return {...candidate,system,topic,rendered_prompt:renderPrompt(candidate.task,prompt.template,inputs),prompt_revision_id:prompt.id,prompt_version:prompt.version,upstream};
}
export async function runBoard(db: D1Database, systemId?: string, exclude?: string): Promise<RunBoard> {
  const coverage=await loadCoverage(db);
  const ranked=rankCandidates(coverage,unitRandom,systemId);
  const best=ranked.find(c=>slotKey(c.system_id,c.topic_id,c.task,c.government_source_response_id)!==exclude) || ranked[0];
  return {recommendation:best ? planFor(coverage,best) : null,systems:coverage.systems,
    queue:coverage.claims.map(c=>({...JSON.parse(c.plan_snapshot) as RunPlan,claim_id:c.id,claimed_at:c.claimed_at}))};
}
export async function claimRun(db: D1Database, input: unknown): Promise<RunClaim> {
  const slot=runSlotSchema.parse(input), coverage=await loadCoverage(db);
  const candidate=buildCandidates(coverage).find(c=>sameSlot(c,slot));
  if (!candidate) throw new HttpError(409,'That run is no longer executable. Load another recommendation.');
  // Include all historical sample reservations, even retired rebuttal pipeline rows.
  const top=await one<{sample:number}>(db,`SELECT max(sample) sample FROM (SELECT sample FROM responses WHERE system_id=? AND topic_id=? AND task=? UNION ALL SELECT sample FROM run_claims WHERE system_id=? AND topic_id=? AND task=? AND status='open')`,candidate.system_id,candidate.topic_id,candidate.task,candidate.system_id,candidate.topic_id,candidate.task);
  candidate.sample=(top?.sample || 0)+1;
  const plan=planFor(coverage,candidate), id=crypto.randomUUID();
  const stored=await db.prepare(`INSERT OR IGNORE INTO run_claims(id,system_id,topic_id,task,government_source_response_id,opposition_source_response_id,sample,rendered_prompt,prompt_revision_id,plan_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,candidate.system_id,candidate.topic_id,candidate.task,candidate.government_source_response_id,candidate.opposition_source_response_id,candidate.sample,plan.rendered_prompt,plan.prompt_revision_id,JSON.stringify(plan)).run();
  if (!stored.meta.changes) throw new HttpError(409,'Another tab reserved this sample. Load another recommendation.');
  const row=await one<{claimed_at:string}>(db,'SELECT claimed_at FROM run_claims WHERE id=?',id);
  return {...plan,claim_id:id,claimed_at:row!.claimed_at};
}
export async function releaseRun(db: D1Database, claimId: string) {
  const result=await db.prepare(`UPDATE run_claims SET status='released',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='open'`).bind(claimId).run();
  if (!result.meta.changes) throw new HttpError(404,'That run is not in progress');
  return {released:true};
}
export async function recordRun(db: D1Database, claimId: string, input: unknown) {
  const claim=await one<ClaimRow>(db,`SELECT * FROM run_claims WHERE id=? AND status='open' AND plan_snapshot IS NOT NULL`,claimId);
  if (!claim) throw new HttpError(404,'That run is not in progress');
  const result=runResultSchema.parse(input);
  if (result.prompt !== undefined && result.prompt !== claim.rendered_prompt) throw new HttpError(400,'The prompt must match the immutable started-run snapshot');
  const id=`run-${claimId}`;
  const plan=JSON.parse(claim.plan_snapshot) as RunPlan;
  await bulkImport(db,{responses:[{...result,id,system_id:claim.system_id,topic_id:claim.topic_id,task:claim.task,sample:claim.sample,prompt:claim.rendered_prompt,prompt_revision_id:claim.prompt_revision_id,
    government_source_response_id:claim.government_source_response_id,opposition_source_response_id:claim.opposition_source_response_id,
    rebuttal_input_snapshot:claim.task==='rebuttal' ? JSON.stringify(plan.upstream.map(s=>JSON.parse(s.text))) : null}]},claimId);
  return {saved:true,response_id:id};
}
