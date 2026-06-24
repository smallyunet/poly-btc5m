const apiKey = import.meta.env.VITE_DASHBOARD_INTERNAL_API_KEY || '';

export const DASHBOARD_REFRESH_MS = 5_000;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-dashboard-internal-key': apiKey } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
