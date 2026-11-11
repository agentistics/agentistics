/** Real navigation components with throwaway preferences and a router, without a running API. */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { AreaRail } from '../src/components/nav/AreaRail'
import { AreaTree } from '../src/components/nav/AreaTree'
import { AsideHeader } from '../src/components/nav/AsideHeader'
import { MobileAreaBar } from '../src/components/nav/MobileAreaBar'
import { areaOpenStore } from '../src/lib/areaOpen'
import '../src/index.css'

function Fixture() {
  const mode = new URLSearchParams(window.location.search).get('mode') ?? 'aside'
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => { areaOpenStore.set({ sessions: false, usage: true, tasks: false }) }, [])
  const mobile = mode === 'mobile'
  return <div style={{ display: 'flex', height: '100dvh', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
    {!mobile && <aside data-open={open} style={{ position: 'relative', width: mode === 'rail' ? 320 : open ? 264 : 64, padding: 8, boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <AsideHeader lang="en" height={48} collapsed={!open} onToggle={() => setOpen(v => !v)} />
      <div style={{ position: 'relative', flex: 1, minHeight: 0, overflowY: mode === 'rail' ? 'visible' : 'auto' }}>
        {mode === 'rail'
          ? <AreaRail lang="en" pathname={location.pathname} open={open} onOpenChange={setOpen} />
          : <AreaTree lang="en" pathname={location.pathname} collapsed={!open} onExpand={() => setOpen(true)} />}
      </div>
    </aside>}
    <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
      <h1>Navigation interaction</h1>
      <p>Current route: <output data-location>{location.pathname}</output></p>
      <p>Select a group to open its pages.</p>
    </main>
    {mobile && <MobileAreaBar lang="en" pathname={location.pathname} onNavigate={navigate} actions={[]} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><MemoryRouter initialEntries={['/sessions']}><Fixture /></MemoryRouter></StrictMode>)
