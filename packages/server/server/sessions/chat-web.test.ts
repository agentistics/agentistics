/**
 * chat-web.test.ts — "not YET" against "no LONGER", which is the whole usability of a new session.
 *
 * A harness writes its transcript when the conversation first says something, so a session agentop
 * has just started has no file on disk for as long as nobody has spoken to it. Reporting that as
 * `unavailable` made the chat view draw its refusal INSTEAD of the composer — so the one act that
 * would create the transcript, sending the first message, was the one act the view withheld, and a
 * session created from the workspace stayed un-chattable for its whole life.
 */

import { describe, it, test, expect } from 'bun:test'
import { processLinkNote, readSessionChat } from './chat-web'
import { pendingFor, recordPrompt, resetPrompts } from './pending-prompts'

/** A cwd that is not a project on any machine, so no transcript can ever resolve for it. */
const NO_PROJECT = '/nonexistent/agentistics-chat-web-test'

function hostWith(state: string, harness = 'claude') {
  const row = {
    id: 'sess1',
    harness,
    cwd: NO_PROJECT,
    conversationId: '00000000-0000-4000-8000-000000000000',
    state,
  }
  return { sessions: async () => ({ sessions: [row] }) } as never
}

test('a RUNNING session with no transcript yet is an EMPTY conversation, not an unavailable one', async () => {
  const out = await readSessionChat(hostWith('waiting'), 'en', 'sess1')
  expect(out.turns).toEqual([])
  expect(out.live).toBe(true)
  // The absence of `unavailable` is what lets the composer render — it is the assertion that matters.
  expect(out.unavailable).toBeUndefined()
})

test('a working session is treated the same — it has simply not spoken yet', async () => {
  const out = await readSessionChat(hostWith('working'), 'pt', 'sess1')
  expect(out.unavailable).toBeUndefined()
  expect(out.live).toBe(true)
})

test('an unlinked approval carries its question and options into the chat payload', async () => {
  const host = {
    sessions: async () => ({ sessions: [{
      id: 'sess1', harness: 'antigravity', cwd: NO_PROJECT, state: 'waiting-approval',
      approvalLines: ['Do you trust this folder?', '❯ 1. Yes, I trust this folder', '  2. No, exit'],
      dialogOptions: [
        { number: 1, label: 'Yes, I trust this folder', selected: true },
        { number: 2, label: 'No, exit', selected: false },
      ],
    }] }),
  } as never
  const out = await readSessionChat(host, 'en', 'sess1')
  expect(out.unavailable).toBeUndefined()
  expect(out.approvalLines).toEqual(['Do you trust this folder?', '❯ 1. Yes, I trust this folder', '  2. No, exit'])
  expect(out.dialogOptions?.map(o => o.label)).toEqual(['Yes, I trust this folder', 'No, exit'])
})

test('a session that is NOT running keeps the refusal — there the transcript is genuinely gone', async () => {
  const out = await readSessionChat(hostWith('exited'), 'en', 'sess1')
  expect(out.live).toBe(false)
  expect(out.unavailable).toContain('no longer on this machine')
  expect(out.transcript?.state).toBe('deleted')
})

test('an unknown id still reports that the session left this machine, never an empty chat', async () => {
  const out = await readSessionChat(hostWith('waiting'), 'en', 'other')
  expect(out.unavailable).toBeTruthy()
})

/**
 * The SECOND limit — the transcript FORMAT, which used to be tangled up with the first one.
 *
 * Measured 2026-09-05 on a live antigravity session carrying a perfectly exact conversation link
 * (`/proc/<pid>/cmdline` was `agy --conversation 01d0814f-…`): the request ran into the Claude-only
 * path resolver, found nothing, took the live branch above and answered `{turns: [], live: true}`.
 * `SessionChat.tsx` draws "no messages yet" only when `live === null`, so the result was a blank
 * pane with no sentence on it. The link was never the problem; there was no reader.
 */
test('a harness nobody has written a reader for is refused in words, and NAMED', async () => {
  // NO SHIPPED HARNESS EXERCISES THIS TODAY — gemini was the last `null` and now has a reader —
  // and the path must stay tested regardless: it is what the NEXT harness falls into on the day
  // its id is added and its reader is not. The cast is the point of the test, not a shortcut
  // around the types: it stands in for that harness. Deleting this with the last null would leave
  // the blank-pane defect this whole refusal exists to prevent untested until it recurred.
  const out = await readSessionChat(hostWith('waiting', 'quokka' as never), 'en', 'sess1')
  expect(out.turns).toEqual([])
  expect(out.unavailable).toContain('quokka')
})

