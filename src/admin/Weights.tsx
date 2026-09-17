import { useEffect, useState } from 'react';
import { api } from '../api';
import { METRIC_LABELS, TASK_LABELS, applicableMetrics } from '../../shared/domain';
import { Section, SectionHead, useAction, useAdminData } from './ui';

interface Weights { weights: { task: string; metric: string; weight: number }[]; source: { human: number; ai: number } }
const percent = (n: number) => String(Math.round(n * 1000) / 10);

export default function WeightsSection() {
  const catalog = useAdminData<Weights>('/admin/catalog'), action = useAction();
  const [values, setValues] = useState<Record<string, string>>({});
  const reset = (data: Weights) => setValues({ human: percent(data.source.human), ai: percent(data.source.ai), ...Object.fromEntries(data.weights.map(w => [`${w.task}:${w.metric}`, percent(w.weight)])) });
  useEffect(() => { if (catalog.data) reset(catalog.data); }, [catalog.data]);
  const total = (keys: string[]) => keys.reduce((sum, key) => sum + (Number(values[key]) || 0), 0);
  const groups: [string, string, string[]][] = [['source', 'Source influence', ['human', 'ai']], ...Object.entries(TASK_LABELS).map(([task, label]) => [task, `${label} metric weights`, applicableMetrics(task).map(m => `${task}:${m}`)] as [string, string, string[]])];
  const invalid = groups.filter(([, , keys]) => Math.abs(total(keys) - 100) > 0.05);
  function save() {
    const data = catalog.data!;
    void action.run(() => api('/admin/weights', { method: 'PUT', body: JSON.stringify({ source: { human: Number(values.human) / 100, ai: Number(values.ai) / 100 }, benchmark: data.weights.map(w => ({ task: w.task, metric: w.metric, weight: Number(values[`${w.task}:${w.metric}`]) / 100 })) }) }).then(catalog.reload),
      'Ranking weights saved. Every leaderboard recalculates with them immediately.');
  }
  const label = (key: string) => key === 'human' ? 'Human judges' : key === 'ai' ? 'AI judges' : METRIC_LABELS[key.split(':')[1] as keyof typeof METRIC_LABELS];
  return <section>
    <SectionHead title="Ranking weights" description="Source shares keep a large AI import from overwhelming human judgment in Combined rankings. Metric weights define the Weighted Benchmark per task. Each group must total 100%." />
    <Section loading={catalog.loading && !catalog.data} error={catalog.data ? '' : catalog.error} retry={catalog.reload}>
      <div className="weights-form">{groups.map(([key, title, keys]) => <fieldset key={key}><legend>{title} (%) <span className={`weight-total ${Math.abs(total(keys) - 100) > 0.05 ? 'invalid' : ''}`}>Total {Math.round(total(keys) * 10) / 10}%</span></legend>
        <div className="weights-grid">{keys.map(k => <label key={k}>{label(k)}<input type="number" min="0" max="100" step="0.1" value={values[k] ?? ''} onChange={e => setValues(v => ({ ...v, [k]: e.target.value }))} required /></label>)}</div>
      </fieldset>)}</div>
      {invalid.length > 0 && <p className="caption" role="status">Adjust {invalid.map(([, title]) => title.toLowerCase()).join(', ')} to total 100% before saving.</p>}
      {action.feedback}
      <div className="row-actions"><button className="button dark" disabled={action.busy || invalid.length > 0} onClick={save}>Save ranking weights</button>{catalog.data && <button className="text-button" onClick={() => reset(catalog.data!)}>Discard changes</button>}</div>
    </Section>
  </section>;
}
