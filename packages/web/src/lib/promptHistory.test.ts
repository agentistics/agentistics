import { test, expect } from 'bun:test'
import {
  anchorIsLoaded, buildPromptList, echoAnchorId, filterPrompts, hashText, normalizeSearch,
  promptPreview, restoreVerdict, sendNowHint, sendNowLabel, sendNowShown, tailFollows,
  turnAnchorIds,
} from './promptHistory'

const user = (text: string, at?: string) => ({ role: 'user' as const, text, ...(at ? { at } : {}) })
const bot = (text: string, at?: string) => ({ role: 'assistant' as const, text, ...(at ? { at } : {}) })

test('an anchor survives an older turn falling out of the window', () => {
  const full = [user('a', '2026-01-01T10:00:00Z'), bot('r1', '2026-01-01T10:01:00Z'), user('b', '2026-01-01T10:02:00Z')]
  const trimmed = full.slice(1)
  const before = turnAnchorIds('s1', full)
  const after = turnAnchorIds('s1', trimmed)
  expect(after[1]).toBe(before[2]!)
  expect(after[0]).toBe(before[1]!)
})

test('anchors are unique, and identical turns with no timestamp are told apart from the newest', () => {
  const turns = [user('continue'), bot('ok'), user('continue')]
  const ids = turnAnchorIds('s1', turns)
  expect(new Set(ids).size).toBe(3)
  // The newest `continue` keeps its id when an older repeat is trimmed off the front.
  expect(turnAnchorIds('s1', turns.slice(1))[1]).toBe(ids[2]!)
})

test('anchors are namespaced by session, and ids need no escaping', () => {
  const a = turnAnchorIds('s1', [user('x', '2026-01-01T10:00:00.123Z')])[0]!
  const b = turnAnchorIds('s2', [user('x', '2026-01-01T10:00:00.123Z')])[0]!
  expect(a).not.toBe(b)
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(echoAnchorId('s1', 'x')).not.toBe(echoAnchorId('s2', 'x'))
})

test('the list is newest first, echoes lead, and only real messages are listed', () => {
  const turns = [
    user('one', '2026-01-01T10:00:00Z'), bot('r'),
    { role: 'user' as const, text: 'reminder', system: 'system reminder' },
    { role: 'user' as const, text: 'done', task: { label: 'b', running: false } },
    user('  '),
    user('two', '2026-01-01T10:05:00Z'),
  ]
  const list = buildPromptList('s1', turns, [{ text: 'queued a', at: 5 }, { text: 'queued b' }])
  expect(list.map(e => e.text)).toEqual(['queued b', 'queued a', 'two', 'one'])
  expect(list[0]!.latest).toBe(true)
  expect(list.filter(e => e.latest)).toHaveLength(1)
  expect(list[0]!.kind).toBe('echo')
  expect(list[1]!.atMs).toBe(5)
  expect(list[2]!.at).toBe('2026-01-01T10:05:00Z')
})

test('occurrence counts identical texts from the latest, echoes excluded', () => {
  const turns = [user('go'), bot('a'), user('go'), bot('b'), user('other'), user('go')]
  const list = buildPromptList('s1', turns, [{ text: 'go' }])
  const turnGo = list.filter(e => e.kind === 'turn' && e.text === 'go').map(e => e.occurrence)
  expect(turnGo).toEqual([0, 1, 2])
  expect(list[0]!.occurrence).toBeNull()
})

test('search ignores case and diacritics and also finds attachment names', () => {
  const list = buildPromptList('s1', [
    user('Corrigir a AÇÃO do botão'),
    user('/home/x/.agentistics/attachments/print-final.png\nolha isto'),
  ])
  expect(filterPrompts(list, 'acao').map(e => e.text)).toEqual(['Corrigir a AÇÃO do botão'])
  expect(filterPrompts(list, 'PRINT-final')).toHaveLength(1)
  expect(filterPrompts(list, '  ')).toHaveLength(2)
  expect(filterPrompts(list, 'nada disso')).toHaveLength(0)
  expect(normalizeSearch('  Ação\n  X ')).toBe('acao x')
})

test('a preview is the words only, collapsed and capped', () => {
  expect(promptPreview('/a/.agentistics/attachments/p.png\nhello\n\n  world')).toBe('hello world')
  expect(promptPreview('x'.repeat(500), 10)).toHaveLength(10)
})

test('anchorIsLoaded is false once the turn has left the window', () => {
  const turns = [user('a', 't1'), user('b', 't2')]
  const anchor = turnAnchorIds('s', turns)[0]!
  expect(anchorIsLoaded(anchor, 's', turns, [])).toBe(true)
  expect(anchorIsLoaded(anchor, 's', turns.slice(1), [])).toBe(false)
  expect(anchorIsLoaded(echoAnchorId('s', 'q'), 's', [], [{ text: 'q' }])).toBe(true)
})

test('restore is absent off claude, and disabled with a reason where it cannot work', () => {
  const base = { harness: 'claude', state: 'working', dialogOpen: false, entryKind: 'turn' as const }
  expect(restoreVerdict(base).state).toBe('ok')
  expect(restoreVerdict({ ...base, harness: 'codex' }).state).toBe('hidden')
  expect(restoreVerdict({ ...base, state: 'lost' })).toMatchObject({ state: 'off' })
  expect(restoreVerdict({ ...base, dialogOpen: true }).reason?.en).toContain('question')
  expect(restoreVerdict({ ...base, entryKind: 'echo' }).state).toBe('off')
})

test('send now shows only for a working claude session with something queued and no dialog', () => {
  const on = { harness: 'claude', working: true, queuedCount: 1, dialogOpen: false }
  expect(sendNowShown(on)).toBe(true)
  expect(sendNowShown({ ...on, working: false })).toBe(false)
  expect(sendNowShown({ ...on, queuedCount: 0 })).toBe(false)
  expect(sendNowShown({ ...on, harness: 'gemini' })).toBe(false)
  expect(sendNowShown({ ...on, dialogOpen: true })).toBe(false)
})

test('send now says it sends the whole queue when there is more than one message', () => {
  expect(sendNowLabel(1, false)).toBe('Send now')
  expect(sendNowLabel(2, true)).toBe('Enviar agora (2)')
  expect(sendNowHint(2, true)).toContain('2 mensagens da fila')
  expect(sendNowHint(3, false)).toContain('all 3')
})

test('the tail is not followed during the hold after a jump', () => {
  expect(tailFollows(true, 1000, 999)).toBe(false)
  expect(tailFollows(true, 1000, 1000)).toBe(true)
  expect(tailFollows(false, 0, 5000)).toBe(false)
})

test('hashText is stable and discriminating', () => {
  expect(hashText('abc')).toBe(hashText('abc'))
  expect(hashText('abc')).not.toBe(hashText('abd'))
})
