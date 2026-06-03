import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { DevSummaryItem, DevDetailResponse } from '../types'
import { formatCost, formatTokens, formatDate } from '../utils'

const DEV_COLORS = ['#FF6600','#6366f1','#f59e0b','#10b981','#3b82f6','#ec4899']
const CAT_COLORS = ['#FF6600','#3b82f6','#22c55e','#f59e0b','#8b5cf6','#6b7280']

const ALL_TOOLS = [
  'claude_code','copilot','cursor','gemini','windsurf','cline',
  'roo','kilo','codex','pi',
]

const TOOL_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  claude_code: { bg: '#fff3ec', color: '#FF6600',  label: 'Claude Code' },
  copilot:     { bg: '#f1f5f9', color: '#374151',  label: 'Copilot' },
  cursor:      { bg: '#eef2ff', color: '#6366f1',  label: 'Cursor' },
  gemini:      { bg: '#eff6ff', color: '#3b82f6',  label: 'Gemini' },
  windsurf:    { bg: '#f0fdf4', color: '#16a34a',  label: 'Windsurf' },
  cline:       { bg: '#f0fdfa', color: '#0d9488',  label: 'Cline' },
  roo:         { bg: '#fdf4ff', color: '#9333ea',  label: 'Roo Code' },
  kilo:        { bg: '#fff7ed', color: '#c2410c',  label: 'Kilo Code' },
  codex:       { bg: '#f0fdf4', color: '#15803d',  label: 'Codex' },
  pi:          { bg: '#f8fafc', color: '#475569',  label: 'Pi' },
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0]
  return local.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
}

function avatarLetter(email: string): string {
  return email.charAt(0).toUpperCase()
}

function isActive(lastActive: string | null): boolean {
  if (!lastActive) return false
  return Date.now() - new Date(lastActive).getTime() < 7 * 24 * 60 * 60 * 1000
}

function ToolBadge({ tool }: { tool: string }) {
  const b = TOOL_BADGE[tool] ?? { bg: '#f1f5f9', color: '#374151', label: tool }
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
      background: b.bg, color: b.color, whiteSpace: 'nowrap',
    }}>
      {b.label}
    </span>
  )
}

function calcReadiness(data: DevDetailResponse, days: number) {
  const activeDays = data.daily.filter(d => d.cost_millicents > 0).length
  const tools = new Set(data.by_tool_model.map(r => r.tool)).size
  const totalSessions = data.by_tool_model.reduce((s, r) => s + (r.session_count ?? r.days_active), 0)
  const totalTokens = data.total_input_tokens + data.total_output_tokens
  const avgTurns = totalSessions > 0 ? Math.round(totalTokens / 1000 / totalSessions) : 0

  const engagement  = Math.min(Math.round(activeDays / Math.max(days, 1) * 25), 25)
  const depth       = Math.min(Math.round(Math.min(avgTurns / 100, 1) * 25), 25)
  const coverage    = Math.min(tools * 5, 20)
  const progression = Math.min(Math.round(Math.min(data.total_cost_millicents / 1_000_000, 1) * 15), 15)
  const friction    = Math.min(Math.round(activeDays / Math.max(days, 1) * 15), 15)
  const score       = Math.min(engagement + depth + coverage + progression + friction, 100)

  return {
    score,
    subs: [
      { label: 'Engagement',  val: engagement,  max: 25, detail: `${activeDays} active days` },
      { label: 'Depth',       val: depth,       max: 25, detail: `avg ${avgTurns}K tokens/session` },
      { label: 'Coverage',    val: coverage,    max: 20, detail: `${tools} tools detected` },
      { label: 'Progression', val: progression, max: 15, detail: data.total_cost_millicents > 1_000_000 ? 'power user' : 'growing' },
      { label: 'Friction',    val: friction,    max: 15, detail: `${Math.round(activeDays / Math.max(days, 1) * 100)}% utilization` },
    ],
  }
}

const WEEKLY_BUDGET_MC  = 15_000 * 100
const MONTHLY_BUDGET_MC = 50_000 * 100