test('a harness that HAS a reader falls through to the transcript rules, not to that refusal', async () => {
  // Each of these resolves against its own store, where this id does not exist — so it must land
  // on the live/not-yet branch, exactly as claude does, and NOT on "no reader". This test is what
  // failed when codex gained a reader, which is the point: adding one is visible here.
  for (const harness of ['antigravity', 'codex', 'copilot', 'kimi', 'gemini'] as const) {
    const out = await readSessionChat(hostWith('waiting', harness), 'en', 'sess1')
    expect(out.unavailable).toBeUndefined()
    expect(out.live).toBe(true)
  }
})

test('a row whose harness the registry has forgotten says THAT, not "we cannot read \'\'"', async () => {
  const out = await readSessionChat(hostWith('waiting', ''), 'en', 'sess1')
  expect(out.unavailable).toContain('which assistant')
})

/**
 * THE LAST STEP AT WHICH A BLANK PANE WAS STILL POSSIBLE.
 *
 * The link and the format are refused in words above. A transcript that RESOLVED and then failed to
 * read was not: the catch flattened it into `turns: []`, and on a live session that carries no
 * `unavailable` — so the view drew "This conversation has no messages yet" over a conversation that
 * was entirely on disk. Reported 2026-09-08, reached through the stale path memo (fixed in
 * `transcript-path-memo.ts`); this is the guard that makes the NEXT cause say something.
 */
test('a transcript that resolves but cannot be READ is refused in words, never as an empty chat', async () => {
  const brokenReader = () => ({
    resolve: async () => '/some/found/transcript.jsonl',
    read: async () => { throw new Error('EISDIR') },
    readRecent: async () => ({ turns: [], older: false }),
  })
  const out = await readSessionChat(hostWith('waiting'), 'en', 'sess1', brokenReader as never)
  expect(out.turns).toEqual([])
  expect(out.live).toBe(true)
  expect(out.unavailable).toContain('could not be read')
})

test('a reader that resolves and reads fine still carries no refusal', async () => {
  // The guard must not fire on the ordinary path: an empty conversation stays empty and keeps the
  // composer, which is what the first test in this file exists to protect.
  const okReader = () => ({
    resolve: async () => '/some/found/transcript.jsonl',
    read: async () => ({ turns: [], older: false }),
    readRecent: async () => ({ turns: [], older: false }),
  })
  const out = await readSessionChat(hostWith('waiting'), 'en', 'sess1', okReader as never)
  expect(out.unavailable).toBeUndefined()
})

test('a successful read carries the server\'s REAL attachments directory — the gallery cannot ' +
  'guess a relocated AGENTISTICS_DIR on its own', async () => {
  const { ATTACHMENT_DIR } = await import('./attachment-web')
  const okReader = () => ({
    resolve: async () => '/some/found/transcript.jsonl',
    read: async () => ({ turns: [], older: false }),
    readRecent: async () => ({ turns: [], older: false }),
  })
  const out = await readSessionChat(hostWith('waiting'), 'en', 'sess1', okReader as never)
  expect(out.attachmentsDir).toBe(ATTACHMENT_DIR)
})

/** A row with the fields the availability rule reads, for the cases `hostWith` cannot express. */
function hostWithRow(over: Record<string, unknown>) {
  const row = {
    id: 'sess1', harness: 'claude', cwd: NO_PROJECT,
    conversationId: '00000000-0000-4000-8000-000000000001', state: 'exited', ...over,
  }
  return { sessions: async () => ({ sessions: [row] }) } as never
}

test('a Claude conversation past its retention says it EXPIRED, with the date, instead of "not found"', async () => {
  const out = await readSessionChat(hostWithRow({ endedAt: Date.now() - 45 * 86_400_000 }), 'en', 'sess1')
  expect(out.transcript?.state).toBe('expired')
  expect(out.transcript?.retentionDays).toBeGreaterThan(0)
  expect(out.transcript?.expiredAt).toBeTruthy()
  expect(out.unavailable).toContain('has expired')
  expect(out.unavailable).toContain('Claude Code deletes transcripts')
})

test('a recent Claude conversation with no file is deleted, never expired — the period has not passed', async () => {
  const out = await readSessionChat(hostWithRow({ endedAt: Date.now() - 2 * 86_400_000 }), 'en', 'sess1')
  expect(out.transcript?.state).toBe('deleted')
  expect(out.unavailable).not.toContain('expired')
})

test('an old conversation of a harness with no retention rule is never called expired', async () => {
  const out = await readSessionChat(hostWithRow({ harness: 'antigravity', endedAt: Date.now() - 200 * 86_400_000 }), 'pt', 'sess1')
  expect(out.transcript?.state).toBe('deleted')
})

test('a session waiting on a dialog before it has a conversation keeps the chat actionable', async () => {
  const out = await readSessionChat(
    hostWithRow({ harness: 'antigravity', state: 'waiting-approval', conversationId: undefined }), 'en', 'sess1',
  )
  expect(out.unavailable).toBeUndefined()
  expect(out.live).toBe(true)
})

