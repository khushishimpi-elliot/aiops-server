import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { DevSummaryItem, DevDetailResponse } from '../types'
import { formatCost, formatTokens, formatDate } from '../utils'

const DEV_COLORS = ['#FF6600','#6366f1','#f59e0b','#10b981','#3b82f6','#ec4899']

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

function calcReadiness(data: DevDetailResponse): { score: number; breakdown: Record<string, number> } {
  const now = Date.now()
  const breakdown: Record<string, number> = {}

  const recentUsed = data.daily.some(d => {
    return (now - new Date(d.date).getTime()) / 86400000 <= 7 && d.cost_millicents > 0
  })
  breakdown.Engagement = recentUsed ? 10 : 0

  const activeDays = data.daily.filter(d => d.cost_millicents > 0).length
  breakdown.Depth = activeDays >= 5 ? 10 : Math.round(activeDays / 5 * 10)

  const tools = new Set(data.by_tool_model.map(r => r.tool))
  breakdown.Coverage = tools.size >= 2 ? 10 : Math.round(tools.size / 2 * 10)

  breakdown.Progression = data.total_cost_millicents >= 100_000 ? 10
    : Math.round(data.total_cost_millicents / 100_000 * 10)

  const models = new Set(data.by_tool_model.map(r => r.model))
  breakdown.Friction = models.size >= 2 ? 10 : Math.round(models.size / 2 * 10)

  const score = Math.min(50 + Object.values(breakdown).reduce((s, v) => s + v, 0), 100)
  return { score, breakdown }
}

const WEEKLY_BUDGET_MC  = 15_000 * 100
const MONTHLY_BUDGET_MC = 50_000 * 100

