import { useState, useEffect } from 'react'
import { api } from '../api'
import type { OrgOverviewResponse, DevSummaryItem, TaskCategoryItem } from '../types'
import { formatCost, formatTokens } from '../utils'

const CAT_COLORS = ['#FF6600','#3b82f6','#22c55e','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#06b6d4']

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  claude_code: 'Claude Code',
  claude:      'Claude Code',
  copilot:     'GitHub Copilot',
  gemini:      'Gemini CLI',
  cursor:      'Cursor',
  windsurf:    'Windsurf',
  cline:       'Cline',
  roo:         'Roo Code',
  kilo:        'Kilo Code',
  codex:       'Codex',
  pi:          'Pi',
}

function displayToolName(tool: string): string {
  return TOOL_DISPLAY_NAMES[tool.toLowerCase()] ?? tool
}

function formatCategory(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0]
  return local.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
}

function avatarLetter(email: string): string {
  return email.charAt(0).toUpperCase()
}

const DEV_COLORS = ['#FF6600','#6366f1','#f59e0b','#10b981','#3b82f6','#ec4899']

export default function OrgOverview() {
  const [days, setDays] = useState(90)
  const [data, setData] = useState<OrgOverviewResponse | null>(null)
  const [devs, setDevs] = useState<DevSummaryItem[] | null>(null)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [otherExpanded, setOtherExpanded] = useState(false)

  function fetchData(clear = false) {
    if (clear) { setData(null); setDevs(null) }
    setError('')
    setRefreshing(true)
    Promise.all([
      api.org(days),
      api.developers(days),
    ]).then(([orgData, devsData]) => {
      setData(orgData)
      setDevs(devsData.developers)
      setLastUpdated(new Date().toLocaleTimeString())
    }).catch(e => setError(e.message))
    .finally(() => setRefreshing(false))
  }

  useEffect(() => {
    fetchData(true)
  }, [days])

  useEffect(() => {
    const id = setInterval(() => {
      fetchData()
    }, 30 * 1000)
    return () => clearInterval(id)
  }, [])

  // Derive tool totals from by_tool_model
  const toolTotals = data ? (() => {
    const map = new Map<string, { input: number; output: number; sessions: number; days: number }>()
    for (const row of data.by_tool_model) {
      const existing = map.get(row.tool) ?? { input: 0, output: 0, sessions: 0, days: 0 }
      existing.input    += row.input_tokens
      existing.output   += row.output_tokens
      existing.sessions += row.session_count ?? row.days_active
      existing.days      = Math.max(existing.days, row.days_active)
      map.set(row.tool, existing)
    }
    return [...map.entries()]
      .map(([tool, v]) => ({ tool, total: v.input + v.output, sessions: v.sessions, days: v.days }))
      .sort((a, b) => b.sessions - a.sessions)
  })() : []

  const maxToolSessions = toolTotals[0]?.sessions ?? 1

  // Derive model totals
  const modelRows = data ? (() => {
    const map = new Map<string, { cost: number; input: number; output: number; days: number; sessions: number }>()
    for (const row of data.by_tool_model) {
      const existing = map.get(row.model) ?? { cost: 0, input: 0, output: 0, days: 0, sessions: 0 }
      existing.cost    += row.cost_millicents
      existing.input   += row.input_tokens
      existing.output  += row.output_tokens
      existing.days     = Math.max(existing.days, row.days_active)
      existing.sessions += row.session_count ?? row.days_active
      map.set(row.model, existing)
    }
    return [...map.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost)
  })() : []

  // Sort devs by cost
  const sortedDevs = devs ? [...devs].sort((a, b) => b.total_cost_millicents - a.total_cost_millicents) : []
  const topDev = sortedDevs[0]

  const topBarLabel = `Last ${days} days`

  const MAIN_CATS = [
    'code_generation',
    'debugging',
    'configuration',
    'testing',
    'research',
    'automation',
  ]

  const OTHER_SUBCATS = [
    'writing',
    'analysis',
    'code review',
    'refactoring',
    'documentation',
    'architecture',
    'agentic',
  ]

  interface NormalizedCategory {
    category:      string
    session_count: number
    pct:           number
    sub?:          { category: string; session_count: number; pct: number }[]
  }

  function normalizeCategories(
    cats: TaskCategoryItem[]
  ): NormalizedCategory[] {
    const mainCounts: Record<string, number> = {}
    const subCounts:  Record<string, number> = {}
    let otherTotal = 0

    for (const c of cats) {
      const key = c.category.toLowerCase().trim()
      if (MAIN_CATS.includes(key)) {
        mainCounts[key] = (mainCounts[key] ?? 0) + c.session_count
      } else if (OTHER_SUBCATS.includes(key)) {
        subCounts[key] = (subCounts[key] ?? 0) + c.session_count
        otherTotal += c.session_count
      } else {
        otherTotal += c.session_count
      }
    }

    const total = [
      ...Object.values(mainCounts),
      otherTotal,
    ].reduce((a, b) => a + b, 0) || 1

    const result: NormalizedCategory[] = []

    // Add main categories in order
    for (const key of MAIN_CATS) {
      if (mainCounts[key] && mainCounts[key] > 0) {
        result.push({
          category:      key,
          session_count: mainCounts[key],
          pct:           Math.round((mainCounts[key] / total) * 100),
        })
      }
    }

    // Add Other last with sub-items (only the specified sub-categories)
    if (otherTotal > 0) {
      const subs = OTHER_SUBCATS
        .filter(k => subCounts[k] && subCounts[k] > 0)
        .map(k => ({
          category:      k,
          session_count: subCounts[k],
          pct:           0, // pct will be calculated relative to otherTotal
        }))
        .sort((a, b) => b.session_count - a.session_count)

      // Calculate percentages for sub-items
      const subTotal = subs.reduce((sum, s) => sum + s.session_count, 0) || 1
      subs.forEach(s => {
        s.pct = Math.round((s.session_count / subTotal) * 100)
      })

      result.push({
        category:      'other',
        session_count: otherTotal,
        pct:           Math.round((otherTotal / total) * 100),
        sub:           subs.length > 0 ? subs : undefined,
      })
    }

    return result
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="topbar-kicker">Elliot Systems</div>
          <div className="topbar-title">
            Organization Overview
            {lastUpdated && (
              <span style={{
                fontSize: '11px',
                color: '#9ca3af',
                marginLeft: '12px',
              }}>
                Last updated {lastUpdated}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => fetchData()}
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
          <select
            className="period-select"
            value={days}
            onChange={e => setDays(Number(e.target.value))}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
            <option value={365}>Last 1 year</option>
          </select>
        </div>
      </div>

      <div className="content-area">
        {error && <div className="page-error">{error}</div>}
        {!data && !error && <div className="page-loading">Loading…</div>}

        {data && (
          <>
            {/* Stat Cards */}
            <div className="stat-cards">
              <div className="stat-card">
                <div className="stat-top">
                  <div>
                    <div className="stat-label">Total Cost</div>
                    <div className="stat-value">{formatCost(data.total_cost_millicents)}</div>
                  </div>
                  <div className="stat-icon brand-bg">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FF6600" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="1" x2="12" y2="23"/>
                      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                    </svg>
                  </div>
                </div>
                <div className="stat-meta">{topBarLabel}</div>
              </div>

              <div className="stat-card">
                <div className="stat-top">
                  <div>
                    <div className="stat-label">Input Tokens</div>
                    <div className="stat-value">{formatTokens(data.total_input_tokens)}</div>
                  </div>
                  <div className="stat-icon green-bg">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                  </div>
                </div>
                <div className="stat-meta">Tokens sent to AI</div>
              </div>

              <div className="stat-card">
                <div className="stat-top">
                  <div>
                    <div className="stat-label">Output Tokens</div>
                    <div className="stat-value">{formatTokens(data.total_output_tokens)}</div>
                  </div>
                  <div className="stat-icon blue-bg">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1d4ed8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  </div>
                </div>
                <div className="stat-meta">Tokens generated</div>
              </div>

              <div className="stat-card">
                <div className="stat-top">
                  <div>
                    <div className="stat-label">Active Developers</div>
                    <div className="stat-value">{data.active_developers}</div>
                  </div>
                  <div className="stat-icon purple-bg">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                  </div>
                </div>
                <div className="stat-meta">With usage this period</div>
              </div>

            </div>

            {/* Panels Grid */}
            <div className="panels-grid">

              {/* Panel 1: Most AI Using Developer */}
              <div className="panel-card">
                <div className="panel-header">
                  <div>
                    <div className="panel-title">
                      <span className="panel-diamond">◆</span>
                      Most AI Using Developer
                    </div>
                    <div className="panel-subtitle">Top contributor by cost</div>
                  </div>
                </div>
                <div className="panel-body">
                  {!topDev ? (
                    <p className="no-data">No developer data</p>
                  ) : (
                    <>
                      <div className="top-dev-box">
                        <div className="dev-avatar" style={{ background: DEV_COLORS[0] }}>
                          {avatarLetter(topDev.email)}
                        </div>
                        <div className="dev-info">
                          <div className="dev-name">{nameFromEmail(topDev.email)}</div>
                          <div className="dev-email">{topDev.email}</div>
                        </div>
                        <div className="badge-rank">#1</div>
                      </div>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Developer</th>
                            <th>Cost</th>
                            <th>Tokens</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedDevs.slice(0, 3).map((dev, i) => (
                            <tr key={dev.user_id}>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div className="dev-avatar small" style={{ background: DEV_COLORS[i % DEV_COLORS.length] }}>
                                    {avatarLetter(dev.email)}
                                  </div>
                                  <span style={{ fontWeight: 600 }}>{nameFromEmail(dev.email)}</span>
                                </div>
                              </td>
                              <td className="cost-cell">{formatCost(dev.total_cost_millicents)}</td>
                              <td style={{ color: 'var(--gray-500)' }}>
                                {formatTokens(dev.total_input_tokens + dev.total_output_tokens)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              </div>

              {/* Panel 2: Most Used Tool */}
              <div className="panel-card">
                <div className="panel-header">
                  <div>
                    <div className="panel-title">
                      <span className="panel-diamond">◆</span>
                      Most Used Tool
                    </div>
                    <div className="panel-subtitle">By session count</div>
                  </div>
                </div>
                <div className="panel-body">
                  {toolTotals.length === 0 ? (
                    <p className="no-data">No data yet — run <code>python aiops.py report</code></p>
                  ) : (
                    <div className="bar-chart">
                      {toolTotals.map((t, i) => (
                        <div className="bar-row" key={t.tool}>
                          <div className="bar-label">{displayToolName(t.tool)}</div>
                          <div className="bar-track">
                            <div
                              className={'bar-fill' + (i > 0 ? ' gray' : '')}
                              style={{ width: `${Math.round((t.sessions / maxToolSessions) * 100)}%` }}
                            />
                          </div>
                          <div className="bar-count">
                            {t.sessions > 0 ? `${t.sessions} sessions` : formatTokens(t.total)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Panel 3: Most Used Model */}
              <div className="panel-card">
                <div className="panel-header">
                  <div>
                    <div className="panel-title">
                      <span className="panel-diamond">◆</span>
                      Most Used Model
                    </div>
                    <div className="panel-subtitle">By cost</div>
                  </div>
                </div>
                <div className="panel-body" style={{ padding: 0 }}>
                  {modelRows.length === 0 ? (
                    <p className="no-data" style={{ padding: '18px 20px' }}>No model data</p>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Requests</th>
                          <th>Cost</th>
                          <th>In</th>
                          <th>Out</th>
                        </tr>
                      </thead>
                      <tbody>
                        {modelRows.slice(0, 5).map(row => (
                          <tr key={row.model}>
                            <td><span className="model-pill">{row.model}</span></td>
                            <td style={{ color: 'var(--gray-500)' }}>{row.sessions}</td>
                            <td className="cost-cell">{formatCost(row.cost)}</td>
                            <td style={{ color: 'var(--gray-500)' }}>{formatTokens(row.input)}</td>
                            <td style={{ color: 'var(--gray-500)' }}>{formatTokens(row.output)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Panel 4: Task Coverage */}
              <div className="panel-card">
                <div className="panel-header">
                  <div>
                    <div className="panel-title">
                      <span className="panel-diamond">◆</span>
                      Task Coverage
                    </div>
                    <div className="panel-subtitle">
                      {data.primary_use_case
                        ? <>Primary: <strong>{data.primary_use_case}</strong> · Diversity: <strong>{data.task_diversity_score}%</strong></>
                        : 'Category breakdown by session'}
                    </div>
                  </div>
                </div>
                <div className="panel-body">
                  {data.task_categories.length === 0 ? (
                    <p className="no-data">No category data yet — run <code>python aiops.py report</code></p>
                  ) : (
                    <div className="cat-list">
                      {normalizeCategories(data.task_categories)
                        .map((c, i) => (
                          <div key={c.category}>
                            <div
                              className="cat-row"
                              style={{
                                cursor: c.sub ? 'pointer' : 'default'
                              }}
                              onClick={() => {
                                if (c.sub) setOtherExpanded(e => !e)
                              }}
                            >
                              <div className="cat-meta">
                                <div className="cat-label-wrap">
                                  <div
                                    className="cat-dot"
                                    style={{
                                      background: CAT_COLORS[i % CAT_COLORS.length]
                                    }}
                                  />
                                  {formatCategory(c.category)}
                                  {c.sub && (
                                    <span style={{
                                      marginLeft: 6,
                                      fontSize:   11,
                                      color:      'var(--gray-400)',
                                    }}>
                                      {otherExpanded ? '▲' : '▼'}
                                    </span>
                                  )}
                                </div>
                                <div style={{
                                  display:    'flex',
                                  gap:        10,
                                  alignItems: 'center',
                                }}>
                                  <span style={{
                                    fontSize: 11,
                                    color:    'var(--gray-500)',
                                  }}>
                                    {c.session_count} sessions
                                  </span>
                                  <div className="cat-pct">{c.pct}%</div>
                                </div>
                              </div>
                              <div className="cat-track">
                                <div
                                  className="cat-fill"
                                  style={{
                                    width:      `${c.pct}%`,
                                    background: CAT_COLORS[i % CAT_COLORS.length],
                                  }}
                                />
                              </div>
                            </div>

                            {/* Sub-items dropdown for Other */}
                            {c.sub && otherExpanded && (
                              <div style={{
                                marginLeft:      16,
                                marginBottom:     8,
                                borderLeft:       '2px solid var(--gray-200)',
                                paddingLeft:      12,
                              }}>
                                {c.sub.map((s, si) => (
                                  <div
                                    key={s.category}
                                    style={{
                                      display:        'flex',
                                      alignItems:     'center',
                                      justifyContent: 'space-between',
                                      padding:        '5px 0',
                                      borderBottom:   si < c.sub!.length - 1
                                        ? '1px solid var(--gray-100)'
                                        : 'none',
                                    }}
                                  >
                                    <span style={{
                                      fontSize: 12,
                                      color:    'var(--gray-600)',
                                      display:  'flex',
                                      alignItems: 'center',
                                      gap: 6,
                                    }}>
                                      <span style={{
                                        width:        5,
                                        height:       5,
                                        borderRadius: '50%',
                                        background:   'var(--gray-400)',
                                        display:      'inline-block',
                                        flexShrink:   0,
                                      }} />
                                      {formatCategory(s.category)}
                                    </span>
                                    <span style={{
                                      fontSize: 11,
                                      color:    'var(--gray-400)',
                                    }}>
                                      {s.session_count} sessions
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </div>

            </div>
          </>
        )}
      </div>
    </>
  )
}
