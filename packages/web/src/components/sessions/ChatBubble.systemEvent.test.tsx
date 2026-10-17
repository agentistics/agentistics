import { roleChangeNote } from '@agentistics/core'
import { closeCheckinModal, readCheckinModalRequest } from '../../lib/checkinModal'
import { afterAll, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as realFleet from '../../lib/fleet'
import { parseSystemEvent } from '../../lib/systemEvent'

const g = globalThis as Record<string, unknown>
g.window ??= { innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }

// A module mock outlives its file: put the real fleet module back so later files do not read the fixture.
const realFleetSnapshot = { ...realFleet }
afterAll(() => { mock.module('../../lib/fleet', () => realFleetSnapshot) })
// Seed the fleet so the sender resolves to a title only through useFleet.
mock.module('../../lib/fleet', () => ({
  ...realFleet,
  useFleet: () => ({ fleet: { rows: [{ id: 'ab12cdef', conversationId: 'c1', title: '[ LEADER ] - Leader Xyzzy' }, { id: 'closed:claude:ended-conversation', conversationId: 'ended-conversation', title: '[ LÍDER ] - Ended Xyzzy', state: 'closed' }] } }),
}))
const { ChatBubble, SystemEventRow } = await import('./ChatBubble')

const turn = (text: string) => ({ role: 'user', text } as never)

test('marked and legacy check-in user turns render collapsed system rows without user chrome', () => {
  for (const opener of ['[from agentistics · check-in]\nFaça o check-in da liderança agora.', 'Faça o check-in da liderança agora.', 'Run the leadership check-in now.']) {
    const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: `${opener}\nxyzzy-checklist-marker`, pending: true }} lang="en" harness="claude" sessionId="leader-id" awaiting awaitingSinceMs={0} />)
    expect(html).toContain('Leadership check-in · system')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Open check-in')
    expect(html).not.toContain('xyzzy-checklist-marker')
    expect(html).not.toContain('Send now')
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('lucide-user')
  }
})

test('expanded check-in row shows the checklist and its localized action', () => {
  const event = parseSystemEvent('[from agentistics · check-in]\nxyzzy-checklist-marker')!
  const html = renderToStaticMarkup(<SystemEventRow event={event} pt defaultOpen />)
  expect(html).toContain('Check-in da liderança · sistema')
  expect(html).toContain('Abrir check-in')
  expect(html).toContain('xyzzy-checklist-marker')
  // an inline line, not a capsule: no radius/fill on the row, the action sits on the same line
  expect(html).not.toContain('border-radius:999px')
  expect(html).toContain('height:1px')
})

test('open check-in asks the standalone modal store for this session', () => {
  closeCheckinModal()
  function Row() {
    const tree = SystemEventRow({ event: { kind: 'checkin', body: 'checklist' }, pt: false, sessionId: 'leader-id' })
    React.Children.forEach(tree.props.children, child => {
      if (React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(child) && child.type === 'button' && child.props.children === 'Open check-in') child.props.onClick!()
    })
    return tree
  }
  renderToStaticMarkup(<Row />)
  expect(readCheckinModalRequest()).toEqual({ sessionId: 'leader-id' })
  closeCheckinModal()
})

test('check-in controls have 44px touch targets at 390px', () => {
  const viewport = window as { innerWidth: number }
  const originalWidth = viewport.innerWidth
  viewport.innerWidth = 390
  try {
    const html = renderToStaticMarkup(<SystemEventRow event={{ kind: 'checkin', body: 'checklist' }} pt={false} />)
    // Two 44px buttons inside a 44px row with no padding and no negative margin: consecutive lines'
    // hit areas sit back to back and never overlap.
    expect(html.match(/<button[^>]*min-height:44px/g)).toHaveLength(2)
    expect(html).toMatch(/min-height:44px;padding:0/)
    expect(html).not.toMatch(/margin:-8px/)
  } finally {
    viewport.innerWidth = originalWidth
  }
})

test('injected away turn renders the event row, not a bubble', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={turn('[from agentistics · away]\nxyzzy-body-marker')} lang="en" harness="claude" />)
  expect(html).toContain('Away mode updated')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('xyzzy-body-marker')
})
test('open row shows body', () => {
  const ev = parseSystemEvent('[from session abc · handback]\nline1\nline2')!
  const html = renderToStaticMarkup(<SystemEventRow event={ev} pt={false} defaultOpen />)
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('line1<br/>\nline2')
})
test('normal user turn is not an event row', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={turn('hello there')} lang="en" harness="claude" />)
  expect(html).not.toContain('aria-expanded')
  expect(html).toContain('hello there')
})
test('handback turn with a sender goes through the fleet row and shows the sender', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={turn('[from session ab12 · handback]\nxyzzy-body-marker')} lang="en" harness="claude" />)
  expect(html).toContain('handed back')
  expect(html).toContain('Leader Xyzzy')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('xyzzy-body-marker')
})

const findButton = (el: React.ReactNode): React.ReactElement<{ onClick: () => void; 'aria-expanded': boolean }> | null => {
  let hit: React.ReactElement<{ onClick: () => void; 'aria-expanded': boolean }> | null = null
  const visit = (n: React.ReactNode) => {
    React.Children.forEach(n, c => {
      if (hit || !React.isValidElement<{ children?: React.ReactNode }>(c)) return
      if (c.type === 'button') { hit = c as never; return }
      visit(c.props.children)
    })
  }
  visit(el)
  return hit
}

