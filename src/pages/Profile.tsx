import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { useResource } from '../api';
import { useAuth } from '../auth';
import { PageHeader, Loading, ErrorState, RankingTable } from '../components';
import { METRIC_LABELS, TASK_LABELS, type Leaderboard } from '../../shared/domain';
interface ProfileData { username: string; user_type: string; created_at: string; judgment_count: number; counts: { category: string; task: string; count: number }[]; }
const views = [
  ['Overall Preference','metric=overall'], ['Weighted Benchmark','metric=weighted'], ['Government','task=government'], ['Opposition','task=opposition'],
  ['Serious','category=Serious'], ['Informal','category=Informal'], ...Object.entries(METRIC_LABELS).map(([k,v]) => [v,`metric=${k}`]),
];
export default function Profile() {
  const { username } = useParams(), { user } = useAuth();
  const profile = useResource<ProfileData>(`/profiles/${encodeURIComponent(username || '')}`);
  const [view, setView] = useState('metric=overall');
  const rank = useResource<Leaderboard>(`/profiles/${encodeURIComponent(username || '')}/leaderboard?${view}`);
  if (profile.loading) return <Loading />;
  if (profile.error || !profile.data) return <ErrorState message={profile.error || 'Profile not found'} />;
  const p = profile.data;
  return <div className="page">
    <PageHeader title={p.username} description={p.user_type} action={user?.username.toLowerCase() === p.username.toLowerCase() && <Link className="button" to="/profile/me/judgments">Review my judgments <ArrowUpRightIcon /></Link>} />
    <div className="profile-stats"><div><strong>{p.judgment_count}</strong><span>Judgments</span></div><div><strong>{p.counts.filter(c => c.category === 'Serious').reduce((s,c) => s+c.count,0)}</strong><span>Serious motions</span></div><div><strong>{p.counts.filter(c => c.category === 'Informal').reduce((s,c) => s+c.count,0)}</strong><span>Informal motions</span></div><div><strong>{new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</strong><span>Joined</span></div></div>
    <div className="profile-task-counts">{Object.entries(TASK_LABELS).map(([task,label]) => <span key={task}>{label}<strong>{p.counts.filter(c => c.task === task).reduce((s,c) => s+c.count,0)}</strong></span>)}</div>
    <section className="profile-personal">
      <h2>Personal leaderboard</h2>
      <p className="page-description">Ranked only from {p.username}’s own comparisons, using the benchmark’s standard metric weights.</p>
      <div className="profile-views" role="group" aria-label="Personal ranking view">{views.map(([label,q]) => <button key={q} aria-pressed={view === q} className={view === q ? 'active' : ''} onClick={() => setView(q)}>{label}</button>)}</div>
      {rank.loading ? <Loading /> : rank.error ? <ErrorState message={rank.error} retry={rank.reload} /> : rank.data && <RankingTable rows={rank.data.rows} />}
      <p className="caption">Sparse results stay visible with wider intervals and a low confidence flag.</p>
    </section>
  </div>;
}
