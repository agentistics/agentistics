import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Children, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckinPanel, CheckinRoundSections, SessionLinkInfo, SessionLinkPanel, linkTargets } from './SessionLinkInfo'
import type { CheckinRound } from '../../lib/checkin'
import { closeCheckinModal, readCheckinModalRequest } from '../../lib/checkinModal'
import { sessionPath } from '../../lib/sessionRoute'
import type { SessionLinks } from '../../lib/sessionParent'

const links: SessionLinks = {
  parent: { id: 'p1', title: 'Leader', openable: true },
  children: [{ id: 'c1', title: 'Kid', harness: 'codex', state: 'waiting' }],
  task: { id: 't1', label: 'Fix it' },
}

describe('SessionLinkInfo', () => {
  it('is absent when the session has no link', () => {
    expect(renderToStaticMarkup(<SessionLinkInfo session={{}} links={null} lang="en" onGo={() => {}} />)).toBe('')
  })
  it('keeps the type info control available without links', () => {
    const html = renderToStaticMarkup(<SessionLinkInfo session={{ id: 'unfiled' }} links={null} lang="en" onGo={() => {}} />)
    expect(html).toContain('data-testid="session-link-info"')
  })
  it('is present, closed, with an aria-label when linked', () => {
    const html = renderToStaticMarkup(<SessionLinkInfo session={{}} links={links} lang="pt" onGo={() => {}} />)
    expect(html).toContain('data-testid="session-link-info"')
    expect(html).toContain('aria-label="Vínculos desta sessão"')
    expect(html).not.toContain('session-link-panel')
  })
  it('targets navigate to the session / task routes; a gone parent is not a link', () => {
    const t = linkTargets(links)
    expect(t.map(x => x.path)).toEqual([sessionPath('p1'), sessionPath('c1'), '/tasks/t1'])
    expect(linkTargets({ ...links, parent: { id: 'gone', openable: false } })[0]!.path).toBeNull()
  })
  it('the panel lists parent, child, task and the start time as buttons', () => {
    const html = renderToStaticMarkup(<SessionLinkPanel links={links} startedAt={Date.UTC(2026, 9, 1, 12)} pt={false} onGo={() => {}} />)
    for (const k of ['parent', 'child', 'task']) expect(html).toContain(`data-link-kind="${k}"`)
    expect(html).toContain('Leader')
    expect(html).toContain('Fix it')
    expect(html).toContain('Started')
    expect(html).toContain('<button')
  })
  it('keeps the type control inside the panel without a portalled role menu', () => {
    const html = renderToStaticMarkup(<SessionLinkPanel links={links} sessionId="session-1" pt={false} onGo={() => {}} />)
    expect(html).toContain('data-testid="session-link-panel"')
    expect(html).toContain('Change type')
    expect(html).not.toContain('role="menu"')
    expect(html).not.toContain('session-role:leader')
  })
  it('gives the type control a 44 px touch target on mobile', () => {
    const html = renderToStaticMarkup(<SessionLinkPanel links={links} sessionId="session-1" pt={false} onGo={() => {}} isMobile />)
    const button = html.match(/<button[^>]*aria-label="Change type"[^>]*>/)?.[0] ?? ''
    expect(button).toContain('min-height:44px')
  })
})