test('clicking the chip toggles the body', () => {
  const ev = parseSystemEvent('[from session abc · handback]\nxyzzy-body-marker')!
  let open = false
  let click: (() => void) | undefined
  function Row() {
    const tree = SystemEventRow({ event: ev, pt: false, open, onOpenChange: v => { open = v } })
    click = findButton(tree)?.props.onClick
    return tree
  }
  const closed = renderToStaticMarkup(<Row />)
  expect(closed).toContain('aria-expanded="false"')
  expect(closed).not.toContain('xyzzy-body-marker')
  click!()
  expect(open).toBe(true)
  const opened = renderToStaticMarkup(<Row />)
  expect(opened).toContain('aria-expanded="true"')
  expect(opened).toContain('xyzzy-body-marker')
  click!()
  expect(open).toBe(false)
  const again = renderToStaticMarkup(<Row />)
  expect(again).toContain('aria-expanded="false"')
  expect(again).not.toContain('xyzzy-body-marker')
})


test('role notices use the same system row for every harness', () => {
  for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi'] as const) {
    const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: roleChangeNote('leader'), composer: true }} lang="en" harness={harness} />)
    expect(html).toContain('Session role updated')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('lucide-user')
  }
})

test('a composer-authored message merely mentioning the role notice stays the owner’s', () => {
  const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text: `Please explain this notice: ${roleChangeNote('leader')}`, composer: true }} lang="en" harness="claude" />)
  expect(html).not.toContain('Session role updated')
  expect(html).toContain('your role is now LEADER')
})


test('expanded handback renders markdown, session link and time without repeating the kind', () => {
  const event = parseSystemEvent('[from session ab12 · handback]\n<pasted_content id="outer">\n## Ready\n<pasted_content id="inner">\n- **Checked** `code`\n\n[Details](https://example.com)\n</pasted_content id="inner">\n</pasted_content id="outer">')!
  const html = renderToStaticMarkup(<SystemEventRow event={event} pt={false} titleOf={() => '[ LEADER ] - Review'} senderSessionId="ab12cdef" at="2026-10-17T12:00:00Z" defaultOpen />)
  expect(html).toContain('<h2>Ready</h2>')
  expect(html).toContain('<ul>')
  expect(html).toContain('<strong>Checked</strong>')
  expect(html).toContain('<code>code</code>')
  expect(html).toContain('href="https://example.com"')
  expect(html).toContain('href="/sessions/ab12cdef"')
  expect(html.match(/Task handed back/g)).toHaveLength(1)
  expect(html).toContain('<time')
  expect(html).not.toContain('pasted_content')
  expect(html).not.toContain('[ LEADER ]')
})

test('both chat paths resolve full, short and ended senders, and omit unknown ids', async () => {
  const { MessageBubble } = await import('../HarnessChat')
  for (const [sender, title] of [['ab12cdef', 'Leader Xyzzy'], ['ab12', 'Leader Xyzzy'], ['ended-conv', 'Ended Xyzzy'], ['unknown-id', null]] as const) {
    const content = `[from session ${sender} · handback]\nbody-marker`
    for (const html of [
      renderToStaticMarkup(<ChatBubble turn={turn(content)} lang="pt" harness="claude" />),
      renderToStaticMarkup(<MessageBubble msg={{ role: 'user', content }} harness="claude" pt />),
    ]) {
      expect(html).toContain('Tarefa entregue')
      if (title) expect(html).toContain(` · ${title}`)
      else expect(html).not.toContain(' · ')
      expect(html).not.toContain(sender)
      expect(html).not.toContain('[ LEADER ]')
      expect(html).not.toContain('[ LÍDER ]')
      expect(html).not.toContain('body-marker')
    }
  }
})


test('queued handbacks use the collapsed system row without pending user chrome', () => {
  for (const text of [
    '[from session ab12 · handback]\nqueued-body-marker',
    '<pasted_content id="queued">\n[from session ab12 · handback]\nqueued-body-marker\n</pasted_content id="queued">',
  ]) {
    const html = renderToStaticMarkup(<ChatBubble turn={{ role: 'user', text, pending: true }} sessionId="leader-id" lang="pt" harness="claude" awaiting awaitingWorking awaitingSinceMs={45000} />)
    expect(html).toContain('Tarefa entregue')
    expect(html).toContain(' · Leader Xyzzy')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('queued-body-marker')
    expect(html).not.toContain('lucide-user')
    expect(html).not.toContain('role="status"')
    expect(html).not.toContain('Enviar agora')
  }
})

test('expanded long unbroken URLs inherit wrapping within the notice body', () => {
  const url = `https://example.com/${'a'.repeat(500)}`
  const html = renderToStaticMarkup(<SystemEventRow event={{ kind: 'handback', body: url }} pt={false} defaultOpen />)
  expect(html).toContain(`href="${url}"`)
  expect(html).toContain(`>${url}</a>`)
  expect(html).toContain('overflow-wrap:anywhere')
  expect(html).toContain('min-width:0')
  expect(html).toContain('word-break:break-word')
})
