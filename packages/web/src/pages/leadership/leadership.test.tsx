import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { AWAY_OFF } from '@agentistics/core'
import { LeadersContent } from './LeadersPage'
import { HandoffsContent } from './HandoffsPage'
import { CheckinsContent } from './CheckinsPage'
import { AwayContent } from './AwayPage'
import { checkinDefaults, type CheckinState } from '../../lib/checkin'
import { HARNESS_LABELS } from '../../lib/harness'
import { __setAwayForTest } from '../../lib/awayMode'

function atWidth(width: number, render: () => string) {
  const root = globalThis as { window?: unknown }
  const previous = root.window
  root.window = { innerWidth: width, innerHeight: 900, matchMedia: () => ({ matches: width < 768, addEventListener() {}, removeEventListener() {} }) }
  try { return render() } finally { if (previous === undefined) delete root.window; else root.window = previous }
}
const row = (id: string, patch: Partial<ControlSession> = {}) => ({
  id, title: `Session ${id}`, conversationId: `conversation-${id}`, harness: 'codex',
  state: 'working', stateLabel: 'Trabalhando', ...patch,
}) as ControlSession
const rows = [row('a', { task: 'Navigation', startedAt: 1_000 }), row('b', { state: 'waiting-approval', stateLabel: 'Aguardando aprovação' }), row('c', { parentConversationId: 'conversation-a' })]
const roleOf = (r: ControlSession) => r.id === 'c' ? 'worker' as const : 'leader' as const