describe('structured check-in sections', () => {
  // RailSection reads viewport width during SSR; effects and DOM listeners do not run.
  const env = globalThis as unknown as { window?: { innerWidth: number } }
  const previousWindow = env.window
  beforeAll(() => { env.window = { innerWidth: 1280 } })
  afterAll(() => { if (previousWindow === undefined) delete env.window; else env.window = previousWindow })
  const round: CheckinRound = {
    state: 'ok', summary: 'fallback', headline: 'Headline',
    needs: [{ subject: 'Review', text: 'Please review' }],
    delivered: [{ text: 'Shipped the modal' }, { text: 'Added tests' }],
    inProgress: [{ item: 'QA', stage: 'review' }],
    next: [{ text: 'Deploy', when: 'tomorrow' }],
    health: [{ label: 'MCP', value: 'online', state: 'ok' }],
  }

  it('renders every non-empty section and its count', () => {
    const html = renderToStaticMarkup(<CheckinRoundSections round={round} pt={false} />)
    for (const label of ['Needs you', 'Delivered last', 'In development', 'Next steps', 'Health']) expect(html).toContain(label)
    expect(html).toContain('>2<')
  })
  it('opens the needs section by default and hides empty sections', () => {
    const html = renderToStaticMarkup(<CheckinRoundSections round={{ state: 'ok', summary: 'Legacy', needs: round.needs }} pt={false} />)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Needs you')
    expect(html).not.toContain('Delivered last')
    expect(html).not.toContain('In development')
  })
  it.each([false, true])('"Open larger" asks the standalone check-in modal for this session (mobile=%s)', isMobile => {
    env.window!.innerWidth = isMobile ? 390 : 1280
    let click: (() => void) | undefined
    function Panel() {
      const tree = CheckinPanel({ state: { session: 'leader', paused: null, intervalMin: 30, checklist: [], nextRunAt: 1, lastRunAt: 1, last: round }, pt: false, isMobile, onGo: () => {}, update: async () => {}, runNow: async () => true, taskPath: null })
      function visit(node: ReactNode) {
        Children.forEach(node, child => {
          if (!isValidElement<{ children?: ReactNode; 'data-testid'?: string; onClick?: () => void }>(child)) return
          if (child.props['data-testid'] === 'checkin-open-larger') click = child.props.onClick
          visit(child.props.children)
        })
      }
      visit(tree)
      return tree
    }
    const html = renderToStaticMarkup(<Panel />)
    expect(html).toContain('data-testid="checkin-open-larger"')
    expect(html).not.toContain('data-testid="checkin-modal"')
    closeCheckinModal()
    click!()
    expect(readCheckinModalRequest()).toEqual({ sessionId: 'leader' })
    closeCheckinModal()
  })
  it.each([
    [false, ['Healthy', 'Warning', 'Critical']],
    [true, ['Saudável', 'Atenção', 'Crítico']],
  ] as const)('localizes every health accessibility label (pt=%s)', (pt, labels) => {
    const health = (['ok', 'warn', 'bad'] as const).map(state => ({ label: 'MCP', value: 'online', state }))
    const html = renderToStaticMarkup(<CheckinRoundSections round={{ ...round, health }} pt={pt} expanded />)
    for (const label of labels) expect(html).toContain(`aria-label="${label}"`)
    for (const state of ['ok', 'warn', 'bad']) expect(html).not.toContain(`aria-label="${state}"`)
  })
})

import { STATE_COLOR } from '../../lib/sessionCardStyle'
import { filterByTitle, newestFirst } from '../../lib/sessionParent'

const many: SessionLinks = {
  parent: null, task: null,
  children: [
    { id: 'a', title: 'Old running', harness: 'claude', state: 'working', stateLabel: 'trabalhando', startedAt: 1000 },
    { id: 'b', title: 'Ação nova', harness: 'claude', state: 'waiting', startedAt: 3000 },
    { id: 'c', title: 'Dead one', harness: 'claude', state: 'exited', startedAt: 2000 },
  ],
}