function DevDrawer({
  email,
  colorIdx,
  days,
  onClose,
}: {
  email: string
  colorIdx: number
  days: number
  onClose: () => void
}) {
  const [data, setData] = useState<DevDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setData(null)
    api.developer(email, days)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [email, days])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const color  = DEV_COLORS[colorIdx % DEV_COLORS.length]
  const name   = nameFromEmail(email)
  const letter = avatarLetter(email)

  // ── Derived data ──────────────────────────────────────────────────────────

  const totalSessions = data
    ? data.by_tool_model.reduce((s, r) => s + (r.session_count ?? r.days_active), 0)
    : 0

  const toolTotals = data ? (() => {
    const map = new Map<string, { cost: number; tokens: number; sessions: number }>()
    for (const row of data.by_tool_model) {
      const e = map.get(row.tool) ?? { cost: 0, tokens: 0, sessions: 0 }
      e.cost    += row.cost_millicents
      e.tokens  += row.input_tokens + row.output_tokens
      e.sessions += row.session_count ?? row.days_active
      map.set(row.tool, e)
    }
    return [...map.entries()]
      .sort((a, b) => b[1].sessions - a[1].sessions)
      .map(([tool, v]) => ({ tool, ...v }))
  })() : []

  const maxToolSessions = Math.max(...toolTotals.map(t => t.sessions), 1)

  const modelTotals = data ? (() => {
    const map = new Map<string, { cost: number; tokens: number; sessions: number }>()
    for (const row of data.by_tool_model) {
      const e = map.get(row.model) ?? { cost: 0, tokens: 0, sessions: 0 }
      e.cost    += row.cost_millicents
      e.tokens  += row.input_tokens + row.output_tokens
      e.sessions += row.session_count ?? row.days_active
      map.set(row.model, e)
    }
    const entries = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost)
    const maxCost = Math.max(...entries.map(([, v]) => v.cost), 1)
    return entries.map(([model, v]) => ({ model, ...v, pct: Math.round(v.cost / maxCost * 100) }))
  })() : []

  const now = Date.now()

  const periodBreakdown = data ? (() => {
    return [
      { label: 'Today',  d: 1 },
      { label: 'Week',   d: 7 },
      { label: 'Month',  d: 30 },
      { label: `${days}d`, d: days },
    ].map(({ label, d }) => {
      const rows = data.daily.filter(r =>
        (now - new Date(r.date).getTime()) / 86400000 <= d && r.cost_millicents > 0
      )
      return {
        label,
        sessions: rows.length,
        tokens:   rows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0),
        cost:     rows.reduce((s, r) => s + r.cost_millicents, 0),
      }
    })
  })() : []

  const weekCost = data
    ? data.daily.filter(d => (now - new Date(d.date).getTime()) / 86400000 <= 7)
        .reduce((s, d) => s + d.cost_millicents, 0)
    : 0
  const monthCost = data
    ? data.daily.filter(d => (now - new Date(d.date).getTime()) / 86400000 <= 30)
        .reduce((s, d) => s + d.cost_millicents, 0)
    : 0
  const weekPct  = WEEKLY_BUDGET_MC  > 0 ? Math.min(Math.round(weekCost  / WEEKLY_BUDGET_MC  * 100), 999) : 0
  const monthPct = MONTHLY_BUDGET_MC > 0 ? Math.min(Math.round(monthCost / MONTHLY_BUDGET_MC * 100), 999) : 0

  const readiness = data ? calcReadiness(data) : null
  const maxDailyCost = data ? Math.max(...data.daily.map(d => d.cost_millicents), 1) : 1
  const activeDays = data ? data.daily.filter(d => d.cost_millicents > 0) : []

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
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
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
                  <span className="drawer-info-key">Email</span>
                  <span className="drawer-info-val">{data.email}</span>
                  <span className="drawer-info-key">Enrolled</span>
                  <span className="drawer-info-val">{formatDate(data.enrolled_at)}</span>
                  <span className="drawer-info-key">Active Days</span>
                  <span className="drawer-info-val">{activeDays.length}</span>
                  <span className="drawer-info-key">Status</span>
                  <span className="drawer-info-val">{activeDays.length > 0 ? 'Active' : 'Inactive'}</span>
                </div>
              </div>

              {/* Tools Detected */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Tools Detected</div>
                {toolTotals.length === 0 ? (
                  <p className="no-data">No tool data yet</p>
                ) : toolTotals.map(t => (
                  <div className="drawer-bar-row" key={t.tool}>
                    <span className="drawer-bar-label">{t.tool}</span>
                    <div className="drawer-bar-track">
                      <div className="drawer-bar-fill" style={{ width: `${Math.round(t.sessions / maxToolSessions * 100)}%` }} />
                    </div>
                    <span className="drawer-bar-val">{t.sessions} sessions · {formatCost(t.cost)}</span>
                  </div>
                ))}
              </div>

              {/* Usage By Period */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Usage By Period</div>
                <table className="drawer-table">
                  <thead>
                    <tr><th>Period</th><th>Sessions</th><th>Tokens</th><th>Cost</th></tr>
                  </thead>
                  <tbody>
                    {periodBreakdown.map(p => (
                      <tr key={p.label}>
                        <td>{p.label}</td>
                        <td>{p.sessions}</td>
                        <td>{formatTokens(p.tokens)}</td>
                        <td style={{ fontWeight: 600, color: 'var(--brand)' }}>{formatCost(p.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Daily Breakdown */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Daily Breakdown</div>
                {activeDays.length === 0 ? (
                  <p className="no-data">No daily data</p>
                ) : (
                  <table className="drawer-table">
                    <thead>
                      <tr><th>Date</th><th>Input</th><th>Output</th><th>Cost</th></tr>
                    </thead>
                    <tbody>
                      {[...data.daily]
                        .sort((a, b) => b.date.localeCompare(a.date))
                        .filter(d => d.cost_millicents > 0)
                        .slice(0, 14)
                        .map(d => (
                          <tr key={d.date}>
                            <td>{d.date}</td>
                            <td>{formatTokens(d.input_tokens)}</td>
                            <td>{formatTokens(d.output_tokens)}</td>
                            <td style={{ fontWeight: 600, color: 'var(--brand)' }}>{formatCost(d.cost_millicents)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Daily Cost Trend */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Daily Cost Trend</div>
                {activeDays.length === 0 ? (
                  <p className="no-data">No data</p>
                ) : (
                  [...data.daily]
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .filter(d => d.cost_millicents > 0)
                    .slice(0, 10)
                    .map(d => (
                      <div className="drawer-bar-row" key={d.date}>
                        <span className="drawer-bar-label">{d.date.slice(5)}</span>
                        <div className="drawer-bar-track">
                          <div className="drawer-bar-fill" style={{ width: `${Math.round(d.cost_millicents / maxDailyCost * 100)}%` }} />
                        </div>
                        <span className="drawer-bar-val">{formatCost(d.cost_millicents)}</span>
                      </div>
                    ))
                )}
              </div>

              {/* Tokens */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Tokens</div>
                <div className="drawer-info-grid">
                  <span className="drawer-info-key">Input</span>
                  <span className="drawer-info-val">
                    {data.total_input_tokens.toLocaleString()}
                    <span style={{ fontSize: 10, color: 'var(--gray-400)', fontFamily: 'sans-serif', marginLeft: 4 }}>tokens sent</span>
                  </span>
                  <span className="drawer-info-key">Output</span>
                  <span className="drawer-info-val">
                    {data.total_output_tokens.toLocaleString()}
                    <span style={{ fontSize: 10, color: 'var(--gray-400)', fontFamily: 'sans-serif', marginLeft: 4 }}>tokens received</span>
                  </span>
                  <span className="drawer-info-key">Total</span>
                  <span className="drawer-info-val">
                    {(data.total_input_tokens + data.total_output_tokens).toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Models Used */}
              <div className="drawer-section">
                <div className="drawer-section-title"><span className="dsicon">◆</span> Models Used</div>
                {modelTotals.length === 0 ? (
                  <p className="no-data">No model data yet</p>
                ) : modelTotals.map(m => (
                  <div className="drawer-bar-row" key={m.model}>
                    <span className="drawer-bar-label wide">{m.model}</span>
                    <div className="drawer-bar-track">
                      <div className="drawer-bar-fill" style={{ width: `${m.pct}%` }} />
                    </div>
                    <span className="drawer-bar-val">{m.sessions} sessions · {formatCost(m.cost)}</span>
                  </div>
                ))}
              </div>

              {/* Readiness Score */}
              {readiness && (
                <div className="drawer-section">
                  <div className="drawer-section-title"><span className="dsicon">◆</span> Readiness Score</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                    <div style={{
                      fontSize: 44, fontWeight: 800, lineHeight: 1,
                      color: readiness.score >= 70 ? 'var(--brand)' : readiness.score >= 40 ? '#f59e0b' : '#ef4444',
                    }}>
                      {readiness.score}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: 'var(--gray-500)', marginBottom: 6 }}>out of 100</div>
                      <div style={{ height: 8, background: 'var(--gray-100)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${readiness.score}%`,
                          background: readiness.score >= 70 ? 'var(--brand)' : readiness.score >= 40 ? '#f59e0b' : '#ef4444',
                          borderRadius: 4,
                          transition: 'width 0.6s ease',
                        }} />
                      </div>
                    </div>
                  </div>
                  {Object.entries(readiness.breakdown).map(([key, val]) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span style={{ width: 90, fontSize: 12, color: 'var(--gray-600)', flexShrink: 0 }}>{key}</span>
                      <div style={{ flex: 1, height: 4, background: 'var(--gray-100)', borderRadius: 2 }}>
                        <div style={{ height: '100%', width: `${val * 10}%`, background: 'var(--brand)', borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--gray-500)', width: 34, textAlign: 'right' }}>{val}/10</span>
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
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-700)' }}>{b.label}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--gray-600)' }}>
                          {formatCost(b.cost)} / {formatCost(b.budget)}
                        </span>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
                          background: b.pct > 100 ? '#fee2e2' : '#f0fdf4',
                          color: b.pct > 100 ? '#dc2626' : '#16a34a',
                        }}>
                          {b.pct}%
                        </span>
                      </div>
                    </div>
                    <div style={{ height: 6, background: 'var(--gray-100)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${Math.min(b.pct, 100)}%`,
                        background: b.pct > 100 ? '#ef4444' : 'var(--brand)',
                        borderRadius: 3,
                        transition: 'width 0.5s ease',
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
  const [days, setDays] = useState(30)
  const [developers, setDevelopers] = useState<DevSummaryItem[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [drawerEmail, setDrawerEmail] = useState<string | null>(null)
  const [drawerColorIdx, setDrawerColorIdx] = useState(0)
  const [lastUpdated, setLastUpdated] = useState('')

  function fetchDevelopers() {
    setDevelopers(null)
    setError('')
    api.developers(days)
      .then(r => {
        setDevelopers(r.developers)
        setLastUpdated(new Date().toLocaleTimeString())
      })
      .catch(e => setError(e.message))
  }

  useEffect(() => {
    fetchDevelopers()
  }, [days])

  useEffect(() => {
    const id = setInterval(() => { fetchDevelopers() }, 5 * 60 * 1000)
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
        <select
          className="period-select"
          value={days}
          onChange={e => setDays(Number(e.target.value))}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
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
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              className="search-input"
              type="text"
              placeholder="Search developers…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="dev-table-card">
          <div className="dev-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Developer</th>
                  <th>Cost</th>
                  <th>Input Tokens</th>
                  <th>Output Tokens</th>
                  <th>Status</th>
                  <th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {!developers && !error && (
                  <tr><td colSpan={6} className="empty-cell">Loading…</td></tr>
                )}
                {developers && filtered.length === 0 && (
                  <tr><td colSpan={6} className="empty-cell">No developers found</td></tr>
                )}
                {filtered.map((dev, i) => {
                  const active = isActive(dev.last_active)
                  const colorIdx = i % DEV_COLORS.length
                  return (
                    <tr
                      key={dev.user_id}
                      className="clickable-row"
                      onClick={() => { setDrawerEmail(dev.email); setDrawerColorIdx(colorIdx) }}
                    >
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
                          <span className="badge-dot" />
                          {active ? 'Active' : 'Inactive'}
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
        <DevDrawer
          email={drawerEmail}
          colorIdx={drawerColorIdx}
          days={days}
          onClose={closeDrawer}
        />
      )}
    </>
  )
}
