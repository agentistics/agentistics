/**
 * Sessions list redesign ("A + C + D", owner 2026-10-23) — a dev-only render of the REAL
 * `SessionsAside` / `SessionsRail` over a fixture. Not shipped.
 *
 * The fixture is this machine's fleet as `agentistics_session_groups` reported it on 2026-10-23
 * (titles, states, harnesses, folder names), plus team links written by hand where the fleet has
 * them (each worker filed under the leader that started it), a few fallen and finished-today rows.
 *
 * Query: ?tab=active|groups|ended &theme=dark|light &rail=1 &fold=<leader id> &lang=pt|en
 */
import ReactDOM from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import '../../src/index.css'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { Filters } from '@agentistics/core'

const q = new URLSearchParams(location.search)
const tab = q.get('tab') ?? 'active'
const rail = q.get('rail') === '1'
const lang = (q.get('lang') ?? 'pt') as 'pt' | 'en'
const fold = q.get('fold')
document.documentElement.setAttribute('data-theme', q.get('theme') === 'light' ? 'light' : 'dark')

const NOW = Date.now()
const MIN = 60_000
const today = (h: number, m: number) => { const d = new Date(NOW); d.setHours(h, m, 0, 0); return Math.min(d.getTime(), NOW - MIN) }
const STATE_PT: Record<string, string> = {
  working: 'trabalhando', waiting: 'precisa de você', 'waiting-approval': 'precisa de você', unknown: 'parada',
  exited: 'encerrada', lost: 'caiu', closed: 'encerrada',
}
const row = (id: string, title: string, state: ControlSession['state'], harness: string, extra: Partial<ControlSession> = {}): ControlSession => ({
  id, title, harness, state, stateLabel: STATE_PT[state] ?? state, project: 'agentistics', cwd: '/home/u/agentistics',
  searchFields: { name: title, folder: '', harness, note: '', task: '', prompt: '' }, actionable: true, attached: false,
  ...extra,
} as ControlSession)

const rows: ControlSession[] = [
  // Live — leaders and their teams.
  row('side', '[ LÍDER ] - Side Tasks', 'waiting', 'claude', { startedAt: NOW - 300 * MIN, lastUserMessageAt: NOW - 1 * MIN }),
  row('painel', 'Painel de sessões A+C+D (Opus)', 'working', 'claude', { parentSessionId: 'side', startedAt: NOW - 95 * MIN, lastUserMessageAt: NOW - 4 * MIN }),
  row('soar', '[ LÍDER ] - SOAR SITE', 'waiting', 'claude', { startedAt: NOW - 400 * MIN, lastUserMessageAt: NOW - 0.5 * MIN }),
  row('sori', 'SOAR · Sori joelho e tornozelo (Opus)', 'waiting', 'claude', { parentSessionId: 'soar', startedAt: NOW - 80 * MIN, lastUserMessageAt: NOW - 12 * MIN }),
  row('estudo06', 'SOAR · Estudo 06 Forma', 'working', 'claude', { parentSessionId: 'soar', startedAt: NOW - 40 * MIN, lastUserMessageAt: NOW - 6 * MIN }),
  row('qaest', 'SOAR · QA estudos (Codex)', 'working', 'codex', { parentSessionId: 'soar', startedAt: NOW - 35 * MIN, lastUserMessageAt: NOW - 2 * MIN }),
  row('motor', '[ LÍDER ] - Motor', 'waiting', 'claude', { startedAt: NOW - 500 * MIN, lastUserMessageAt: NOW - 8 * MIN }),
  row('trust', 'ADAPTER.TRUST · confiar na pasta + formulários no card (Opus)', 'waiting', 'claude', { parentSessionId: 'motor', startedAt: NOW - 120 * MIN, lastUserMessageAt: NOW - 20 * MIN }),
  row('orq', 'ORQ.FORA · app aplica o fluxo do líder sozinho (Codex sol)', 'waiting', 'codex', { parentSessionId: 'motor', startedAt: NOW - 110 * MIN, lastUserMessageAt: NOW - 25 * MIN }),
  row('perf', 'OPEN-PERF · abrir sessão sem travar o app (Opus)', 'waiting', 'claude', { parentSessionId: 'motor', startedAt: NOW - 70 * MIN, lastUserMessageAt: NOW - 3 * MIN }),
  // Live — no leader.
  row('perguntas', 'Teste de perguntas', 'waiting', 'claude', { startedAt: NOW - 90 * MIN, lastUserMessageAt: NOW - 60 * MIN }),
  // Fell (the machine's crash group).
  row('seg', 'Revisão de segurança', 'lost', 'codex', { endedAt: NOW - 180 * MIN }),
  row('qar2', 'QA estático r2', 'lost', 'codex', { endedAt: NOW - 120 * MIN }),
  // Sleeping — pinned or leaders that stopped.
  row('maestro', '[ LÍDER ] - Maestro (superskill)', 'exited', 'claude', { endedAt: NOW - 26 * 60 * MIN }),
  row('pront', '[ LÍDER ] - Prontuario (anterior)', 'exited', 'claude', { endedAt: NOW - 28 * 60 * MIN }),
  // Finished today, then older history.
  row('recado', 'Recado e check-in (Codex)', 'exited', 'codex', { endedAt: today(13, 51) }),
  row('estudo05', 'SOAR · Estudo 05 Prova', 'exited', 'claude', { endedAt: today(13, 20) }),
  row('upx', 'UPX · Financial MCP (avaliação)', 'exited', 'claude', { endedAt: NOW - 4 * 24 * 60 * MIN }),
  row('upxshell', 'UPX PoC · shell', 'exited', 'codex', { endedAt: NOW - 5 * 24 * 60 * MIN }),
]

