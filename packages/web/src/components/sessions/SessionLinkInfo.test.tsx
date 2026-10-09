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
