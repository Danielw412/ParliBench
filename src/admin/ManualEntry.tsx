import { useState, type FormEvent } from 'react';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { api } from '../api';
import { Select } from '../components';
import { METRICS, METRIC_LABELS, TASK_LABELS, type SystemInfo } from '../../shared/domain';
import { Section, SectionHead, useAction, useAdminData } from './ui';

interface Catalog { systems: SystemInfo[]; topics: { id: string; motion: string }[]; responses: { id: string; task: string }[]; judges: { id: string; display_name: string }[] }
type Field = { name: string; label: string; multiline?: boolean; optional?: boolean; options?: [string, string][]; value?: string; type?: string };
const entityOptions: [string, string][] = [['systems', 'System / configuration'], ['topics', 'Topic / motion'], ['responses', 'Response / run'], ['ai_judges', 'AI judge'], ['ai_votes', 'AI judgment']];
const voteOptions: [string, string][] = [['2', 'A much better'], ['1', 'A better'], ['0', 'Tie'], ['-1', 'B better'], ['-2', 'B much better']];

export default function ManualEntry() {
  const catalog = useAdminData<Catalog>('/admin/catalog'), action = useAction();
  const [entity, setEntity] = useState('systems'), [task, setTask] = useState('government'), [formKey, setFormKey] = useState(0);
  const references = (key: 'systems' | 'topics' | 'responses' | 'judges'): [string, string][] => (catalog.data?.[key] || []).map(r => [r.id, `${r.id}${'display_name' in r ? ` · ${r.display_name}` : ''}`]);
  const basic = (name: string, label: string, extra: Partial<Field> = {}): Field => ({ name, label, ...extra });
  let fields: Field[] = [];
  if (entity === 'systems') fields = [basic('id', 'Unique system ID'), basic('display_name', 'Display name'), basic('provider', 'Provider'), basic('model', 'Underlying model'), basic('interface', 'Product / interface'), basic('reasoning', 'Reasoning setting', { optional: true }), basic('configuration', 'Tools / configuration notes', { multiline: true, optional: true })];
  if (entity === 'topics') fields = [basic('id', 'Unique topic ID'), basic('motion', 'Motion', { multiline: true }), basic('category', 'Category', { options: [['Serious', 'Serious'], ['Informal', 'Informal']] }), basic('metadata_json', 'Future metadata (JSON object)', { value: '{}', optional: true })];
  if (entity === 'responses') fields = [basic('id', 'Unique response ID'), basic('system_id', 'System / configuration', { options: references('systems') }), basic('topic_id', 'Topic', { options: references('topics') }), basic('prompt', 'Exact prompt', { multiline: true }), basic('raw_output', 'Raw output', { multiline: true }), basic('display_output', 'Sanitized display output', { multiline: true }), basic('generated_at', 'Generation timestamp (ISO UTC)', { value: new Date().toISOString() }), basic('interface', 'Generation interface'), basic('reasoning', 'Reasoning setting', { optional: true }), basic('configuration', 'Tools / configuration', { multiline: true, optional: true }), basic('context_id', 'Context / thread ID'), basic('sample', 'Run / sample number', { type: 'number', value: '1' }), basic('duration_ms', 'Duration (milliseconds)', { type: 'number', optional: true })];
  if (entity === 'ai_judges') fields = [basic('id', 'Unique judge ID'), basic('system_id', 'Judge system', { options: references('systems') }), basic('display_name', 'Judge display name'), basic('version', 'Judge version')];
  if (entity === 'ai_votes') fields = [basic('id', 'Unique judgment ID'), basic('judge_id', 'AI judge', { options: references('judges') }), basic('response_a', 'Response A ID', { options: references('responses') }), basic('response_b', 'Response B ID', { options: references('responses') }), basic('overall', 'Overall preference', { options: voteOptions }), basic('snapshot_a', 'Exact response A text seen by offline judge', { multiline: true }), basic('snapshot_b', 'Exact response B text seen by offline judge', { multiline: true }), basic('version', 'Judgment version'), basic('judged_at', 'Judged timestamp (ISO UTC)', { value: new Date().toISOString() }), basic('explanation', 'Optional explanation', { multiline: true, optional: true }), ...METRICS.map(m => basic(`metric_${m}`, METRIC_LABELS[m], { optional: true, options: [['', 'Skip'], ...voteOptions] }))];
  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data: Record<string, unknown> = Object.fromEntries(new FormData(e.currentTarget));
    for (const [k, v] of Object.entries(data)) if (v === '') { if (['reasoning', 'duration_ms', 'explanation'].includes(k)) data[k] = null; else delete data[k]; }
    if (entity === 'responses') { data.task = task; data.sample = Number(data.sample); if (data.duration_ms != null) data.duration_ms = Number(data.duration_ms); }
    if (entity === 'ai_votes') {
      data.overall = Number(data.overall); const metrics: Record<string, number> = {};
      for (const m of METRICS) { if (data[`metric_${m}`] != null) metrics[m] = Number(data[`metric_${m}`]); delete data[`metric_${m}`]; }
      data.metrics = metrics;
    }
    void action.run(async () => { await api('/admin/import', { method: 'POST', body: JSON.stringify({ [entity]: [data] }) }); setFormKey(k => k + 1); catalog.reload(); }, 'Record created and relationships validated.');
  }
  return <section>
    <SectionHead title="Manual entry" description="Create one record at a time through the same atomic validation as JSON import. Next Run is the preferred path for new responses, because it snapshots the rendered prompt." />
    <Section loading={catalog.loading && !catalog.data} error={catalog.data ? '' : catalog.error} retry={catalog.reload}>
      <div className="filter-row admin-entity"><Select label="Record type" value={entity} onChange={setEntity} options={entityOptions} />{entity === 'responses' && <Select label="Task" value={task} onChange={setTask} options={Object.entries(TASK_LABELS).filter(([key]) => key !== 'rebuttal')} />}</div>
      {entity === 'responses' && <p className="notice">Government and Opposition receive only the motion. Rebuttals need frozen sources and input snapshots, so record them through Next Run.</p>}
      <form className="admin-form" key={`${entity}:${task}:${formKey}`} onSubmit={create}>
        {fields.map(field => <label className={field.multiline ? 'wide' : ''} key={field.name}>{field.label}{field.optional && <span className="muted"> · optional</span>}
          {field.options ? <select name={field.name} required={!field.optional}>{field.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
            : field.multiline ? <textarea name={field.name} rows={6} required={!field.optional} />
            : <input name={field.name} type={field.type || 'text'} defaultValue={field.value} required={!field.optional} min={field.name === 'sample' ? 1 : 0} />}</label>)}
        <div className="wide">{action.feedback}<button className="button dark" disabled={action.busy}><PlusIcon />{action.busy ? 'Importing…' : 'Validate & create'}</button></div>
      </form>
    </Section>
  </section>;
}
