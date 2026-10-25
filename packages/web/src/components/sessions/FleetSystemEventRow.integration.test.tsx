import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import * as realFleet from '../../lib/fleet'

// Model the active snapshot followed by a history response, rather than seeding an ended sender.
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
type Sender = { id: string; conversationId: string; title: string; state: string }
let snapshot: { fleet: { rows: Sender[] }; loading: boolean } = { fleet: { rows: [] }, loading: false }
const loadClosedFleet = mock(() => {})
// A module mock outlives its file: put the real fleet module back so later files do not read the fixture.
const realFleetSnapshot = { ...realFleet }
afterAll(() => { mock.module('../../lib/fleet', () => realFleetSnapshot) })
mock.module('../../lib/fleet', () => ({
  ...realFleet,
  useFleet: () => useSyncExternalStore(subscribe, () => snapshot, () => snapshot),
  loadClosedFleet,
}))

let createRoot: typeof import('react-dom/client').createRoot
let ChatBubble: typeof import('./ChatBubble').ChatBubble
let MessageBubble: typeof import('../HarnessChat').MessageBubble
let host: HTMLDivElement
let root: Root

beforeAll(async () => {
  GlobalRegistrator.register({ width: 390, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  ChatBubble = (await import('./ChatBubble')).ChatBubble
  MessageBubble = (await import('../HarnessChat')).MessageBubble
})
afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => {
  snapshot = { fleet: { rows: [] }, loading: false }
  loadClosedFleet.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function publish(rows: Sender[], loading = false) {
  act(() => {
    snapshot = { fleet: { rows }, loading }
    for (const listener of listeners) listener()
  })
}

for (const path of ['session', 'harness'] as const) {
  test(`${path} chat loads an ended sender, updates its title and links to its session`, () => {
    snapshot = { fleet: { rows: [] }, loading: true }
    const content = '[from session ended-conv · handback]\nended-body-marker'
    act(() => root.render(path === 'session'
      ? <ChatBubble turn={{ role: 'user', text: content, at: '2026-10-17T12:00:00Z' }} lang="pt" harness="claude" awaiting awaitingWorking awaitingSinceMs={1000} />
      : <MessageBubble msg={{ role: 'user', content, timestamp: Date.parse('2026-10-17T12:00:00Z') }} harness="claude" pt />))
    expect(loadClosedFleet).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Tarefa entregue')
    expect(host.textContent).not.toContain('ended-conv')
    publish([]) // The active fleet finished loading; the sender exists only in history.
    expect(loadClosedFleet).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('Ended sender')
    publish([{ id: 'closed:claude:ended-conversation', conversationId: 'ended-conversation', title: '[ LÍDER ] - Ended sender', state: 'closed' }])
    expect(host.textContent).toContain('Tarefa entregue · Ended sender')
    expect(host.textContent).not.toContain('[ LÍDER ]')
    expect(host.textContent).not.toContain('ended-body-marker')
    expect(host.textContent).not.toContain('Enviar agora')
    expect(loadClosedFleet).toHaveBeenCalledTimes(1)
    act(() => host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/sessions/closed%3Aclaude%3Aended-conversation')
    expect(host.querySelector('a')?.textContent).toBe('Ended sender')
    expect(host.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-17T12:00:00.000Z')
    expect(host.textContent?.match(/Tarefa entregue/g)).toHaveLength(1)
    expect(host.textContent).toContain('ended-body-marker')
  })
}
