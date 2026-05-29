import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../App'
import { api } from '../api'

function nameFromEmail(email: string): string {
  const local = email.split('@')[0]
  return local.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
}

function avatarLetter(email: string): string {
  return email.charAt(0).toUpperCase()
}

export default function Layout() {
  const { email, setEmail } = useAuth()

  async function handleLogout() {
    await api.logout().catch(() => {})
    setEmail(null)
  }

  const name = email ? nameFromEmail(email) : 'Admin'
  const letter = email ? avatarLetter(email) : 'A'

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
          </div>
          <span className="sidebar-brand-text">
            Ai<span className="orange">Ops</span>
          </span>
        </div>

        <div className="sidebar-nav">
          <div className="nav-section-label">Main</div>
          <NavLink
            to="/org"
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/>
              <rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/>
            </svg>
            Overview
          </NavLink>
          <NavLink
            to="/developers"
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            Developers
          </NavLink>
        </div>

        <div className="sidebar-footer">
          <div className="user-block">
            <div className="user-avatar">{letter}</div>
            <div className="user-info">
              <div className="user-name">{name}</div>
              <div className="user-email">{email}</div>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Log out
          </button>
        </div>
      </nav>

      <div className="main-area">
        <Outlet />
      </div>
    </div>
  )
}
