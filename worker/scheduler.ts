import { HttpError, one, rows } from './db';
import { bulkImport } from './importer';
import { runResultSchema, runSlotSchema } from './validation';
import { taskSide, type RunBoard, type RunClaim, type RunPlan, type RunSlot, type SystemInfo } from '../shared/domain';

interface TopicRow { id: string; motion: string; category: string }
interface StandardRow { id: string; topic_id: string; title: string; case_text: string }
interface SlotRow { system_id: string; topic_id: string; task: string; std: string; active_runs: number; top_sample: number }
interface ChainRow { id: string; system_id: string; topic_id: string; prediction_response_id: string | null; display_output: string; prediction_output: string | null }
interface PromptRow { topic_id: string; task: string; std: string; prompt: string }
interface ClaimRow extends RunSlot { id: string; sample: number; claimed_at: string }
export interface Candidate extends RunSlot { sample: number }
export interface Coverage {
  systems: SystemInfo[]; topics: TopicRow[]; standards: StandardRow[]; slots: SlotRow[];
  predictions: ChainRow[]; rebuttals: ChainRow[]; prompts: PromptRow[]; claims: ClaimRow[];
}

const slotKey = (system: string, topic: string, task: string, std: string | null) => [system, topic, task, std || ''].join('|');
const sameSlot = (a: RunSlot, b: RunSlot) => slotKey(a.system_id, a.topic_id, a.task, a.standardized_task_id) === slotKey(b.system_id, b.topic_id, b.task, b.standardized_task_id)
  && (a.prediction_response_id || '') === (b.prediction_response_id || '') && (a.rebuttal_response_id || '') === (b.rebuttal_response_id || '');

/** Coverage of the benchmark corpus. An open claim is an in-progress run: it counts exactly like an
 * imported run, so the next recommendation never duplicates work that is already underway.
 * Deactivated runs stop covering their slot, but every row still reserves its sample number. */
export async function loadCoverage(db: D1Database): Promise<Coverage> {
  const [systems, topics, standards, slots, predictions, rebuttals, prompts, claims] = await Promise.all([
    rows<SystemInfo>(db, 'SELECT * FROM systems WHERE active=1 ORDER BY display_name'),
    rows<TopicRow>(db, 'SELECT id,motion,category FROM topics WHERE active=1 ORDER BY id'),
    rows<StandardRow>(db, 'SELECT st.id,st.topic_id,st.title,st.case_text FROM standardized_rebuttal_tasks st JOIN topics t ON t.id=st.topic_id WHERE t.active=1 ORDER BY st.id'),
    rows<SlotRow>(db, `SELECT system_id,topic_id,task,coalesce(standardized_task_id,'') std,sum(active) active_runs,max(sample) top_sample
      FROM responses GROUP BY system_id,topic_id,task,std`),
    rows<ChainRow>(db, `SELECT r.id,r.system_id,r.topic_id,NULL prediction_response_id,r.display_output,NULL prediction_output FROM responses r
      JOIN opposition_predictions op ON op.response_id=r.id
      WHERE r.active=1 AND NOT EXISTS(SELECT 1 FROM opposition_rebuttals ob WHERE ob.prediction_response_id=r.id)`),
    rows<ChainRow>(db, `SELECT r.id,r.system_id,r.topic_id,ob.prediction_response_id,r.display_output,p.display_output prediction_output FROM opposition_rebuttals ob
      JOIN responses r ON r.id=ob.response_id JOIN responses p ON p.id=ob.prediction_response_id
      WHERE r.active=1 AND p.active=1 AND p.system_id=r.system_id
      AND NOT EXISTS(SELECT 1 FROM opposition_preps pr WHERE pr.rebuttal_response_id=r.id)`),
    // The exact prompt an earlier system received for the same motion and task, so repeated runs stay comparable.
    rows<PromptRow>(db, `SELECT r.topic_id,r.task,coalesce(r.standardized_task_id,'') std,r.prompt FROM responses r
      WHERE NOT EXISTS(SELECT 1 FROM responses n WHERE n.topic_id=r.topic_id AND n.task=r.task
        AND coalesce(n.standardized_task_id,'')=coalesce(r.standardized_task_id,'')
        AND (n.generated_at>r.generated_at OR (n.generated_at=r.generated_at AND n.id>r.id)))`),
    rows<ClaimRow>(db, `SELECT id,system_id,topic_id,task,standardized_task_id,prediction_response_id,rebuttal_response_id,sample,claimed_at
      FROM run_claims WHERE status='open' ORDER BY claimed_at`),
  ]);
  for (const claim of claims) {
    const key = slotKey(claim.system_id, claim.topic_id, claim.task, claim.standardized_task_id);
    const existing = slots.find(s => slotKey(s.system_id, s.topic_id, s.task, s.std) === key);
    if (existing) { existing.active_runs += 1; existing.top_sample = Math.max(existing.top_sample, claim.sample); }
    else slots.push({ system_id: claim.system_id, topic_id: claim.topic_id, task: claim.task, std: claim.standardized_task_id || '', active_runs: 1, top_sample: claim.sample });
  }
  return { systems, topics, standards, slots, predictions, rebuttals, prompts, claims };
}

