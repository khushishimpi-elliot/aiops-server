import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { api } from './api'
import Layout from './components/Layout'
import Login from './pages/Login'
import OrgOverview from './pages/OrgOverview'
import DeveloperList from './pages/DeveloperList'

interface AuthCtx {
  email: string | null
  setEmail: (e: string | null) => void
}

export const AuthContext = createContext<AuthCtx>({ email: null, setEmail: () => {} })
export const useAuth = () => useContext(AuthContext)

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { email } = useAuth()
  return email ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  const [email, setEmail] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api.me()
      .then(r => setEmail(r.email))
      .catch(() => setEmail(null))
      .finally(() => setChecking(false))
  }, [])

  if (checking) return null

  return (
    <AuthContext.Provider value={{ email, setEmail }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Navigate to="/org" replace />} />
            <Route path="org" element={<OrgOverview />} />
            <Route path="developers" element={<DeveloperList />} />
            <Route path="developers/:email" element={<Navigate to="/developers" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  )
}