describe('link popover polish', () => {
  it('orders newest first', () => {
    expect(newestFirst(many.children).map(c => c.id)).toEqual(['b', 'c', 'a'])
    expect(linkTargets(many).map(t => t.key)).toEqual(['c:b', 'c:c', 'c:a'])
  })
  it('splits running from a collapsed ended group', () => {
    const html = renderToStaticMarkup(<SessionLinkPanel links={many} pt={false} onGo={() => {}} />)
    expect(html).toContain('Ended (1)')
    expect(html).toContain('Ação nova')
    expect(html).not.toContain('Dead one')
    expect(html.indexOf('Ação nova')).toBeLessThan(html.indexOf('Old running'))
    expect(renderToStaticMarkup(<SessionLinkPanel links={many} pt onGo={() => {}} />)).toContain('Encerradas (1)')
  })
  it('colours the state word from STATE_COLOR, text only', () => {
    const html = renderToStaticMarkup(<SessionLinkPanel links={many} pt={false} onGo={() => {}} />)
    expect(html).toContain(`color:${STATE_COLOR.working}`)
    expect(html).toContain(`color:${STATE_COLOR.waiting}`)
  })
  it('filters by title ignoring case and accents', () => {
    expect(filterByTitle(many.children, 'ACAO').map(c => c.id)).toEqual(['b'])
    expect(filterByTitle(many.children, '').length).toBe(3)
  })
  it('has a search toggle that is closed by default', () => {
    const html = renderToStaticMarkup(<SessionLinkPanel links={many} pt={false} onGo={() => {}} />)
    expect(html).toContain('data-testid="link-search-toggle"')
    expect(html).not.toContain('data-testid="link-search"')
  })
})

describe('link row meta', () => {
  it('shows the localized state label and a harness icon, not raw ids or the harness name text', () => {
    const html = renderToStaticMarkup(<SessionLinkPanel links={many} pt onGo={() => {}} />)
    expect(html).toContain('trabalhando')
    expect(html).toContain('aria-label="Claude Code"')
    expect(html).not.toContain('>Claude Code<')
  })
})

describe('per-session away switch', () => {
  const none: SessionLinks = { parent: null, children: [], task: null }
  it('appears only for a managed row, as the one ToggleSwitch, reflecting the flag', () => {
    const off = renderToStaticMarkup(<SessionLinkPanel links={none} sessionId="s1" pt={false} onGo={() => {}} awayId="s1" />)
    expect(off).toContain('data-testid="session-away-row"')
    expect(off).toContain('role="switch"')
    expect(off).toContain('aria-checked="false"')
    const on = renderToStaticMarkup(<SessionLinkPanel links={none} sessionId="s1" pt onGo={() => {}} awayId="s1" away />)
    expect(on).toContain('aria-checked="true"')
    expect(on).toContain('Modo ausente nesta sessão')
    expect(renderToStaticMarkup(<SessionLinkPanel links={none} sessionId="s1" pt={false} onGo={() => {}} />)).not.toContain('session-away-row')
  })
})

describe('per-session away switch under the GLOBAL away mode (HERANÇA)', () => {
  const none: SessionLinks = { parent: null, children: [], task: null }
  it('reads ON, names the global as the source and is locked, whatever the session flag says', async () => {
    const { __setAwayForTest } = await import('../../lib/awayMode')
    __setAwayForTest({ on: true, since: '2026-10-25T00:00:00Z', until: null, authorised: [], maxWorkers: 6, topCaps: {} } as never)
    try {
      const html = renderToStaticMarkup(<SessionLinkPanel links={none} sessionId="s1" pt onGo={() => {}} awayId="s1" />)
      expect(html).toContain('aria-checked="true"')
      expect(html).toContain('ligado pelo modo ausente geral')
      expect(html).toContain('data-away-source="global"')
      expect(html).toContain('disabled')
    } finally { __setAwayForTest(null) }
  })
})

describe('hand-off generation in the ⓘ panel', () => {
  const links = { parent: null, children: [], task: null }
  it('shows the counter (EN and PT) and nothing when never handed off', () => {
    expect(renderToStaticMarkup(<SessionLinkPanel links={links} handoffSeq={47} pt={false} onGo={() => {}} />)).toContain('Session 47 (leader hand-off)')
    expect(renderToStaticMarkup(<SessionLinkPanel links={links} handoffSeq={47} pt onGo={() => {}} />)).toContain('Sessão 47 (passagem de líder)')
    expect(renderToStaticMarkup(<SessionLinkPanel links={links} pt={false} onGo={() => {}} />)).not.toContain('handoff-generation')
  })
})
