import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { api } from '../api';
import { ErrorState, Loading } from '../components';
import { HISTORICAL_TASKS, TASK_LABELS, VOTE_OPTIONS } from '../../shared/domain';
import type { AdminOptions, ImpactKind, ImpactReport, Page } from '../../shared/admin';

/** Loads admin data, keeping the previous result on screen while it refreshes. */
export function useAdminData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(!!path);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(v => v + 1), []);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    api<T>(path, { signal: controller.signal }).then(setData)
      .catch(e => { if ((e as Error).name !== 'AbortError') setError((e as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, version]);
  return { data, error, loading, reload };
}

export const useOptions = () => useAdminData<AdminOptions>('/admin/options');
/** Busy, error, and success state for one panel's mutations. */
export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const run = useCallback(async <T,>(action: () => Promise<T>, message: string | ((result: T) => string) = '') => {
    setBusy(true); setError(''); setNotice('');
    try { const result = await action(); setNotice(typeof message === 'function' ? message(result) : message); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }, []);
  const feedback = <>{error && <ErrorState message={error} />}{notice && <div className="notice" role="status"><CheckIcon />{notice}</div>}</>;
  return { busy, run, feedback, setNotice };
}

/** Section state lives in the URL, so a reload or a shared link reopens the same view. */
export function useQueryState() {
  const [params, setParams] = useSearchParams();
  const get = (key: string, fallback = '') => params.get(key) ?? fallback;
  const set = (values: Record<string, string | number | null | undefined>, push = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === undefined || value === '') next.delete(key); else next.set(key, String(value));
    }
    setParams(next, { replace: !push });
  };
  return { params, get, set };
}
export const adminLink = (section: string, extra: Record<string, string> = {}) => `/admin?${new URLSearchParams({ section, ...extra })}`;
export const queryString = (values: Record<string, string | number | null | undefined>) =>
  new URLSearchParams(Object.entries(values).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, String(v)])).toString();

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export const fmt = {
  n: (value: number | null | undefined) => value == null ? '—' : value.toLocaleString(),
  date: (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—',
  day: (value: string | null | undefined) => value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—',
  ago: (value: string | null | undefined) => {
    if (!value) return '—';
    const seconds = (new Date(value).getTime() - Date.now()) / 1000;
    for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]] as const)
      if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    return 'just now';
  },
  duration: (ms: number | null | undefined) => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`,
  task: (task: string) => TASK_LABELS[task as keyof typeof TASK_LABELS] || `${(task[0].toUpperCase() + task.slice(1)).replace(/_/g, ' ')} (legacy)`,
  vote: (value: number) => VOTE_OPTIONS.find(o => o.value === value)?.label || String(value),
  chars: (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k chars` : `${value} chars`,
  pct: (value: number) => `${(value * 100).toFixed(1)}%`,
};
export const isLegacyTask = (task: string) => (HISTORICAL_TASKS as readonly string[]).includes(task);

export function SectionHead({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return <div className="admin-section-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="admin-head-actions">{actions}</div>}</div>;
}
export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}
export function Pager({ page, onChange }: { page: Page<unknown>; onChange: (offset: number) => void }) {
  const first = page.total ? page.offset + 1 : 0, last = Math.min(page.total, page.offset + page.rows.length);
  return <div className="pager"><span className="mono">{first}–{last} of {page.total.toLocaleString()}</span>{page.total > page.limit && <span className="pager-buttons">
    <button className="button small" disabled={page.offset === 0} onClick={() => onChange(Math.max(0, page.offset - page.limit))}>Previous</button>
    <button className="button small" disabled={page.offset + page.limit >= page.total} onClick={() => onChange(page.offset + page.limit)}>Next</button>
  </span>}</div>;
}
/** A native modal dialog: focus stays inside, Escape closes it. */
export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; if (!dialog.open) dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`admin-dialog ${wide ? 'wide' : ''}`} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onMouseDown={e => { if (e.target === ref.current) onClose(); }}>
    <div className="admin-dialog-body"><h2>{title}</h2>{children}</div>
  </dialog>;
}
export function ConfirmDialog({ title, children, confirmLabel, danger = false, reason = false, typeToConfirm = false, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; reason?: boolean; typeToConfirm?: boolean; onConfirm: (reason: string) => Promise<unknown>; onClose: () => void;
}) {
  const action = useAction(), [text, setText] = useState(''), [typed, setTyped] = useState('');
  return <Dialog title={title} onClose={onClose}>
    <div className="dialog-copy">{children}</div>
    {reason && <label>Reason<span className="muted"> · optional, saved in the audit log</span><input value={text} maxLength={1000} onChange={e => setText(e.target.value)} /></label>}
    {typeToConfirm && <label>Type <code>delete</code> to confirm<input value={typed} autoComplete="off" onChange={e => setTyped(e.target.value)} /></label>}
    {action.feedback}
    <div className="dialog-actions"><button className="button" onClick={onClose}>Cancel</button>
      <button className={`button ${danger ? 'danger-solid' : 'dark'}`} disabled={action.busy || (typeToConfirm && typed.trim().toLowerCase() !== 'delete')} onClick={async () => { if (await action.run(() => onConfirm(text))) onClose(); }}>{action.busy ? 'Working…' : confirmLabel}</button></div>
  </Dialog>;
}

