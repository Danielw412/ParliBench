import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { useAuth } from '../auth';
import { api, useResource } from '../api';
import { PageHeader, ErrorState, Loading, EmptyState, TaskBadge } from '../components';
import { Ballot, ResponsePair } from './Arena';
import { VOTE_OPTIONS, type Judgment } from '../../shared/domain';
interface HistoryRow { id: string; motion: string; task: string; category: string; overall: number; updated_at: string; }
export default function Judgments() {
  const { user, loading } = useAuth(), [offset,setOffset] = useState(0);
  const history = useResource<HistoryRow[]>(user ? `/judgments?offset=${offset}` : null);
  const [editing, setEditing] = useState<Judgment | null>(null), [busy,setBusy] = useState(false), [error,setError] = useState(''), [saved,setSaved] = useState(false);
  async function edit(id: string) {
    setBusy(true); setError(''); setSaved(false);
    try { setEditing(await api<Judgment>(`/judgments/${id}`)); } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (loading) return <Loading />;
  if (!user) return <EmptyState title="Sign in to review your judgments"><Link to="/login">Sign in</Link></EmptyState>;
  return <div className="page">
    <PageHeader title={editing ? 'Edit judgment' : 'Your judgments'} description={editing ? 'The original responses and A/B order are preserved below.' : 'Review past comparisons and update your votes. Rankings reflect your latest judgment.'} />
    {saved && <div role="status" className="notice">Judgment updated. Your rankings now use the revised vote.</div>}
    {error && <ErrorState message={error} />}
    {busy ? <Loading /> : editing ? <><button className="button small edit-back" onClick={() => setEditing(null)}><ArrowLeftIcon /> Back to judgments</button><div className="motion-card"><div className="motion-meta"><span className="badge">{editing.category}</span><TaskBadge task={editing.task} /></div><h2>{editing.motion}</h2></div><ResponsePair match={editing} /><Ballot key={editing.id} match={editing} initial={editing} editing onSaved={() => { setEditing(null); setSaved(true); history.reload(); window.scrollTo(0,0); }} /></> : history.loading ? <Loading /> : history.error ? <ErrorState message={history.error} /> : !history.data?.length ? <EmptyState title="No judgments on this page"><Link to="/arena">Enter the Arena</Link></EmptyState> : <div className="history-list">{history.data.map(h => <article key={h.id}><div><div className="history-meta"><TaskBadge task={h.task} /><span>{h.category}</span><time>{new Date(h.updated_at).toLocaleDateString()}</time></div><h3>{h.motion}</h3><p>Overall: <strong>{VOTE_OPTIONS.find(o => o.value === h.overall)?.label}</strong></p></div><button className="button small" onClick={() => void edit(h.id)}><PencilSimpleIcon />Edit</button></article>)}</div>}
    {!editing && <div className="pagination"><button className="button small" disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset-30))}>Previous</button><span className="mono">Page {offset / 30 + 1}</span><button className="button small" disabled={(history.data?.length || 0) < 30} onClick={() => setOffset(offset+30)}>Next</button></div>}
  </div>;
}
