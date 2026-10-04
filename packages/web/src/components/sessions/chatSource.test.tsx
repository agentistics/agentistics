/**
 * THE SEAM (UI.UNIFY): the standard `SessionChat`, handed a `ChatSource`, draws the source's
 * conversation inside its OWN shell — the same composer every harness gets — plus the two slots.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { SessionChat } from './SessionChat'
import type { ChatSource } from './chatSource'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

// Render-to-string only: `useIsMobile` reads `window.innerWidth` in an initializer, effects never run
// (the RepoSearchView.test.tsx pattern) — and the window this file made is removed when it is done.
const env = globalThis as unknown as { window?: unknown }
const windowIsOurs = env.window === undefined
env.window ??= { innerWidth: 1280, location: { protocol: 'http:', hostname: 'localhost' } }
afterAll(() => { if (windowIsOurs) delete env.window })

const SID = 'ses_' + 'a'.repeat(32)
const session = {
  id: SID, title: 'Fix the parser', harness: 'agentistics', cwd: '/w', project: 'w', state: 'working', stateLabel: 'working',
  actionable: true, attached: false, conversationId: SID,
  searchFields: { name: '', folder: '', harness: '', note: '', task: '', prompt: '' },
} as ControlSession
const noAct = async () => ({ ok: true, message: '' })

function render(source?: ChatSource): string {
  return renderToStaticMarkup(
    <MemoryRouter><SessionChat session={session} lang="en" act={noAct} {...(source ? { source } : {})} /></MemoryRouter>,
  )
}

describe('SessionChat with a ChatSource', () => {
  test('the source\'s turns, live text and slots render inside the standard composer shell', () => {
    const html = render({
      turns: [{ role: 'user', text: 'please fix it' }, { role: 'assistant', text: 'on it' }],
      working: true, liveText: 'streaming words', act: noAct, canStop: true,
      approvals: <div data-testid="slot-approval">ask</div>,
      status: <div data-testid="slot-status">run line</div>,
    })
    expect(html).toContain('please fix it')
    expect(html).toContain('on it')
    expect(html).toContain('streaming words')
    expect(html).toContain('slot-approval')
    expect(html).toContain('slot-status')
    // The standard composer, not a second one: the field and its toolbar's attach control.
    expect(html).toContain('<textarea')
    expect(html).toContain('Attach file')
  })
  test('a source still reading shows the chat\'s own loading state, never an empty conversation', () => {
    const html = render({ turns: null, working: false, liveText: null, act: noAct, canStop: false })
    expect(html).not.toContain('please fix it')
  })
  test('no source: the CLI path — no source slots, no source turns, the transcript feed decides', () => {
    const html = render()
    expect(html).not.toContain('slot-approval')
    expect(html).not.toContain('streaming words')
  })
})
