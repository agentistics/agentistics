import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionLinkInfo, SessionLinkPanel, linkTargets } from './SessionLinkInfo'
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
