import { useCallback, useEffect, useState } from 'react';
const API = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? '/api' : '')).replace(/\/$/, '');
export const sessionKey = 'parlibench.session.v1';
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, options: RequestInit = {}, adminSecret?: string): Promise<T> {
  if (!API) throw new Error('Backend URL is not configured. Set VITE_API_URL when building the frontend.');
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  const token = localStorage.getItem(sessionKey);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (adminSecret) headers.set('X-Admin-Secret', adminSecret);
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const value = await response.json().catch(() => ({ error: 'Unexpected backend response' }));
  if (!response.ok) throw new ApiError(value.error || 'Request failed', response.status);
  return value as T;
}
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(v => v + 1), []);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    api<T>(path, { signal: controller.signal }).then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, version]);
  return { data, error, loading, reload };
}
export const query = (values: Record<string, string>) => new URLSearchParams(values).toString();