/** Every run that could be imported right now. An Opposition stage appears only once the stage it
 * continues exists, so a recommendation is always executable and always importable. */
export function buildCandidates(coverage: Coverage): Candidate[] {
  const slots = new Map(coverage.slots.map(s => [slotKey(s.system_id, s.topic_id, s.task, s.std), s]));
  const claimedPredictions = new Set(coverage.claims.map(c => c.prediction_response_id));
  const claimedRebuttals = new Set(coverage.claims.map(c => c.rebuttal_response_id));
  const topics = new Set(coverage.topics.map(t => t.id));
  const candidates: Candidate[] = [];
  const add = (slot: RunSlot) => {
    const known = slots.get(slotKey(slot.system_id, slot.topic_id, slot.task, slot.standardized_task_id));
    candidates.push({ ...slot, sample: (known?.top_sample || 0) + 1 });
  };
  for (const system of coverage.systems) {
    for (const topic of coverage.topics) for (const task of ['government', 'prediction'] as const) {
      add({ system_id: system.id, topic_id: topic.id, task, standardized_task_id: null, prediction_response_id: null, rebuttal_response_id: null });
    }
    for (const standard of coverage.standards) {
      add({ system_id: system.id, topic_id: standard.topic_id, task: 'standardized_rebuttal', standardized_task_id: standard.id, prediction_response_id: null, rebuttal_response_id: null });
    }
    for (const prediction of coverage.predictions) {
      if (prediction.system_id !== system.id || !topics.has(prediction.topic_id) || claimedPredictions.has(prediction.id)) continue;
      add({ system_id: system.id, topic_id: prediction.topic_id, task: 'rebuttal', standardized_task_id: null, prediction_response_id: prediction.id, rebuttal_response_id: null });
    }
    for (const rebuttal of coverage.rebuttals) {
      if (rebuttal.system_id !== system.id || !topics.has(rebuttal.topic_id) || claimedRebuttals.has(rebuttal.id)) continue;
      add({ system_id: system.id, topic_id: rebuttal.topic_id, task: 'full_opposition', standardized_task_id: null, prediction_response_id: rebuttal.prediction_response_id, rebuttal_response_id: rebuttal.id });
    }
  }
  return candidates;
}

// Lower sorts first. Repeating a covered slot outweighs every other term combined, so an untested
// combination always wins; once everything is covered the same terms order the least-tested work.
const WEIGHT = { repeat: 40, pair: 8, system: 6, topic: 5, systemSide: 4, datasetSide: 2, spread: 2.5 };
const unitRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const ratio = (value: number, max: number) => max > 0 ? value / max : 0;

export function rankCandidates(coverage: Coverage, random: () => number = unitRandom): Candidate[] {
  const candidates = buildCandidates(coverage);
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
  // Government holds one slot per topic and Opposition holds several, so the two sides are compared by density.
  const capacity = (side: string) => side === 'Government' ? Math.max(1, coverage.topics.length) : Math.max(1, coverage.topics.length * 3 + coverage.standards.length);
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
    return WEIGHT.repeat * runsOf(totals.slot, slotKey(c.system_id, c.topic_id, c.task, c.standardized_task_id))
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
  const system = coverage.systems.find(s => s.id === candidate.system_id);
  const topic = coverage.topics.find(t => t.id === candidate.topic_id);
  if (!system || !topic) throw new HttpError(409, 'That run references an inactive system or topic');
  // A prediction leaves the open list once it has been rebutted, so the rebuttal carries its text
  // forward: a full preparation shows both stages it continues.
  const staged = new Map(coverage.predictions.map(p => [p.id, p.display_output]));
  for (const rebuttal of coverage.rebuttals) {
    staged.set(rebuttal.id, rebuttal.display_output);
    if (rebuttal.prediction_response_id && rebuttal.prediction_output) staged.set(rebuttal.prediction_response_id, rebuttal.prediction_output);
  }
  const labels: [string, string | null][] = [['Opposition prediction to rebut in a fresh context', candidate.prediction_response_id], ['Fresh-context rebuttal already recorded', candidate.rebuttal_response_id]];
  const upstream = labels.flatMap(([label, id]) => {
    const text = id ? staged.get(id) : undefined;
    return id && text ? [{ label, response_id: id, text }] : [];
  });
  const reference = coverage.prompts.find(p => p.topic_id === candidate.topic_id && p.task === candidate.task && p.std === (candidate.standardized_task_id || ''));
  return { ...candidate, system, topic, standardized_case: coverage.standards.find(s => s.id === candidate.standardized_task_id) || null, upstream, prompt_reference: reference?.prompt || null };
}

