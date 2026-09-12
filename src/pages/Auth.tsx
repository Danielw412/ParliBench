import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { LockSimpleIcon } from '@phosphor-icons/react/dist/csr/LockSimple';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorState } from '../components';
import type { User, UserType } from '../../shared/domain';
export default function Auth({ mode }: { mode: 'login' | 'register' }) {
  const { signIn, user } = useAuth(), navigate = useNavigate();
  const [username, setUsername] = useState(''), [pin, setPin] = useState(''), [type, setType] = useState<UserType>('Parliamentary Debater');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const register = mode === 'register';
  if (user) return <Navigate to="/arena" replace />;
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const result = await api<{ token: string; user: User }>(`/auth/${mode}`, { method: 'POST', body: JSON.stringify({ username, pin, ...(register ? { user_type: type } : {}) }) });
      signIn(result.token, result.user); navigate('/arena');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="auth-layout">
    <h1>{register ? 'Create an account' : 'Sign in'}</h1>
    {register && <p className="auth-intro">An account records your Arena judgments and builds your personal leaderboard. No email is needed.</p>}
    <form onSubmit={submit}>
      <label>Username<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} pattern="[A-Za-z0-9_]{3,24}" minLength={3} maxLength={24} required />{register && <span className="field-help">3 to 24 letters, numbers, or underscores.</span>}</label>
      <label>PIN<input autoComplete={register ? 'new-password' : 'current-password'} type="password" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} pattern="(?:[0-9]{4}|[0-9]{6})" maxLength={6} required />{register && <span className="field-help">4 or 6 digits. There is no account recovery, so keep it safe.</span>}</label>
      {register && <fieldset className="type-options"><legend>Debate experience</legend>{(['Parliamentary Debater', 'Non-Parliamentary Debater'] as const).map(t => <label key={t}><input type="radio" name="user-type" checked={type === t} onChange={() => setType(t)} />{t}</label>)}</fieldset>}
      {error && <ErrorState message={error} />}
      <button className="button dark full-width" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}<ArrowRightIcon /></button>
    </form>
    <p className="auth-switch">{register ? 'Already have an account?' : 'New to ParliBench?'} <Link to={register ? '/login' : '/register'}>{register ? 'Sign in' : 'Create an account'}</Link></p>
    <p className="caption"><LockSimpleIcon /> PINs are hashed. Profiles and aggregate judgments are public.</p>
  </div>;
}
