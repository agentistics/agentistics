import { describe, expect, test } from 'bun:test'
import { personQueuedCount, queuedBubbleActions, sendNowPillOffered, strandedCards, visibleQueued } from './queuedCards'

describe('sendNowPillOffered — one "Send now" per waiting message', () => {
  test('a single waiting message is served by the button inside it, so the pill stays away', () => {
    expect(sendNowPillOffered(true, 1)).toBe(false)
  })
  test('with two or more waiting messages the pill sends the whole queue', () => {
    expect(sendNowPillOffered(true, 2)).toBe(true)
    expect(sendNowPillOffered(true, 5)).toBe(true)
  })
  test('never offered where send-now itself is not shown (any harness, any width)', () => {
    expect(sendNowPillOffered(false, 3)).toBe(false)
  })
})

describe('queuedBubbleActions (FLUXO.AVISOS 10)', () => {
  const base = { text: 'corrige a coluna', harness: 'claude', working: true, dialogOpen: false, personQueued: 1, sendNowRunning: false, stopEnabled: true, pt: false }
  test('claude, mid-turn: both actions, in the reader\'s language', () => {
    const a = queuedBubbleActions(base)
    expect(a.sendNow?.label).toBe('Send now')
    expect(a.interrupt?.label).toBe('Interrupt')
    expect(queuedBubbleActions({ ...base, pt: true }).sendNow?.label).toBe('Enviar agora')
    expect(queuedBubbleActions({ ...base, pt: true }).interrupt?.label).toBe('Interromper')
  })
  test('with two or more waiting messages the balloons carry no send-now link: the pill under the conversation is the one control', () => {
    for (const personQueued of [2, 3, 5]) {
      expect(queuedBubbleActions({ ...base, personQueued }).sendNow).toBeNull()
    }
    expect(queuedBubbleActions({ ...base, personQueued: 3 }).interrupt).not.toBeNull()
  })
  test('with exactly one waiting message the link inside the balloon says it sends this message', () => {
    expect(queuedBubbleActions(base).sendNow?.hint).toContain('this message')
    expect(queuedBubbleActions({ ...base, pt: true }).sendNow?.hint).toContain('esta mensagem')
  })
  test('a harness with no measured send-now keystroke gets Interrupt only (when its stop verb works), never Send now', () => {
    for (const harness of ['codex', 'gemini', 'copilot', 'kimi', 'antigravity', 'opencode']) {
      const a = queuedBubbleActions({ ...base, harness })
      expect(a.sendNow).toBeNull()
      expect(a.interrupt).not.toBeNull()
      expect(queuedBubbleActions({ ...base, harness, stopEnabled: false })).toEqual({ sendNow: null, interrupt: null })
    }
  })
  test('hidden when it cannot work: idle session, a dialog open, a send-now already running', () => {
    expect(queuedBubbleActions({ ...base, working: false })).toEqual({ sendNow: null, interrupt: null })
    expect(queuedBubbleActions({ ...base, dialogOpen: true })).toEqual({ sendNow: null, interrupt: null })
    expect(queuedBubbleActions({ ...base, sendNowRunning: true }).sendNow).toBeNull()
    expect(queuedBubbleActions({ ...base, stopEnabled: false }).interrupt).toBeNull()
    expect(queuedBubbleActions({ ...base, stopEnabled: false }).sendNow).not.toBeNull()
  })
  test('a system notice in the queue offers nothing (it is not the person\'s message)', () => {
    for (const text of ['[from session ab12 · block]\nblocked', '[from agentistics · away]\naway', 'Run the leadership check-in now.']) {
      expect(queuedBubbleActions({ ...base, text })).toEqual({ sendNow: null, interrupt: null })
    }
    expect(queuedBubbleActions({ ...base, text: 'plain words' }).sendNow).not.toBeNull()
  })
})

const q = [{ text: 'hello there', at: 1 }]

