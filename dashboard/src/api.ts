import type { OrgOverviewResponse, DevSummaryResponse, DevDetailResponse } from './types'

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(path, { credentials: 'include', ...options })
  if (resp.status === 401) throw new Error('UNAUTHORIZED')
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `HTTP ${resp.status}`)
  }
  return resp.json() as Promise<T>
}

export const api = {
  me: () =>
    req<{ email: string }>('/admin/me'),

  login: (password: string) =>
    req<{ ok: boolean; email: string }>('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    req<{ ok: boolean }>('/admin/logout', { method: 'POST' }),

  org: (days = 30) =>
    req<OrgOverviewResponse>(`/api/org?days=${days}`),

  developers: (days = 30) =>
    req<DevSummaryResponse>(`/api/developers?days=${days}`),

  developer: (email: string, days = 30) =>
    req<DevDetailResponse>(`/api/developer/${encodeURIComponent(email)}?days=${days}`),
}