test('a RUNNING agy session with no conversation yet is an EMPTY chat — the composer is how the first message gets sent', async () => {
  // agy creates its conversation on the first message, so a session started with no prompt has no
  // link until then. The refusal here replaced the composer and left only the terminal.
  const out = await readSessionChat(
    hostWithRow({ harness: 'antigravity', state: 'working', conversationId: undefined }), 'pt', 'sess1',
  )
  expect(out.unavailable).toBeUndefined()
  expect(out.live).toBe(true)
  expect(out.turns).toEqual([])
})

test('CHAT.FIRST: every RUNNING harness with no conversation yet opens an EMPTY chat, never a refusal', async () => {
  for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode']) {
    const out = await readSessionChat(
      hostWithRow({ harness, state: 'waiting', conversationId: undefined, conversationBlind: 'no link ever' }), 'en', 'sess1',
    )
    expect(out.unavailable).toBeUndefined()
    expect(out.live).toBe(true)
    expect(out.turns).toEqual([])
  }
})

test('a RUNNING codex/kimi session with no link yet is an EMPTY chat that still carries its link provenance', async () => {
  // CHAT.FIRST / F0.3: codex and kimi now have an exact route (the process's open transcript), so an
  // unlinked running row is "not linked yet" — the composer stays — rather than v2.112.2's refusal with
  // `link: {provenance: 'unrecoverable', reason: 'no-id-route'}`. The `link` key itself is kept, carrying
  // the row's own value (`null` = linkable, not linked yet), so a reader of the provenance still finds it.
  for (const harness of ['codex', 'kimi']) {
    const out = await readSessionChat(
      hostWithRow({ harness, state: 'waiting', conversationId: undefined, link: null }), 'en', 'sess1',
    )
    expect(out.unavailable).toBeUndefined()
    expect(out.live).toBe(true)
    expect(out.turns).toEqual([])
    expect('link' in out).toBe(true)
    expect(out.link).toBeNull()
  }
})

test('CHAT.FIRST: an ENDED unlinkable harness keeps its sentence — nothing more is coming', async () => {
  const out = await readSessionChat(
    hostWithRow({ harness: 'codex', state: 'exited', conversationId: undefined, conversationBlind: 'no link ever' }), 'en', 'sess1',
  )
  expect(out.unavailable).toBe('no link ever')
})

test('an ENDED agy session with no conversation keeps the refusal — there it is never coming', async () => {
  const out = await readSessionChat(
    hostWithRow({ harness: 'antigravity', state: 'exited', conversationId: undefined }), 'en', 'sess1',
  )
  expect(out.unavailable).toBeTruthy()
})

test('EXT.OPEN: an EXTERNAL row is a running process — its conversation reads as LIVE', async () => {
  const id = 'external:claude:00000000-0000-4000-8000-000000000001'
  const out = await readSessionChat(hostWithRow({ id, state: 'unknown' }), 'en', id)
  expect(out.live).toBe(true)
})

test('CHAT.FIRST: a message sent before the link shows as pending, and moves to the conversation when it lands', async () => {
  resetPrompts()
  recordPrompt('sess1', 'first message')
  const before = await readSessionChat(
    hostWithRow({ harness: 'codex', state: 'waiting', conversationId: undefined, conversationBlind: 'no link ever' }), 'en', 'sess1',
  )
  expect(before.unavailable).toBeUndefined()
  expect(before.pending?.map(p => p.text)).toEqual(['first message'])
  // The link lands: the entry is migrated, held once.
  const conv = '00000000-0000-4000-8000-0000000000aa'
  await readSessionChat(hostWithRow({ harness: 'codex', state: 'waiting', conversationId: conv }), 'en', 'sess1')
  expect(pendingFor('sess1', [])).toEqual([])
  expect(pendingFor(conv, []).map(p => p.text)).toEqual(['first message'])
  resetPrompts()
})

describe('processLinkNote — off Linux, the row says why its link is slower', () => {
  it('is silent on Linux, where the process names the conversation', () => {
    expect(processLinkNote(false, 'linux', 'codex', 'en')).toBeUndefined()
  })

  it('names the harness and the fallback off Linux for codex and kimi', () => {
    for (const h of ['codex', 'kimi'] as const) {
      const en = processLinkNote(false, 'darwin', h, 'en')!
      expect(en).toContain(h)
      expect(en).toContain('only works on Linux')
      expect(processLinkNote(false, 'win32', h, 'pt')).toContain('só funciona no Linux')
    }
  })

  it('is silent for a harness whose process route is its ONLY route — that row is unrecoverable, said elsewhere', () => {
    expect(processLinkNote(true, 'darwin', 'antigravity', 'en')).toBeUndefined()
  })
})
