import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, sessionKey } from './api';
import type { User } from '../shared/domain';
const AuthContext = createContext<{ user: User | null; loading: boolean; signIn: (token: string, user: User) => void; signOut: () => Promise<void>; setUser: (user: User) => void }>({ user: null, loading: true, signIn() {}, async signOut() {}, setUser() {} });
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null), [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!localStorage.getItem(sessionKey)) { setLoading(false); return; }
    api<User>('/auth/me').then(setUser).catch(e => { if (e instanceof ApiError && e.status === 401) localStorage.removeItem(sessionKey); }).finally(() => setLoading(false));
  }, []);
  const signIn = (token: string, next: User) => { localStorage.setItem(sessionKey, token); setUser(next); };
  const signOut = async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { localStorage.removeItem(sessionKey); setUser(null); } };
  return <AuthContext.Provider value={{ user, loading, signIn, signOut, setUser }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
