import { auth } from './firebase';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export async function api(path, options = {}) {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(body.error || `Request failed (${response.status})`);
  return body;
}

export const money = (value, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(value || 0));
