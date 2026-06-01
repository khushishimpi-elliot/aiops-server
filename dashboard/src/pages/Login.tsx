import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../App'

export default function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { setEmail: setAuthEmail } = useAuth()
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const r = await api.login(password)
      setAuthEmail(r.email)
      navigate('/org', { replace: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <svg
            viewBox="0 0 260 60"
            style={{ display: 'block', width: '160px', height: 'auto' }}
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

        <div className="login-heading">
          <h1>Sign in to AIOps</h1>
          <p>AI usage monitoring for your engineering team</p>
        </div>

        <form onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}

          <div className="form-group">
            <label htmlFor="password">Admin Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter admin password"
              autoComplete="current-password"
              autoFocus
              required
            />
          </div>

          <button type="submit" className="btn-signin" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="login-footer">
          Elliot Systems · Internal Tool
        </div>
      </div>
    </div>
  )
}