for (const width of [1440, 390]) describe(`Leadership at ${width}px`, () => {
  test('two leaders have title, state, child count and accessible 44px open actions', () => {
    const html = atWidth(width, () => renderToStaticMarkup(<MemoryRouter><LeadersContent lang="pt" rows={rows} roleOf={roleOf} now={61_000} /></MemoryRouter>))
    expect(html).toContain('2 líderes · 1 precisam de você')
    expect(html).toContain('Session a'); expect(html).toContain('Session b'); expect(html).not.toContain('Session c')
    expect(html).toContain('Trabalhando'); expect(html).toContain('Aguardando aprovação')
    expect(html).toContain('Navigation'); expect(html).toContain('>Filhas<')
    expect(html).toContain('>1</span>'); expect(html).toContain('>0</span>')
    expect(html.match(/aria-label="Abrir Session /g)).toHaveLength(2)
    expect(html).toContain('min-height:44px')
  })
  test('empty fleet says there are no leaders; unavailable and loading never claim zero', () => {
    const render = (extra: { loading?: boolean; unavailable?: boolean; stale?: string } = {}) => atWidth(width, () => renderToStaticMarkup(<MemoryRouter><LeadersContent lang="pt" rows={[]} roleOf={roleOf} {...extra} /></MemoryRouter>))
    expect(render()).toContain('Nenhuma sessão líder agora.')
    for (const props of [{ loading: true }, { unavailable: true }, { stale: 'Offline' }]) {
      expect(render(props)).not.toContain('Nenhuma sessão líder agora.')
      expect(render(props)).not.toContain('0 líderes')
    }
  })
  test('ended leaders are excluded', () => {
    const html = atWidth(width, () => renderToStaticMarkup(<MemoryRouter><LeadersContent lang="en" rows={[row('ended', { state: 'exited' })]} roleOf={() => 'leader'} /></MemoryRouter>))
    expect(html).toContain('No leader sessions right now.')
    expect(html).not.toContain('Session ended')
  })
  test('handoffs is an honest placeholder with no pretend controls', () => {
    const html = atWidth(width, () => renderToStaticMarkup(<HandoffsContent lang="pt" />))
    expect(html).toContain('A configuração de passagem (limite global, medidor e custo por fatia extra) chega na próxima entrega.')
    expect(html).not.toMatch(/<(input|button|select)\b/)
  })
  test('check-in latest rounds use status pills and keep global defaults', () => {
    const reports: CheckinState[] = (['ok', 'resolved', 'needs_you'] as const).map((state, i) => ({
      ...checkinDefaults(), session: `conversation-${['a', 'b', 'c'][i]}`, lastRunAt: i * 1000, nextRunAt: null,
      last: { state, summary: `Round summary ${state}`, at: i * 1000 },
    }))
    const html = atWidth(width, () => renderToStaticMarkup(<CheckinsContent lang="pt" reports={reports} rows={rows} />))
    expect(html).toContain('Session a')
    expect(html).toContain('>OK<'); expect(html).toContain('>Resolvido<'); expect(html).toContain('>Precisa de você<')
    expect(html).toContain('Round summary needs_you')
    expect(html).toContain('data-testid="checkin-defaults-section"')
    expect(html.indexOf('Round summary needs_you')).toBeLessThan(html.indexOf('Round summary ok'))
  })
  test('check-ins omit orphaned sessions instead of repeating unknown titles', () => {
    const orphaned: CheckinState[] = Array.from({ length: 77 }, (_, index) => ({
      ...checkinDefaults(), session: `gone-${index}`, lastRunAt: index, nextRunAt: null,
      last: { state: 'ok', summary: `Orphan summary ${index}`, at: index },
    }))
    const live: CheckinState = { ...checkinDefaults(), session: 'conversation-a', lastRunAt: 100, nextRunAt: null,
      last: { state: 'ok', summary: 'Current leader round', at: 100 } }
    for (const lang of ['pt', 'en'] as const) {
      const render = (reports: CheckinState[]) => atWidth(width, () => renderToStaticMarkup(<CheckinsContent lang={lang} reports={reports} rows={rows} />))
      const html = render([...orphaned, live])
      expect(html).toContain('Session a')
      expect(html).toContain('Current leader round')
      for (const raw of ['Unknown session', 'Sessão desconhecida', 'Orphan summary', 'gone-', 'Show more (', 'Mostrar mais (']) expect(html).not.toContain(raw)
      expect(render(orphaned)).toContain(lang === 'pt' ? 'Nenhuma rodada de check-in registrada ainda.' : 'No check-in rounds recorded yet.')
    }
  })
  test('matching check-ins still paginate at ten and keep summaries left aligned', () => {
    const manyRows = Array.from({ length: 12 }, (_, index) => row(`leader-${index}`))
    const reports: CheckinState[] = manyRows.map((leader, index) => ({
      ...checkinDefaults(), session: leader.id, lastRunAt: index, nextRunAt: null,
      last: { state: 'ok', summary: `Leader round ${index}`, at: index },
    }))
    const html = atWidth(width, () => renderToStaticMarkup(<CheckinsContent lang="en" reports={reports} rows={manyRows} />))
    expect(html).toContain('Show more (2)')
    expect(html).toContain('Leader round 11')
    expect(html).not.toContain('Leader round 0<')
    expect(html).toContain('text-align:left')
    expect(html).toContain('min-height:44px')
  })
  test('leader labels use product names and waiting states use the attention tone', () => {
    for (const lang of ['pt', 'en'] as const) {
      const html = atWidth(width, () => renderToStaticMarkup(<MemoryRouter><LeadersContent lang={lang}
        rows={[row('waiting', { harness: 'claude', state: 'waiting', stateLabel: lang === 'pt' ? 'Precisa de você' : 'Needs you' })]} roleOf={() => 'leader'} /></MemoryRouter>))
      expect(html).toContain(HARNESS_LABELS.claude)
      expect(html).not.toContain('>claude<')
      expect(html).toContain('color:var(--anthropic-orange)')
    }
  })
  test('check-in empty state requires a successful load', () => {
    const render = (reports: CheckinState[] | null, error = false) => atWidth(width, () => renderToStaticMarkup(<CheckinsContent lang="pt" reports={reports} rows={[]} error={error} />))
    expect(render([])).toContain('Nenhuma rodada de check-in registrada ainda.')
    expect(render(null)).toContain('Carregando rodadas…')
    expect(render(null, true)).not.toContain('Nenhuma rodada')
  })
  test('away never claims present before the store has answered and keeps activation dialog reachable', () => {
    try {
      __setAwayForTest(null)
      const render = () => atWidth(width, () => renderToStaticMarkup(<AwayContent lang="pt" capable />))
      expect(render()).toContain('Carregando modo ausente…')
      expect(render()).not.toContain('Você está presente.')
      __setAwayForTest(AWAY_OFF)
      expect(render()).toContain('Você está presente.')
      expect(render()).toContain('Estou fora (dormindo, viajando)')
      const switchRow = render().split('role="switch"')[1]!.split('</button>')[0]!
      expect(switchRow).toContain('white-space:normal')
      expect(switchRow).not.toContain('text-overflow:ellipsis')
      __setAwayForTest({ ...AWAY_OFF, on: true })
      expect(render().match(/até você voltar/g)).toHaveLength(1)
      expect(render()).not.toContain('>Disponibilidade<')
      expect(render()).not.toContain('text-transform:uppercase')
      expect(render()).toContain('font-size:13px;color:var(--text-secondary)')
    } finally { __setAwayForTest(null) }
  })
})
