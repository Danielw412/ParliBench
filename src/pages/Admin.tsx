import { lazy, Suspense, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { LockSimpleIcon } from '@phosphor-icons/react/dist/csr/LockSimple';
import { useAuth } from '../auth';
import { Loading, PageHeader } from '../components';
import { useQueryState } from '../admin/ui';

// Each console section is its own module, loaded when first opened.
const sections: { group: string; items: { id: string; label: string; component: ComponentType }[] }[] = [
  { group: 'Benchmark', items: [
    { id: 'overview', label: 'Overview', component: lazy(() => import('../admin/Overview')) },
    { id: 'next', label: 'Next Run', component: lazy(() => import('../admin/NextRunSection')) },
    { id: 'runs', label: 'Run history', component: lazy(() => import('../admin/Runs')) },
  ] },
  { group: 'Content', items: [
    { id: 'responses', label: 'Responses', component: lazy(() => import('../admin/Responses')) },
    { id: 'systems', label: 'Systems', component: lazy(() => import('../admin/Systems')) },
    { id: 'topics', label: 'Topics', component: lazy(() => import('../admin/Topics')) },
    { id: 'prompts', label: 'Prompts', component: lazy(() => import('../admin/Prompts')) },
    { id: 'pool', label: 'Rebuttal Pool', component: lazy(() => import('../admin/RebuttalPool')) },
  ] },
  { group: 'Judgments', items: [
    { id: 'human-votes', label: 'Human votes', component: lazy(() => import('../admin/HumanVotes')) },
    { id: 'ai', label: 'AI judges & votes', component: lazy(() => import('../admin/AiJudges')) },
    { id: 'weights', label: 'Ranking weights', component: lazy(() => import('../admin/Weights')) },
  ] },
  { group: 'Data', items: [
    { id: 'manual', label: 'Manual entry', component: lazy(() => import('../admin/ManualEntry')) },
    { id: 'import', label: 'JSON import', component: lazy(() => import('../admin/JsonImport')) },
    { id: 'export', label: 'Export & backup', component: lazy(() => import('../admin/Export')) },
  ] },
  { group: 'People', items: [
    { id: 'accounts', label: 'Accounts', component: lazy(() => import('../admin/Accounts')) },
    { id: 'audit', label: 'Audit log', component: lazy(() => import('../admin/AuditLog')) },
  ] },
];
const all = sections.flatMap(s => s.items);

export default function Admin() {
  const { user, loading } = useAuth();
  const query = useQueryState();
  const requested = query.get('section', 'overview'), current = all.find(s => s.id === requested) || all[0];
  const header = <PageHeader title="Admin" description="Run the benchmark end to end: record runs, correct or remove responses, manage systems, topics, judges, votes, and accounts, and review every change." />;
  if (loading) return <div className="page admin-page">{header}<Loading /></div>;
  if (!user?.is_admin) return <div className="page admin-page">{header}<div className="admin-lock"><LockSimpleIcon size={30} /><h2>Administrator access</h2>{user ? <p className="muted">You are signed in as {user.username}. This account is not an administrator; an existing administrator can grant access from the Accounts section.</p> : <><p className="muted">Sign in with an administrator account. Access is granted per account, and there is no separate admin password.</p><Link className="button dark" to="/login">Sign in</Link></>}</div></div>;
  const open = (id: string) => query.set({ ...Object.fromEntries([...query.params.keys()].map(k => [k, null])), section: id }, true);
  const Current = current.component;
  return <div className="page admin-page">{header}
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Admin sections">
        {sections.map(group => <div key={group.group}><h2>{group.group}</h2>{group.items.map(item =>
          <Link key={item.id} to={`/admin?section=${item.id}`} className={item.id === current.id ? 'active' : ''} aria-current={item.id === current.id ? 'page' : undefined}>{item.label}</Link>)}</div>)}
      </nav>
      <label className="select-field admin-nav-select"><span>Admin section</span><select value={current.id} onChange={e => open(e.target.value)}>
        {sections.map(group => <optgroup key={group.group} label={group.group}>{group.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}
      </select></label>
      <div className="admin-main"><Suspense fallback={<Loading />}><Current key={current.id} /></Suspense></div>
    </div>
  </div>;
}