export async function runBoard(db: D1Database): Promise<RunBoard> {
  const coverage = await loadCoverage(db);
  const [best] = rankCandidates(coverage);
  const queue: RunClaim[] = [];
  for (const claim of coverage.claims) {
    // A claim whose system or topic was deactivated stays in the table until it is released.
    try { queue.push({ ...planFor(coverage, claim), claim_id: claim.id, claimed_at: claim.claimed_at }); } catch { continue; }
  }
  return { recommendation: best ? planFor(coverage, best) : null, queue };
}

export async function claimRun(db: D1Database, input: unknown): Promise<RunClaim> {
  const slot = runSlotSchema.parse(input);
  const coverage = await loadCoverage(db);
  // Claiming re-derives the candidate, so a stale page can never reserve a run that is no longer valid.
  const candidate = buildCandidates(coverage).find(c => sameSlot(c, slot));
  if (!candidate) throw new HttpError(409, 'That run is no longer available. Load the next recommendation.');
  const id = crypto.randomUUID();
  const claimed = await db.prepare(`INSERT OR IGNORE INTO run_claims(id,system_id,topic_id,task,standardized_task_id,prediction_response_id,rebuttal_response_id,sample)
    VALUES(?,?,?,?,?,?,?,?)`).bind(id, candidate.system_id, candidate.topic_id, candidate.task, candidate.standardized_task_id, candidate.prediction_response_id, candidate.rebuttal_response_id, candidate.sample).run();
  if (!claimed.meta.changes) throw new HttpError(409, 'That run is already in progress');
  const stored = await one<{ claimed_at: string }>(db, 'SELECT claimed_at FROM run_claims WHERE id=?', id);
  return { ...planFor(coverage, candidate), claim_id: id, claimed_at: stored!.claimed_at };
}

export async function releaseRun(db: D1Database, claimId: string) {
  const result = await db.prepare(`UPDATE run_claims SET status='released',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='open'`).bind(claimId).run();
  if (!result.meta.changes) throw new HttpError(404, 'That run is not in progress');
  return { released: true };
}

async function responseId(db: D1Database, claim: ClaimRow): Promise<string> {
  const base = [claim.system_id, claim.topic_id, claim.task, claim.sample].join('-').slice(0, 72);
  const taken = await one(db, 'SELECT id FROM responses WHERE id=?', base);
  return taken ? `${base}-${crypto.randomUUID().slice(0, 6)}` : base;
}

/** The response produced offline for an in-progress run. Provenance, pipeline links, blinding, and
 * sample uniqueness go through exactly the same import validation as every other record. */
export async function recordRun(db: D1Database, claimId: string, input: unknown) {
  const claim = await one<ClaimRow>(db, `SELECT id,system_id,topic_id,task,standardized_task_id,prediction_response_id,rebuttal_response_id,sample,claimed_at
    FROM run_claims WHERE id=? AND status='open'`, claimId);
  if (!claim) throw new HttpError(404, 'That run is not in progress');
  const result = runResultSchema.parse(input);
  const id = await responseId(db, claim);
  const payload = {
    responses: [{ ...result, id, system_id: claim.system_id, topic_id: claim.topic_id, task: claim.task, standardized_task_id: claim.standardized_task_id, sample: claim.sample }],
    ...(claim.task === 'prediction' ? { opposition_predictions: [{ response_id: id }] } : {}),
    ...(claim.task === 'rebuttal' ? { opposition_rebuttals: [{ response_id: id, prediction_response_id: claim.prediction_response_id, fresh_context: 1 }] } : {}),
    ...(claim.task === 'full_opposition' ? { opposition_preps: [{ response_id: id, prediction_response_id: claim.prediction_response_id, rebuttal_response_id: claim.rebuttal_response_id }] } : {}),
  };
  await bulkImport(db, payload);
  await db.prepare(`UPDATE run_claims SET status='filled',response_id=?,resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).bind(id, claimId).run();
  return { saved: true, response_id: id };
}
