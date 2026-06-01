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
          <svg
            viewBox="0 0 260 60"
            style={{ display: 'block', width: '90px', height: 'auto' }}
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M0 0 L36 0 L36 10 L12 10 L12 22 L30 22
                 L30 32 L12 32 L12 50 L36 50 L36 60 L0 60 Z"
              fill="#000000"
            />
            <polygon points="14,14 14,46 34,30" fill="#FF6600"/>
            <path
              d="M44 0 L56 0 L56 50 L78 50 L78 60 L44 60 Z"
              fill="#000000"
            />
            <path
              d="M86 0 L98 0 L98 50 L120 50 L120 60 L86 60 Z"
              fill="#000000"
            />
            <rect x="128" y="0" width="12" height="60" fill="#000000"/>
            <path
              d="M150 0 L184 0 L184 60 L150 60 Z
                 M162 12 L162 48 L172 48 L172 12 Z"
              fill="#000000"
            />
            <path
              d="M194 0 L240 0 L240 12 L223 12
                 L223 60 L211 60 L211 12 L194 12 Z"
              fill="#000000"
            />
          </svg>
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
