import type { RankingRow } from '../shared/domain';

export interface Comparison { a: string; b: string; outcome: number; weight: number; ballot: string; source: 'human' | 'ai'; }
export interface RankingEngine { fit(ids: string[], comparisons: Comparison[]): RankingRow[]; }
export const preferenceOutcome = (value: number) => (value + 2) / 4;
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const skillToRating = (skill: number) => 1500 + 400 * skill / Math.LN10;
export const skillToScore = (skill: number) => 100 * sigmoid(skill);

export function balanceSources(comparisons: Comparison[], human: number, ai: number): Comparison[] {
  const mass = { human: 0, ai: 0 };
  for (const c of comparisons) mass[c.source] += c.weight;
  const desired = { human, ai };
  const present = (['human', 'ai'] as const).filter(s => mass[s] > 0 && desired[s] > 0);
  if (!present.length) return [];
  // Keep each source's total influence fixed. Never amplify observations into fictitious precision.
  const scale = Math.min(...present.map(s => mass[s] / desired[s]));
  return comparisons.filter(c => desired[c.source] > 0).map(c => ({ ...c, weight: c.weight * scale * desired[c.source] / mass[c.source] }));
}

function inverse(matrix: number[][]): number[][] {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const d = a[i][i];
    for (let k = 0; k < 2 * n; k++) a[i][k] /= d;
    for (let j = 0; j < n; j++) if (j !== i) {
      const f = a[j][i]; for (let k = 0; k < 2 * n; k++) a[j][k] -= f * a[i][k];
    }
  }
  return a.map(row => row.slice(n));
}

/** Regularized fractional-outcome Bradley–Terry, with full-Hessian uncertainty.
 * Each ballot has at most unit likelihood mass, even for six voted metrics.
 * A weak N(0, 2^2) prior ensures finite estimates for undefeated/sparse systems.
 */
export const bradleyTerry: RankingEngine = {
  fit(ids, comparisons) {
    if (!ids.length) return [];
    const n = ids.length, index = new Map(ids.map((id, i) => [id, i]));
    const data = comparisons.filter(c => c.weight > 0 && index.has(c.a) && index.has(c.b) && c.a !== c.b);
    const skills = Array(n).fill(0) as number[];
    const prior = 0.25;
    const hessian = () => {
      const h = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? prior : 0));
      const g = skills.map(x => -prior * x);
      for (const c of data) {
        const i = index.get(c.a)!, j = index.get(c.b)!;
        const p = sigmoid(skills[i] - skills[j]);
        const v = c.weight * p * (1 - p), residual = c.weight * (c.outcome - p);
        g[i] += residual; g[j] -= residual;
        h[i][i] += v; h[j][j] += v; h[i][j] -= v; h[j][i] -= v;
      }
      return { h, g };
    };
    for (let step = 0; step < 60; step++) {
      const { h, g } = hessian(), inv = inverse(h);
      const delta = inv.map(row => row.reduce((v, x, j) => v + x * g[j], 0));
      const damping = Math.min(1, 1 / Math.max(1, ...delta.map(Math.abs)));
      for (let i = 0; i < n; i++) skills[i] += delta[i] * damping;
      if (Math.max(...delta.map(Math.abs)) < 1e-7) break;
    }
    const cov = inverse(hessian().h);
    const totalCov = cov.reduce((sum, row) => sum + row.reduce((v, x) => v + x, 0), 0) / (n * n);
    const components = ids.map((_, i) => i);
    for (const c of data) {
      const from = components[index.get(c.b)!], to = components[index.get(c.a)!];
      for (let i = 0; i < n; i++) if (components[i] === from) components[i] = to;
    }
    const disconnected = new Set(components).size > 1;
    return ids.map((id, i) => {
      const own = data.filter(c => c.a === id || c.b === id);
      const count = new Set(own.map(c => c.ballot)).size;
      const mass = own.reduce((sum, c) => sum + c.weight, 0);
      const win = own.reduce((sum, c) => sum + c.weight * (c.a === id ? c.outcome : 1 - c.outcome), 0);
      // Center covariance using the complete inverse, accounting for opponent uncertainty.
      const variance = Math.max(count ? 0 : 1 / prior, cov[i][i] - 2 * cov[i].reduce((sum, x) => sum + x, 0) / n + totalCov);
      const error = 1.96 * Math.sqrt(variance);
      const lo = skills[i] - error, hi = skills[i] + error;
      return { id, score: skillToScore(skills[i]), rating: skillToRating(skills[i]), win_rate: mass ? win / mass : 0.5,
        comparisons: count, ci: [skillToScore(lo), skillToScore(hi)] as [number, number],
        rating_ci: [skillToRating(lo), skillToRating(hi)] as [number, number],
        low_confidence: count < 20 || mass < 10 || disconnected || error > 1, component: components[i] };
    }).sort((a, b) => Number(b.comparisons > 0) - Number(a.comparisons > 0) || b.score - a.score || a.id.localeCompare(b.id));
  },
};

export function wilsonInterval(successes: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n, z = 1.96, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