const prefs = {
  sessionsAside: { tab, foldedTeams: fold ? [fold] : [], collapsedUserGroups: ['g-pront'], leadersOnly: false },
  pinnedSessions: ['side', 'soar'],
  sessionGroups: { groups: [
    { id: 'g-side', name: 'Agentistics Side Tasks', sessionKeys: [] },
    { id: 'g-side-l', name: 'Líderes', parentId: 'g-side', sessionKeys: ['side', 'motor'] },
    { id: 'g-side-a', name: 'Em andamento', parentId: 'g-side', sessionKeys: ['painel', 'trust', 'orq', 'perf'] },
    { id: 'g-side-f', name: 'Finalizadas', parentId: 'g-side', sessionKeys: ['recado'] },
    { id: 'g-soar', name: 'SOAR Site', sessionKeys: ['soar', 'sori', 'estudo06', 'qaest', 'estudo05'] },
    { id: 'g-pront', name: 'Prontuário', sessionKeys: ['pront', 'seg'] },
    { id: 'g-upx', name: 'UPX Discovery', sessionKeys: ['upx', 'upxshell'] },
  ] },
}
const realFetch = window.fetch.bind(window)
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (init?.method && init.method !== 'GET') return Response.json({ ok: true })
  if (url.startsWith('/api/user-prefs')) return Response.json(prefs, { headers: { 'X-Prefs-Writable': 'false' } })
  if (url.startsWith('/api/session-roles')) return Response.json({ roles: { side: 'leader', soar: 'leader', motor: 'leader', maestro: 'leader', pront: 'leader' } })
  if (url.startsWith('/api/')) return Response.json({})
  return realFetch(input, init)
}) as typeof fetch
;(window as unknown as { EventSource: unknown }).EventSource = class { close() {} addEventListener() {} removeEventListener() {} }

const verbs = (s: ControlSession) => s.state === 'exited' || s.state === 'lost'
  ? [{ action: 'resume', label: 'Reabrir', enabled: true }, { action: 'rename', label: 'Renomear', enabled: true }]
  : [{ action: 'rename', label: 'Renomear', enabled: true }, { action: 'kill', label: 'Encerrar sessão', enabled: true }]
const rowsById = new Map(rows.map(s => [s.id, { id: s.id, verbs: verbs(s), fell: s.state === 'lost', title: s.title, stateLabel: s.stateLabel }]))
const filters = { dateRange: 'all', customStart: '', customEnd: '', projects: [], models: [] } as Filters
const act = async () => ({ ok: true, message: '' })

const { loadSharedPrefs } = await import('../../src/lib/sharedPref')
await loadSharedPrefs()
const { SessionsAside } = await import('../../src/components/nav/SessionsAside')
const { SessionsRail } = await import('../../src/components/nav/SessionsRail')
const mobile = window.innerWidth < 768

function Shell() {
  const panel: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', minHeight: 0, boxSizing: 'border-box',
    border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)',
  }
  return (
    <MemoryRouter initialEntries={['/sessions/painel']}>
      <div style={{ display: 'flex', gap: 6, height: '100vh', boxSizing: 'border-box', padding: mobile ? 0 : 8, background: 'var(--bg-base, var(--bg))' }}>
        {rail ? (
          <div style={{ ...panel, width: 64, padding: '6px 0' }}>
            <SessionsRail rows={rows} allRows={rows} lang={lang} selectedId="painel" rowsById={rowsById} act={act} />
          </div>
        ) : (
          <div style={{ ...panel, width: mobile ? '100%' : 340, padding: 8, ...(mobile ? { border: 'none', borderRadius: 0 } : {}) }}>
            <SessionsAside lang={lang} rows={rows} finishedTasks={[]} loading={false} unsupported={false}
              filters={filters} activeOnly rowsById={rowsById} act={act}
              filtersOpen={false} filtersCount={0} onToggleFilters={() => {}} filtersButtonRef={() => {}} />
          </div>
        )}
        {!mobile && <div style={{ ...panel, flex: 1, alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
          Painel de sessões A+C+D (Opus)
        </div>}
      </div>
    </MemoryRouter>
  )
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Shell />)