const DELETE_PATHS: Record<ImpactKind, [string, string]> = { response: ['responses', 'response'], system: ['systems', 'system'], topic: ['topics', 'topic'], judge: ['judges', 'AI judge'], user: ['users', 'account'] };
/** Shows exactly what a deletion removes, as computed by the server, before anything is deleted. */
export function DeleteDialog({ kind, id, onClose, onDeleted }: { kind: ImpactKind; id: string; onClose: () => void; onDeleted: () => void }) {
  const impact = useAdminData<ImpactReport>(`/admin/impact/${kind}/${encodeURIComponent(id)}`);
  const action = useAction(), [reason, setReason] = useState(''), [typed, setTyped] = useState('');
  const report = impact.data, [path, noun] = DELETE_PATHS[kind];
  const removed: [string, number][] = report ? ([['Responses', report.responses], ['Dependent responses (Rebuttals, pipeline stages)', report.dependent_responses], ['Matchups', report.matchups],
    ['Arena assignments', report.assignments], ['Human votes', report.human_votes], ['AI votes', report.ai_votes], ['Run records', report.claims],
    ['Frozen Rebuttal sources', report.pool_sources], ['AI judges', report.judges], ['Sessions', report.sessions]] as [string, number][]).filter(([, n]) => n > 0) : [];
  const serious = !!report && (report.responses + report.dependent_responses > 1 || report.human_votes + report.ai_votes > 0 || kind === 'system' || kind === 'topic' || kind === 'user');
  return <Dialog title={`Delete this ${noun}?`} onClose={onClose}>
    {!report ? (impact.error ? <ErrorState message={impact.error} /> : <Loading />) : <>
      <p className="dialog-label">{report.label}</p>
      {report.blockers.length ? <div className="notice error" role="alert"><WarningIcon size={18} /><span>{report.blockers.join(' ')}</span></div> : <>
        {removed.length ? <><p className="dialog-copy">This permanently removes:</p><dl className="impact-list">{removed.map(([label, n]) => <div key={label}><dt>{label}</dt><dd className="mono">{n.toLocaleString()}</dd></div>)}</dl></>
          : <p className="dialog-copy">Nothing else depends on this record.</p>}
        <p className="caption">Rankings recalculate without removed votes. The audit log keeps a record of the deletion{kind === 'response' ? ', including the full response' : ''}.</p>
        <label>Reason<span className="muted"> · optional, saved in the audit log</span><input value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} /></label>
        {serious && <label>Type <code>delete</code> to confirm<input value={typed} autoComplete="off" onChange={e => setTyped(e.target.value)} /></label>}
      </>}
    </>}
    {action.feedback}
    <div className="dialog-actions"><button className="button" onClick={onClose}>Cancel</button>
      {report && !report.blockers.length && <button className="button danger-solid" disabled={action.busy || (serious && typed.trim().toLowerCase() !== 'delete')}
        onClick={async () => { if (await action.run(() => api(`/admin/${path}/${encodeURIComponent(id)}?${queryString({ reason })}`, { method: 'DELETE' }))) { onClose(); onDeleted(); } }}>
        <TrashIcon size={15} />{action.busy ? 'Deleting…' : 'Delete permanently'}</button>}</div>
  </Dialog>;
}
export function DeleteButton({ kind, id, label = 'Delete', small = false, onDeleted }: { kind: ImpactKind; id: string; label?: string; small?: boolean; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  return <><button className={`button danger ${small ? 'small' : ''}`} onClick={() => setOpen(true)}><TrashIcon size={15} />{label}</button>
    {open && <DeleteDialog kind={kind} id={id} onClose={() => setOpen(false)} onDeleted={onDeleted} />}</>;
}
export function ActiveBadge({ active }: { active: number }) { return active ? <span className="badge">Active</span> : <span className="badge alert">Inactive</span>; }
/** Selects keep option values as strings; an empty value means "all". */
export function FilterSelect({ label, value, onChange, options, all }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][]; all?: string }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}>{all !== undefined && <option value="">{all}</option>}{options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select></label>;
}
export function SearchField({ label = 'Search', value, onSearch, placeholder }: { label?: string; value: string; onSearch: (value: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  // Searches after typing pauses; the latest onSearch is read when the timer fires.
  const latest = useRef(onSearch); latest.current = onSearch;
  useEffect(() => { if (text.trim() === value) return; const timer = setTimeout(() => latest.current(text.trim()), 350); return () => clearTimeout(timer); }, [text, value]);
  return <label className="select-field search-field"><span>{label}</span><input type="search" value={text} placeholder={placeholder} onChange={e => setText(e.target.value)} /></label>;
}
export function Section({ loading, error, retry, children }: { loading: boolean; error: string; retry?: () => void; children: ReactNode }) {
  if (error) return <ErrorState message={error} retry={retry} />;
  if (loading) return <Loading />;
  return <>{children}</>;
}
export function download(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