describe('visibleQueued', () => {
  test('pending + transcript not loaded -> no cards', () => {
    expect(visibleQueued(q, [], false)).toEqual([])
  })
  test('loaded and the turn is present -> no cards', () => {
    expect(visibleQueued(q, ['hello there'], true)).toEqual([])
  })
  test('loaded without the turn -> card shows', () => {
    expect(visibleQueued(q, ['other'], true)).toEqual(q)
  })
  test('fresh echo after load shows', () => {
    expect(visibleQueued([{ text: 'new one' }], [], true)).toEqual([{ text: 'new one' }])
  })
  test('delivered ones are dropped', () => {
    expect(visibleQueued(q, [], true, new Set(['hello there']))).toEqual([])
  })
})

import { shouldRestoreDraft } from './queuedCards'
describe('shouldRestoreDraft', () => {
  test('send failure with no server copy -> text kept', () => {
    expect(shouldRestoreDraft([], 'x')).toBe(true)
    expect(shouldRestoreDraft(undefined, 'x')).toBe(true)
  })
  test('failure but the server already holds it -> composer stays empty', () => {
    expect(shouldRestoreDraft([{ text: 'x' }], 'x')).toBe(false)
  })
})

describe('visibleQueued local echoes', () => {
  test('a local echo shows before the transcript loads; a server copy does not', () => {
    const q = [{ text: 'mine' }, { text: 'old' }]
    expect(visibleQueued(q, [], false, new Set(), new Set(['mine']))).toEqual([{ text: 'mine' }])
  })
})

describe('visibleQueued restored echoes', () => {
  test('an echo restored from storage (not sent in this mount) waits for the transcript like a server copy', () => {
    const q = [{ text: 'sent earlier, maybe consumed' }, { text: 'sent now' }]
    expect(visibleQueued(q, [], false, new Set(), new Set(['sent now']))).toEqual([{ text: 'sent now' }])
    expect(visibleQueued(q, ['sent earlier, maybe consumed'], true, new Set(), new Set(['sent now']))).toEqual([{ text: 'sent now' }])
  })
})


describe('personQueuedCount', () => {
  const notice = { text: '[from session ab12 · handback]\nready', at: 1 }
  test('system notices stay visible but never offer send-now', () => {
    const queued = visibleQueued([notice], [], true)
    expect(queued).toEqual([notice])
    expect(personQueuedCount(queued)).toBe(0)
  })
  test('mixed queues count only the person’s messages', () => {
    expect(personQueuedCount([notice, { text: 'Please review' }, { text: 'Then publish' }])).toBe(2)
  })
  test('ordinary messages and mentions retain their count', () => {
    expect(personQueuedCount([{ text: 'hello' }, { text: 'Explain [from session ab12 · handback]' }])).toBe(2)
    expect(personQueuedCount([])).toBe(0)
  })
  test('wrapped and other recognized notices are excluded', () => {
    expect(personQueuedCount([
      { text: '<pasted_content id="q">\n[from session ab12 · handback]\nready\n</pasted_content id="q">' },
      { text: '[from session ab12 · block]\nblocked' },
      { text: '[from agentistics · away]\naway' },
      { text: 'Run the leadership check-in now.' },
    ])).toBe(0)
  })
})

describe('strandedCards — what a killed session never read (MENSAGENS.KILL)', () => {
  const srv = [{ text: 'run the migration', at: 1 }, { text: 'and then deploy', at: 2 }]
  test('a running session offers nothing: its waiting messages are the queue', () => {
    expect(strandedCards({ ended: false, stranded: srv, queued: [{ text: 'x' }], draft: '' })).toEqual([])
  })
  test('after the kill the server list is offered in the order it was sent', () => {
    expect(strandedCards({ ended: true, stranded: [srv[1]!, srv[0]!], queued: [], draft: '' }).map(c => c.text))
      .toEqual(['run the migration', 'and then deploy'])
  })
  test('the tab\'s own echoes are offered too, once, when the server has no copy (any harness)', () => {
    const out = strandedCards({ ended: true, stranded: [srv[0]!], queued: [{ text: 'run the migration' }, { text: 'local only' }], draft: '' })
    expect(out.map(c => c.text)).toEqual(['run the migration', 'local only'])
  })
  test('a message already put back in the composer is not offered a second time', () => {
    const out = strandedCards({ ended: true, stranded: srv, queued: [], draft: 'run the migration\n\n' })
    expect(out.map(c => c.text)).toEqual(['and then deploy'])
  })
})
