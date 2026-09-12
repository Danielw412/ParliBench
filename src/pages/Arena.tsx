import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { EyeSlashIcon } from '@phosphor-icons/react/dist/csr/EyeSlash';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { api, query } from '../api';
import { useAuth } from '../auth';
import { categoryOptions, taskOptions, Select, PageHeader, Loading, ErrorState, EmptyState, ResponseText, VoteScale, TaskBadge } from '../components';
import { METRIC_LABELS, METRIC_HELP, type ArenaMatch, type Judgment, type Metric, type VoteValue, type User } from '../../shared/domain';

export function Ballot({ match, initial, onSaved, editing = false }: { match: ArenaMatch; initial?: Judgment; onSaved: (names?: { a: string; b: string }) => void; editing?: boolean }) {
  const [overall, setOverall] = useState<VoteValue | null>(initial?.overall ?? null);
  const [votes, setVotes] = useState<Partial<Record<Metric, VoteValue | null>>>(initial?.metric_votes || {});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (overall == null) return; setBusy(true); setError('');
    try { const r = await api<{ names?: { a: string; b: string } }>(`/judgments/${match.id}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify({ overall, metrics: votes }) }); window.dispatchEvent(new Event('parlibench:judgment')); onSaved(r.names); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <form className="ballot" onSubmit={submit}>
    <div className="ballot-heading"><h2>Your judgment</h2><span className="caption">Metric votes are optional. Skip any you can’t assess.</span></div>
    <div className="metric-ballots">{match.metrics.map(m => <div className="metric-row" key={m}><div className="metric-name"><strong>{METRIC_LABELS[m]}</strong><p>{METRIC_HELP[m]}</p></div><VoteScale name={m} value={votes[m] ?? null} onChange={v => setVotes({ ...votes, [m]: v })} skip disabled={busy} /></div>)}</div>
    <div className="overall-ballot"><div><div className="overall-label">Overall preference<span>Required</span></div><p>Which response would you rather have during actual debate prep?</p></div><VoteScale name="Overall Preference" value={overall} onChange={setOverall} disabled={busy} /></div>
    {error && <ErrorState message={error} />}
    <div className="ballot-footer">{editing && <span className="caption">Your original comparison is preserved. Rankings use your latest vote.</span>}<button className="button dark" disabled={busy || overall == null}>{busy ? 'Saving…' : editing ? 'Update judgment' : 'Submit judgment'}<ArrowRightIcon size={18} /></button></div>
  </form>;
}
export function ResponsePair({ match }: { match: ArenaMatch }) {
  return <>{match.context && <details className="standard-case"><summary>Shared Government case <span>Both responses rebut this case</span></summary><ResponseText text={match.context} /></details>}<div className="response-pair">{(['a','b'] as const).map(side => <article className="response-panel" key={side}><div className="response-panel-header"><div><span className={`letter-square ${side === 'b' ? 'outline' : ''}`}>{side.toUpperCase()}</span><h2>Response {side.toUpperCase()}</h2></div><span><EyeSlashIcon size={15} /> Identity hidden</span></div><div className="response-scroll" tabIndex={0} aria-label={`Complete response ${side.toUpperCase()}`}><ResponseText text={match[side]} /><div className="end-response">End of response {side.toUpperCase()}</div></div></article>)}</div></>;
}
export default function Arena() {
  const { user, loading: authLoading, setUser } = useAuth();
  const [category, setCategory] = useState('all'), [task, setTask] = useState('all');
  const [match, setMatch] = useState<ArenaMatch | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [saved, setSaved] = useState(false), [names, setNames] = useState<{a: string;b: string} | undefined>(), [count, setCount] = useState(0);
  const active = useRef(false);
  async function loadNext(nextCategory = category, nextTask = task) {
    if (active.current) return; active.current = true;
    setLoading(true); setError(''); setSaved(false); setNames(undefined); setMatch(null);
    try { const result = await api<{ matchup: ArenaMatch | null }>(`/arena/next?${query({ category: nextCategory, task: nextTask })}`, { method: 'POST' }); setMatch(result.matchup); }
    catch (e) { setError((e as Error).message); } finally { setLoading(false); active.current = false; }
  }
  const userId = user?.id;
  useEffect(() => { if (userId) void loadNext(); }, [userId]); // New assignment only on explicit next/filter change, never speculative prefetch.
  async function revealChange(enabled: boolean) {
    if (!user) return;
    const previous = user;
    setUser({ ...user, reveal_names: enabled ? 1 : 0 });
    try { setUser(await api<User>('/settings', { method: 'PATCH', body: JSON.stringify({ reveal_names: enabled }) })); }
    catch (e) { setUser(previous); setError((e as Error).message); }
  }
  if (authLoading) return <Loading />;
  if (!user) return <div className="page"><div className="arena-gate"><h1>Arena</h1><p>Compare two anonymous responses to the same motion and record your judgment. An account needs only a username and a 4 or 6 digit PIN.</p><div className="hero-actions"><Link className="button dark" to="/register">Create account <ArrowRightIcon size={18} /></Link><Link className="button" to="/login">Sign in</Link></div></div></div>;
  return <div className="page arena-page">
    <PageHeader title="Arena" description="Two anonymous responses to the same motion. Vote on each metric you can assess, then give an overall preference." action={<div className="session-counter"><strong>{count}</strong><span>judged this session</span></div>} />
    <div className="arena-toolbar"><div className="filter-row"><Select label="Topic category" value={category} onChange={v => { if (!loading) { setCategory(v); void loadNext(v, task); } }} options={categoryOptions} /><Select label="Preparation task" value={task} onChange={v => { if (!loading) { setTask(v); void loadNext(category, v); } }} options={taskOptions} /></div><label className="check-setting"><input type="checkbox" checked={!!user.reveal_names} onChange={e => void revealChange(e.target.checked)} />Reveal system names after voting</label></div>
    {loading ? <Loading /> : error ? <ErrorState message={error} retry={() => void loadNext()} /> : !match ? <EmptyState title="No more matchups in this selection">You have judged every available pair for these filters. Try another category or task.</EmptyState> : saved ? <section className="vote-success" aria-live="polite"><h2>Judgment recorded</h2>{names && <div className="reveal-pair"><div><span className="letter-square">A</span><strong>{names.a}</strong></div><div><span className="letter-square outline">B</span><strong>{names.b}</strong></div></div>}<div className="vote-success-actions"><button className="button dark" onClick={() => { void loadNext(); window.scrollTo({ top: 0, behavior: 'instant' }); }}>Next matchup <ArrowRightIcon /></button><Link className="inline-link" to="/profile/me/judgments">Review or edit your judgments</Link></div></section> : <><div className="motion-card"><div className="motion-meta"><span className="badge">{match.category}</span><TaskBadge task={match.task} /><button className="text-button" onClick={() => void loadNext()}><ArrowClockwiseIcon size={15} /> Skip matchup</button></div><h2>{match.motion}</h2></div><ResponsePair match={match} /><Ballot key={match.id} match={match} onSaved={revealed => { setNames(revealed); setSaved(true); setCount(c => c + 1); window.scrollTo({ top: 0, behavior: 'instant' }); }} /></>}
  </div>;
}
