import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { EmptyState } from '../components';
import type { User } from '../../shared/domain';
import type { AdminAccount, Page } from '../../shared/admin';
import { adminLink, DeleteButton, FilterSelect, fmt, Pager, queryString, SearchField, Section, SectionHead, useAction, useAdminData, useQueryState } from './ui';

export default function Accounts() {
  const query = useQueryState(), filters = { q: query.get('q'), role: query.get('role'), offset: query.get('offset') };
  const accounts = useAdminData<Page<AdminAccount>>(`/admin/accounts?${queryString(filters)}`), page = accounts.data;
  const open = query.get('account');
  return <section>
    <SectionHead title="Accounts" description="Every registered judge. Grant or revoke administrator access, correct a judge type, rename, reset a PIN, sign someone out, or delete an account with its votes. Changes to access apply to open sessions immediately." />
    <div className="filter-row admin-filters">
      <SearchField label="Username" value={filters.q} onSearch={v => query.set({ q: v, offset: null, account: null })} placeholder="Search usernames" />
      <FilterSelect label="Role" value={filters.role} all="Everyone" onChange={v => query.set({ role: v, offset: null, account: null })} options={[['admin', 'Administrators'], ['user', 'Judges without admin access']]} />
    </div>
    <Section loading={accounts.loading && !page} error={page ? '' : accounts.error} retry={accounts.reload}>{page && (page.rows.length ? <>
      <div className="table-scroll"><table className="admin-table">
        <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col" className="num">Votes</th><th scope="col">Last vote</th><th scope="col" className="num">Sessions</th><th scope="col">Joined</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{page.rows.map(a => <Fragment key={a.id}>
          <tr className={open === a.id ? 'selected' : ''}>
            <td><span className="row-title">{a.username}</span><small className="cell-note">{a.user_type}</small></td>
            <td>{a.is_admin ? <span className="badge ink">Administrator</span> : <span className="badge">Judge</span>}</td>
            <td className="num mono">{fmt.n(a.votes)}{a.assignments > a.votes && <small className="cell-note">{a.assignments - a.votes} unvoted</small>}</td>
            <td className="nowrap">{fmt.ago(a.last_vote_at)}</td>
            <td className="num mono">{a.sessions}</td>
            <td className="nowrap">{fmt.day(a.created_at)}</td>
            <td className="row-actions"><button className="button small" aria-expanded={open === a.id} onClick={() => query.set({ account: open === a.id ? null : a.id })}>{open === a.id ? 'Close' : 'Manage'}</button></td>
          </tr>
          {open === a.id && <tr className="row-detail"><td colSpan={7}><ManageAccount key={JSON.stringify(a)} account={a} onChanged={accounts.reload} onDeleted={() => { query.set({ account: null }); accounts.reload(); }} /></td></tr>}
        </Fragment>)}</tbody>
      </table></div>
      <Pager page={page} onChange={offset => query.set({ offset, account: null })} />
    </> : <EmptyState title="No accounts match">Change the search or role filter.</EmptyState>)}</Section>
  </section>;
}

function ManageAccount({ account: a, onChanged, onDeleted }: { account: AdminAccount; onChanged: () => void; onDeleted: () => void }) {
  const { user, setUser } = useAuth(), action = useAction(), self = a.id === user?.id;
  const [username, setUsername] = useState(a.username), [type, setType] = useState(a.user_type), [pin, setPin] = useState('');
  const patch = (body: Record<string, unknown>, message: string) => action.run(async () => {
    await api(`/admin/users/${a.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    // Revoking your own access re-reads the account, so the console falls back to its no-access state.
    if (self) setUser(await api<User>('/auth/me'));
    onChanged();
  }, message);
  return <div className="manage-account">
    {action.feedback}
    <div className="manage-grid">
      <div className="tool-panel"><h4>Access</h4>
        <p className="caption">{a.is_admin ? 'Administrators can use every tool on this page.' : 'Judges can use the Arena and their own profile only.'} At least one administrator must remain.</p>
        <button className={`button ${a.is_admin ? 'danger' : 'dark'}`} disabled={action.busy} onClick={() => void patch({ is_admin: !a.is_admin }, a.is_admin ? `${a.username} no longer has administrator access.` : `${a.username} is now an administrator.`)}>
          {a.is_admin ? (self ? 'Revoke my access' : 'Revoke administrator access') : 'Make administrator'}</button></div>
      <div className="tool-panel"><h4>Profile</h4>
        <div className="filter-row">
          <label className="select-field"><span>Username</span><input value={username} maxLength={24} onChange={e => setUsername(e.target.value)} /></label>
          <label className="select-field"><span>Judge type</span><select value={type} onChange={e => setType(e.target.value as AdminAccount['user_type'])}><option>Parliamentary Debater</option><option>Non-Parliamentary Debater</option></select></label>
          <button className="button" disabled={action.busy || (username === a.username && type === a.user_type) || !/^[A-Za-z0-9_]{3,24}$/.test(username)}
            onClick={() => void patch({ ...(username !== a.username ? { username } : {}), ...(type !== a.user_type ? { user_type: type } : {}) }, 'Profile saved. Subgroup rankings use the new judge type immediately.')}>Save profile</button>
        </div></div>
      <div className="tool-panel"><h4>Sign-in</h4>
        <div className="filter-row">
          <label className="select-field"><span>New PIN (4 or 6 digits)</span><input value={pin} inputMode="numeric" autoComplete="new-password" maxLength={6} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} /></label>
          <button className="button" disabled={action.busy || !/^(\d{4}|\d{6})$/.test(pin)} onClick={() => void action.run(async () => { await api(`/admin/users/${a.id}/pin`, { method: 'POST', body: JSON.stringify({ pin }) }); setPin(''); onChanged(); }, `PIN reset. ${self ? 'Your other sessions were' : `${a.username} was`} signed out; share the new PIN privately.`)}>Reset PIN</button>
        </div>
        <button className="button" disabled={action.busy || !a.sessions} onClick={() => void action.run(() => api<{ revoked: number }>(`/admin/users/${a.id}/sessions`, { method: 'DELETE' }).then(r => { onChanged(); return r; }), r => `Signed out of ${r.revoked} session${r.revoked === 1 ? '' : 's'}.`)}>
          {self ? 'Sign out my other sessions' : `Sign out everywhere (${a.sessions})`}</button></div>
    </div>
    <div className="row-actions">
      <Link className="button" to={adminLink('human-votes', { user: a.id, username: a.username })}>View votes ({a.votes})</Link>
      <Link className="button" to={`/profile/${a.username}`}>Public profile</Link>
      {!self && <DeleteButton kind="user" id={a.id} label="Delete account…" onDeleted={onDeleted} />}
    </div>
  </div>;
}