function DevDrawer({ email, colorIdx, days, onClose }: {
  email: string; colorIdx: number; days: number; onClose: () => void
}) {
  const [data, setData] = useState<DevDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true); setData(null)
    api.developer(email, days).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [email, days])

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  const color  = DEV_COLORS[colorIdx % DEV_COLORS.length]
  const name   = nameFromEmail(email)
  const letter = avatarLetter(email)

  // ── derived ──────────────────────────────────────────────────────────────
  const totalSessions = data
    ? data.by_tool_model.reduce((s, r) => s + (r.session_count ?? r.days_active), 0)
    : 0

  // Tool totals — include ALL known tools (0 for absent ones)
  const toolMap = new Map<string, { cost: number; sessions: number }>()
  if (data) {
    for (const row of data.by_tool_model) {
      const e = toolMap.get(row.tool) ?? { cost: 0, sessions: 0 }
      e.cost    += row.cost_millicents
      e.sessions += row.session_count ?? row.days_active
      toolMap.set(row.tool, e)
    }
  }
  const toolList = [
    ...ALL_TOOLS.filter(t => toolMap.has(t)).map(t => ({ tool: t, ...toolMap.get(t)! })),
    ...ALL_TOOLS.filter(t => !toolMap.has(t)).map(t => ({ tool: t, cost: 0, sessions: 0 })),
  ]
  const maxToolSessions = Math.max(...toolList.map(t => t.sessions), 1)

  // Model totals
  const modelTotals = data ? (() => {
    const map = new Map<string, { cost: number; sessions: number }>()
    for (const row of data.by_tool_model) {
      const e = map.get(row.model) ?? { cost: 0, sessions: 0 }
      e.cost    += row.cost_millicents
      e.sessions += row.session_count ?? row.days_active
      map.set(row.model, e)
    }
    const entries = [...map.entries()].sort((a, b) => b[1].sessions - a[1].sessions)
    const maxS = Math.max(...entries.map(([, v]) => v.sessions), 1)
    return entries.map(([model, v]) => ({ model, ...v, pct: Math.round(v.sessions / maxS * 100) }))
  })() : []

  const now = Date.now()

  // Period breakdown
  const periods = data ? [
    { label: 'Today', d: 1 },
    { label: 'Week',  d: 7 },
    { label: 'Month', d: 30 },
    { label: 'Year',  d: 365 },
  ].map(({ label, d }) => {
    const rows = data.daily.filter(r =>
      (now - new Date(r.date).getTime()) / 86400000 <= d && r.cost_millicents > 0
    )
    return {
      label,
      sessions: rows.length,
      tokens: rows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0),
      cost:    rows.reduce((s, r) => s + r.cost_millicents, 0),
    }
  }) : []

  // Budget
  const weekCost  = data ? data.daily.filter(d => (now - new Date(d.date).getTime()) / 86400000 <= 7)
    .reduce((s, d) => s + d.cost_millicents, 0) : 0
  const monthCost = data ? data.daily.filter(d => (now - new Date(d.date).getTime()) / 86400000 <= 30)
    .reduce((s, d) => s + d.cost_millicents, 0) : 0
  const weekPct  = Math.min(Math.round(weekCost  / WEEKLY_BUDGET_MC  * 100), 999)
  const monthPct = Math.min(Math.round(monthCost / MONTHLY_BUDGET_MC * 100), 999)

  const readiness = data ? calcReadiness(data, days) : null
  const activeDayRows = data ? data.daily.filter(d => d.cost_millicents > 0) : []

  const lastSync = data?.last_seen_at
    ? new Date(data.last_seen_at).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : activeDayRows.length > 0
      ? activeDayRows.sort((a, b) => b.date.localeCompare(a.date))[0].date
      : '—'

  return (
    <>
      <div className="drawer-overlay open" onClick={onClose} />
      <div className="drawer open">

        {/* Header */}
        <div className="drawer-header">
          <div className="drawer-header-left">
            <div className="drawer-avatar" style={{ background: color }}>{letter}</div>
            <div>
              <div className="drawer-dev-name">{name}</div>
              <div className="drawer-dev-email">{email}</div>
            </div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="drawer-body">
          {loading && <p className="page-loading">Loading…</p>}
          {data && (
            <>
              {/* Summary stats */}
              <div className="drawer-stats">
                <div className="drawer-stat">
                  <div className="drawer-stat-label">Total Cost</div>
                  <div className="drawer-stat-value">{formatCost(data.total_cost_millicents)}</div>
                </div>
                <div className="drawer-stat">
                  <div className="drawer-stat-label">Sessions</div>
                  <div className="drawer-stat-value">{totalSessions}</div>
                </div>
                <div className="drawer-stat">
                  <div className="drawer-stat-label">Total Tokens</div>
                  <div className="drawer-stat-value">{formatTokens(data.total_input_tokens + data.total_output_tokens)}</div>
                </div>
              </div>

              {/* Machine Info */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Machine Info</div>
                <div className="drawer-info-grid">
                  <span className="drawer-info-key">Name</span>
                  <span className="drawer-info-val">{name}</span>
                  <span className="drawer-info-key">Email</span>
                  <span className="drawer-info-val">{data.email}</span>
                  {data.machine_label && <>
                    <span className="drawer-info-key">Machine</span>
                    <span className="drawer-info-val">{data.machine_label}</span>
                  </>}
                  {data.team_name && <>
                    <span className="drawer-info-key">Team</span>
                    <span className="drawer-info-val">{data.team_name}</span>
                  </>}
                  <span className="drawer-info-key">Enrolled</span>
                  <span className="drawer-info-val">{formatDate(data.enrolled_at)}</span>
                  <span className="drawer-info-key">Last Sync</span>
                  <span className="drawer-info-val">{lastSync}</span>
                  <span className="drawer-info-key">Status</span>
                  <span className="drawer-info-val">{activeDayRows.length > 0 ? 'Active' : 'Inactive'}</span>
                </div>
              </div>

              {/* Tools Detected */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Tools Detected</div>
                {toolList.filter(t => t.sessions > 0).map(t => (
                  <div className="drawer-bar-row" key={t.tool}>
                    <span className="drawer-bar-label">{TOOL_BADGE[t.tool]?.label ?? t.tool}</span>
                    <div className="drawer-bar-track">
                      <div className="drawer-bar-fill" style={{ width: `${Math.round(t.sessions / maxToolSessions * 100)}%` }} />
                    </div>
                    <span className="drawer-bar-val">
                      {t.sessions > 0 ? `${t.sessions} sessions${t.cost > 0 ? ' · ' + formatCost(t.cost) : ''}` : '0 sessions'}
                    </span>
                  </div>
                ))}
              </div>

              {/* Tasks AI Used For */}
              {data.task_categories.length > 0 && (
                <div className="drawer-section">
                  <div className="drawer-section-title"><span className="dsicon">◆</span> Tasks AI Used For</div>
                  {data.task_categories.map((c, i) => (
                    <div key={c.category} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: CAT_COLORS[i % CAT_COLORS.length], flexShrink: 0 }} />
                          <span style={{ fontSize: 12, color: 'var(--gray-700)' }}>{c.category}</span>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-600)' }}>{c.pct}%</span>
                      </div>
                      <div style={{ height: 4, background: 'var(--gray-100)', borderRadius: 2 }}>
                        <div style={{ height: '100%', width: `${c.pct}%`, background: CAT_COLORS[i % CAT_COLORS.length], borderRadius: 2 }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Daily Breakdown */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Daily Breakdown</div>
                {data.daily_by_tool.length === 0 ? (
                  <p className="no-data">No data</p>
                ) : (
                  <table className="drawer-table">
                    <thead>
                      <tr><th>Date</th><th>Tool</th><th>Model</th><th>Sessions</th><th>Tokens</th></tr>
                    </thead>
                    <tbody>
                      {data.daily_by_tool.slice(0, 15).map((r, i) => (
                        <tr key={i}>
                          <td style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                          <td><ToolBadge tool={r.tool} /></td>
                          <td><span className="model-pill">{r.model.replace('claude-','').replace('-20251001','')}</span></td>
                          <td>{r.session_count}</td>
                          <td>{formatTokens(r.input_tokens + r.output_tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Usage By Period */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Usage By Period</div>
                <table className="drawer-table">
                  <thead>
                    <tr><th>Period</th><th>Sessions</th><th>Tokens</th><th>Cost</th></tr>
                  </thead>
                  <tbody>
                    {periods.map(p => (
                      <tr key={p.label}>
                        <td style={{ fontWeight: 600 }}>{p.label}</td>
                        <td>{p.sessions}</td>
                        <td>{formatTokens(p.tokens)}</td>
                        <td style={{ fontWeight: 600, color: 'var(--brand)' }}>{formatCost(p.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Tokens */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Tokens</div>
                <div className="drawer-info-grid">
                  <span className="drawer-info-key">Input</span>
                  <span className="drawer-info-val">
                    {data.total_input_tokens.toLocaleString()}
                    <span style={{ fontSize: 10, color: 'var(--gray-400)', fontFamily: 'sans-serif', marginLeft: 4 }}>tokens sent to AI</span>
                  </span>
                  <span className="drawer-info-key">Output</span>
                  <span className="drawer-info-val">
                    {data.total_output_tokens.toLocaleString()}
                    <span style={{ fontSize: 10, color: 'var(--gray-400)', fontFamily: 'sans-serif', marginLeft: 4 }}>tokens received</span>
                  </span>
                  {data.total_cache_read_tokens > 0 && <>
                    <span className="drawer-info-key">Cache</span>
                    <span className="drawer-info-val">
                      {data.total_cache_read_tokens.toLocaleString()}
                      <span style={{ fontSize: 10, color: '#16a34a', fontFamily: 'sans-serif', marginLeft: 4 }}>reused (saves money)</span>
                    </span>
                  </>}
                  <span className="drawer-info-key">Total</span>
                  <span className="drawer-info-val">
                    {(data.total_input_tokens + data.total_output_tokens + data.total_cache_read_tokens).toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Daily Cost Trend — vertical bar chart */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Daily Cost Trend</div>
                {activeDayRows.length === 0 ? <p className="no-data">No data</p> : (() => {
                  const bars = [...data.daily]
                    .filter(d => d.cost_millicents > 0)
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .slice(-10);
                  const maxCost = Math.max(...bars.map(d => d.cost_millicents), 1);
                  const CHART_H = 120;
                  return (
                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 8, height: CHART_H + 36, padding: '0 4px' }}>
                      {bars.map(d => {
                        const barH = Math.max(4, Math.round((d.cost_millicents / maxCost) * CHART_H));
                        return (
                          <div key={d.date} style={{ width: 20, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, height: '100%', justifyContent: 'flex-end' }}>
                            <span style={{ fontSize: 8, color: 'var(--gray-400)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {formatCost(d.cost_millicents)}
                            </span>
                            <div style={{ width: 14, height: barH, background: 'var(--brand)', borderRadius: '3px 3px 0 0' }} />
                            <span style={{ fontSize: 8, color: 'var(--gray-500)', whiteSpace: 'nowrap' }}>
                              {d.date.slice(5)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Models Used */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Models Used</div>
                {modelTotals.length === 0 ? <p className="no-data">No model data yet</p> : (
                  modelTotals.map(m => (
                    <div className="drawer-bar-row" key={m.model}>
                      <span className="drawer-bar-label wide">{m.model}</span>
                      <div className="drawer-bar-track">
                        <div className="drawer-bar-fill" style={{ width: `${m.pct}%` }} />
                      </div>
                      <span className="drawer-bar-val">
                        {m.sessions} sessions{m.cost > 0 ? ' · ' + formatCost(m.cost) : ' · —'}
                      </span>
                    </div>
                  ))
                )}
              </div>

              {/* Readiness Score */}
              {readiness && (
                <div className="drawer-section">
                  <div className="drawer-section-title"><span className="dsicon">◆</span> Readiness Score</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                    <div style={{
                      fontSize: 48, fontWeight: 800, lineHeight: 1,
                      color: readiness.score >= 70 ? 'var(--brand)' : readiness.score >= 40 ? '#f59e0b' : '#ef4444',
                    }}>
                      {readiness.score}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: 6 }}>/ 100</div>
                      <div style={{ height: 8, background: 'var(--gray-100)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', width: `${readiness.score}%`, borderRadius: 4, transition: 'width 0.6s ease',
                          background: readiness.score >= 70 ? 'var(--brand)' : readiness.score >= 40 ? '#f59e0b' : '#ef4444',
                        }} />
                      </div>
                    </div>
                  </div>
                  {readiness.subs.map(s => (
                    <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span style={{ width: 90, fontSize: 12, color: 'var(--gray-600)', flexShrink: 0 }}>{s.label}</span>
                      <div style={{ flex: 1, height: 4, background: 'var(--gray-100)', borderRadius: 2 }}>
                        <div style={{ height: '100%', width: `${Math.round(s.val / s.max * 100)}%`, background: 'var(--brand)', borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--gray-500)', minWidth: 80, textAlign: 'right' }}>
                        {s.val}/{s.max} · {s.detail}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Budget */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Budget</div>
                {[
                  { label: 'Weekly',  cost: weekCost,  budget: WEEKLY_BUDGET_MC,  pct: weekPct  },
                  { label: 'Monthly', cost: monthCost, budget: MONTHLY_BUDGET_MC, pct: monthPct },
                ].map(b => (
                  <div key={b.label} style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-700)' }}>{b.label}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--gray-600)' }}>
                          {formatCost(b.cost)} / {formatCost(b.budget)}
                        </span>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                          background: b.pct > 100 ? '#fee2e2' : '#f0fdf4',
                          color: b.pct > 100 ? '#dc2626' : '#16a34a',
                        }}>
                          {b.pct}%{b.pct > 100 ? ' ↑' : ''}
                        </span>
                      </div>
                    </div>
                    <div style={{ height: 6, background: 'var(--gray-100)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', width: `${Math.min(b.pct, 100)}%`, borderRadius: 3, transition: 'width 0.5s ease',
                        background: b.pct > 100 ? '#ef4444' : 'var(--brand)',
                      }} />
                    </div>
                  </div>
                ))}
              </div>

            </>
          )}
        </div>
      </div>
    </>
  )
}

export default function DeveloperList() {
  const [days, setDays] = useState(90)
  const [developers, setDevelopers] = useState<DevSummaryItem[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [drawerEmail, setDrawerEmail] = useState<string | null>(null)
  const [drawerColorIdx, setDrawerColorIdx] = useState(0)
  const [lastUpdated, setLastUpdated] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  function fetchDevelopers(clear = false) {
    if (clear) setDevelopers(null)
    setError('')
    setRefreshing(true)
    api.developers(days)
      .then(r => { setDevelopers(r.developers); setLastUpdated(new Date().toLocaleTimeString()) })
      .catch(e => setError(e.message))
      .finally(() => setRefreshing(false))
  }

  useEffect(() => { fetchDevelopers(true) }, [days])
  useEffect(() => {
    const id = setInterval(() => { fetchDevelopers() }, 30 * 1000)
    return () => clearInterval(id)
  }, [])

  const closeDrawer = useCallback(() => setDrawerEmail(null), [])
  const filtered = developers?.filter(dev =>
    dev.email.toLowerCase().includes(search.toLowerCase()) ||
    nameFromEmail(dev.email).toLowerCase().includes(search.toLowerCase())
  ) ?? []

  return (
    <>
      <div className="topbar">
        <div>
          <div className="topbar-kicker">Elliot Systems</div>
          <div className="topbar-title">
            Developers
            {lastUpdated && (
              <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: '12px' }}>
                Last updated {lastUpdated}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => fetchDevelopers()}
            disabled={refreshing}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 8, border: '1px solid var(--gray-200)',
              background: 'white', color: 'var(--gray-600)', fontSize: 13, fontWeight: 500,
              cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.6 : 1,
            }}
          >
            <svg
              width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: refreshing ? 'spin 0.8s linear infinite' : 'none' }}
            >
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8"/>
              <polyline points="21 3 21 8 16 8"/>
            </svg>
            Refresh
          </button>
          <select className="period-select" value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
            <option value={365}>Last 1 year</option>
          </select>
        </div>
      </div>

      <div className="content-area">
        {error && <div className="page-error">{error}</div>}
        <div className="dev-page-header">
          <div>
            <div className="dev-page-title">All Developers</div>
            <div className="dev-page-subtitle">
              {developers ? `${developers.length} enrolled developers` : 'Loading…'}
            </div>
          </div>
          <div className="search-wrap">
            <svg className="search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input className="search-input" type="text" placeholder="Search developers…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="dev-table-card">
          <div className="dev-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Developer</th><th>Cost</th><th>Input Tokens</th>
                  <th>Output Tokens</th><th>Status</th><th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {!developers && !error && <tr><td colSpan={6} className="empty-cell">Loading…</td></tr>}
                {developers && filtered.length === 0 && <tr><td colSpan={6} className="empty-cell">No developers found</td></tr>}
                {filtered.map((dev, i) => {
                  const active = isActive(dev.last_active)
                  const colorIdx = i % DEV_COLORS.length
                  return (
                    <tr key={dev.user_id} className="clickable-row"
                      onClick={() => { setDrawerEmail(dev.email); setDrawerColorIdx(colorIdx) }}>
                      <td>
                        <div className="dev-cell">
                          <div className="dev-sq-avatar" style={{ background: DEV_COLORS[colorIdx] }}>
                            {avatarLetter(dev.email)}
                          </div>
                          <div>
                            <div className="dev-cell-name">{nameFromEmail(dev.email)}</div>
                            <div className="dev-cell-email">{dev.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="cost-cell">{formatCost(dev.total_cost_millicents)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTokens(dev.total_input_tokens)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTokens(dev.total_output_tokens)}</td>
                      <td>
                        <span className={`badge ${active ? 'badge-active' : 'badge-inactive'}`}>
                          <span className="badge-dot" />{active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={{ color: 'var(--gray-500)', fontSize: 12 }}>
                        {dev.last_active ? new Date(dev.last_active).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {drawerEmail && (
        <DevDrawer email={drawerEmail} colorIdx={drawerColorIdx} days={days} onClose={closeDrawer} />
      )}
    </>
  )
}
