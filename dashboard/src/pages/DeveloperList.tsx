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
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const color = DEV_COLORS[colorIdx % DEV_COLORS.length]
  const name = nameFromEmail(email)
  const letter = avatarLetter(email)

  const maxCost = data ? Math.max(...data.daily.map(d => d.cost_millicents), 1) : 1

  // Group tools from by_tool_model
  const toolTotals = data ? (() => {
    const map = new Map<string, number>()
    for (const row of data.by_tool_model) {
      map.set(row.tool, (map.get(row.tool) ?? 0) + row.input_tokens + row.output_tokens)
    }
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1
    return entries.map(([tool, tokens]) => ({ tool, tokens, pct: Math.round(tokens / total * 100) }))
  })() : []

  const maxToolTokens = toolTotals[0]?.tokens ?? 1

  // Group models
  const modelTotals = data ? (() => {
    const map = new Map<string, { cost: number; tokens: number }>()
    for (const row of data.by_tool_model) {
      const existing = map.get(row.model) ?? { cost: 0, tokens: 0 }
      existing.cost   += row.cost_millicents
      existing.tokens += row.input_tokens + row.output_tokens
      map.set(row.model, existing)
    }
    const entries = [...map.entries()].sort((a, b) => b[1].cost - a[1].cost)
    const maxTokens = Math.max(...entries.map(([, v]) => v.tokens), 1)
    return entries.map(([model, v]) => ({ model, cost: v.cost, tokens: v.tokens, pct: Math.round(v.tokens / maxTokens * 100) }))
  })() : []

  return (
    <>
      <div className="drawer-overlay open" onClick={onClose} />
      <div className="drawer open">
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
                  <div className="drawer-stat-label">Active Days</div>
                  <div className="drawer-stat-value">{data.daily.filter(d => d.cost_millicents > 0).length}</div>
                </div>
                <div className="drawer-stat">
                  <div className="drawer-stat-label">Total Tokens</div>
                  <div className="drawer-stat-value">{formatTokens(data.total_input_tokens + data.total_output_tokens)}</div>
                </div>
              </div>

              {/* Machine Info */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  <span className="dsicon">◆</span> Machine Info
                </div>
                <div className="drawer-info-grid">
                  <span className="drawer-info-key">Email</span>
                  <span className="drawer-info-val">{data.email}</span>
                  <span className="drawer-info-key">Enrolled</span>
                  <span className="drawer-info-val">{formatDate(data.enrolled_at)}</span>
                  <span className="drawer-info-key">Status</span>
                  <span className="drawer-info-val">{data.daily.length > 0 ? 'Active' : 'Inactive'}</span>
                </div>
              </div>

              {/* Tools Detected */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  <span className="dsicon">◆</span> Tools Detected
                </div>
                {toolTotals.length === 0 ? (
                  <p className="no-data">No tool data yet</p>
                ) : toolTotals.map(t => (
                  <div className="drawer-bar-row" key={t.tool}>
                    <span className="drawer-bar-label">{t.tool}</span>
                    <div className="drawer-bar-track">
                      <div className="drawer-bar-fill" style={{ width: `${Math.round(t.tokens / maxToolTokens * 100)}%` }} />
                    </div>
                    <span className="drawer-bar-val">{formatTokens(t.tokens)}</span>
                  </div>
                ))}
              </div>

              {/* Models Used */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  <span className="dsicon">◆</span> Models Used
                </div>
                {modelTotals.length === 0 ? (
                  <p className="no-data">No model data yet</p>
                ) : modelTotals.map(m => (
                  <div className="drawer-bar-row" key={m.model}>
                    <span className="drawer-bar-label wide">{m.model}</span>
                    <div className="drawer-bar-track">
                      <div className="drawer-bar-fill" style={{ width: `${m.pct}%` }} />
                    </div>
                    <span className="drawer-bar-val">{formatCost(m.cost)}</span>
                  </div>
                ))}
              </div>

              {/* Token Breakdown */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  <span className="dsicon">◆</span> Tokens
                </div>
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

              {/* Daily Breakdown */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  <span className="dsicon">◆</span> Daily Breakdown
                </div>
                {data.daily.length === 0 ? (
                  <p className="no-data">No daily data</p>
                ) : (
                  <table className="drawer-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Cost</th>
                      </tr>
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

              {/* Usage by Period (bar chart) */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  <span className="dsicon">◆</span> Daily Cost Trend
                </div>
                {data.daily.length === 0 ? (
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
                          <div className="drawer-bar-fill" style={{ width: `${Math.round((d.cost_millicents / maxCost) * 100)}%` }} />
                        </div>
                        <span className="drawer-bar-val">{formatCost(d.cost_millicents)}</span>
                      </div>
                    ))
                )}
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

  useEffect(() => {
    setDevelopers(null)
    setError('')
    api.developers(days)
      .then(r => setDevelopers(r.developers))
      .catch(e => setError(e.message))
  }, [days])

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
          <div className="topbar-title">Developers</div>
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
