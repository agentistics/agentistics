import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { HARNESS_PROCESS_TRANSCRIPTS } from './harness-session-file'
import {
  codexConversationFromPath, codexTranscriptFromFds, holderCollisions, kimiConversationFromPath,
  kimiTranscriptFromFds,
} from './process-transcript'

// Paths as captured from `/proc/<pid>/fd` of a live codex 0.161.0 and kimi 0.41.0 on 2026-10-08.
const C = '01a11e81-0c02-7cf3-a018-28fb54626ec3'
const C_OTHER = '01a11e4f-3fd6-7442-a59a-274a6216964c'
const ROLLOUT = `/home/mithrandir/.codex/sessions/2026/10/08/rollout-2026-10-08T23-32-16-${C}.jsonl`
const LOCK = `/home/mithrandir/.codex/thread-writer-locks/${C}.lock`
const CODEX_NOISE = [
  '/dev/pts/5', 'pipe:[7969482]', 'anon_inode:[eventpoll]',
  '/home/mithrandir/.codex/logs_2.sqlite', '/home/mithrandir/.codex/logs_2.sqlite-wal',
  '/home/mithrandir/.codex/state_5.sqlite', '/home/mithrandir/.codex/tmp/arg0/codex-arg0qTGrZI/.lock',
]
const K = 'aeab20b9-e2c1-43ae-b9df-273b92a61eb8'
const KDIR = `/home/mithrandir/.kimi-code/sessions/wd_kimiprobe_75aa5a88acd1/session_${K}`

describe('codex: the conversation is in the NAME of what the native binary holds', () => {
  it('reads the id off the rollout and off the thread writer-lock', () => {
    expect(codexConversationFromPath(ROLLOUT)).toBe(C)
    expect(codexConversationFromPath(LOCK)).toBe(C)
  })

  it('links from the lock alone — held from spawn, before the first message writes a rollout', () => {
    expect(codexTranscriptFromFds([...CODEX_NOISE, LOCK])).toBe(LOCK)
  })

  it('prefers the rollout once it exists beside the lock (same id), so the answer is stable', () => {
    expect(codexTranscriptFromFds([LOCK, ...CODEX_NOISE, ROLLOUT])).toBe(ROLLOUT)
    expect(codexTranscriptFromFds([ROLLOUT, LOCK])).toBe(ROLLOUT)
  })

  it('refuses when the process names TWO threads (a sub-thread, a /new mid-write)', () => {
    expect(codexTranscriptFromFds([ROLLOUT, `/home/mithrandir/.codex/thread-writer-locks/${C_OTHER}.lock`])).toBeNull()
  })

  it('answers nothing for a process holding none of it', () => {
    expect(codexTranscriptFromFds(CODEX_NOISE)).toBeNull()
    expect(codexTranscriptFromFds([])).toBeNull()
  })

  it('does not mistake look-alikes for a rollout', () => {
    // Not under a dated sessions/YYYY/MM/DD tree, or not ending in a uuid.
    expect(codexConversationFromPath(`/home/u/notes/rollout-x-${C}.jsonl`)).toBeNull()
    expect(codexConversationFromPath('/home/u/.codex/sessions/2026/10/08/rollout-2026-10-08T23-32-16.jsonl')).toBeNull()
    expect(codexConversationFromPath(`${ROLLOUT}.bak`)).toBeNull()
    expect(codexConversationFromPath(`/home/u/.codex/thread-writer-locks/${C.toUpperCase()}.lock`)).toBeNull()
  })
})

describe('kimi: the conversation is the session directory any held path sits in', () => {
  it('reads the bare uuid — the form kimi.ts stores — off every path kimi was seen holding', () => {
    for (const p of [
      KDIR,
      `${KDIR}/agents/main/wire.jsonl`,
      `${KDIR}/logs/kimi-code.log`,
      `${KDIR}/state.json.tmp.911756.e098a4e8`,
    ]) expect(kimiConversationFromPath(p), p).toBe(K)
  })

  it('prefers the main agent wire when several of the session paths are open at once', () => {
    expect(kimiTranscriptFromFds([`${KDIR}/logs/kimi-code.log`, `${KDIR}/agents/main/wire.jsonl`]))
      .toBe(`${KDIR}/agents/main/wire.jsonl`)
    expect(kimiTranscriptFromFds(['/dev/null', `${KDIR}/state.json.tmp.1.a`])).toBe(`${KDIR}/state.json.tmp.1.a`)
  })

  it('refuses two sessions at once', () => {
    const other = '/home/mithrandir/.kimi-code/sessions/wd_x_1/session_c91522ee-e891-41bf-95d6-a9ac674f5107/state.json'
    expect(kimiTranscriptFromFds([`${KDIR}/agents/main/wire.jsonl`, other])).toBeNull()
  })

  it('answers nothing between writes — what kimi holds then is only pipes, io_uring and inotify', () => {
    expect(kimiTranscriptFromFds(['/dev/pts/5', 'anon_inode:[io_uring]', 'anon_inode:inotify', 'pipe:[1]'])).toBeNull()
  })

  it('does not read a global kimi log or a workspace dir as a session', () => {
    expect(kimiConversationFromPath('/home/mithrandir/.kimi-code/logs/kimi-code.log')).toBeNull()
    expect(kimiConversationFromPath('/home/mithrandir/.kimi-code/sessions/wd_kimiprobe_75aa5a88acd1')).toBeNull()
    expect(kimiConversationFromPath(`/home/mithrandir/.kimi-code/sessions/wd_x/session_${K}x/state.json`)).toBeNull()
  })
})

describe('holderCollisions — two HOLDERS on one identity link neither', () => {
  it('flags every holder of a shared identity and none of the rest', () => {
    const got = holderCollisions(new Map<number, string | null>([[1, C], [2, C], [3, C_OTHER], [4, null]]))
    expect([...got].sort()).toEqual([1, 2])
  })

  it('one holder is never a collision, however many pids led to it', () => {
    // The map is keyed by holder, so a codex shim + native binary both resolving to holder 1101
    // collapse into one entry before this is asked.
    expect(holderCollisions(new Map([[1101, C]])).size).toBe(0)
    expect(holderCollisions(new Map()).size).toBe(0)
  })
})

describe('HARNESS_PROCESS_TRANSCRIPTS — what each harness was measured to hold', () => {
  it('has decided about every harness', () => {
    expect(Object.keys(HARNESS_PROCESS_TRANSCRIPTS).sort()).toEqual([...HARNESS_ORDER].sort())
  })

  it('codex holds always, kimi only while writing, agy is the pane process and its only route', () => {
    expect(HARNESS_PROCESS_TRANSCRIPTS.codex).toMatchObject({ holders: ['codex'], holds: 'always', onlyRoute: false })
    expect(HARNESS_PROCESS_TRANSCRIPTS.kimi).toMatchObject({ holders: ['kimi'], holds: 'while-writing', onlyRoute: false })
    expect(HARNESS_PROCESS_TRANSCRIPTS.antigravity).toMatchObject({ holders: null, holds: 'always', onlyRoute: true })
    expect(HARNESS_PROCESS_TRANSCRIPTS.codex!.conversation.from).toBe('path')
    expect(HARNESS_PROCESS_TRANSCRIPTS.kimi!.conversation.from).toBe('path')
    expect(HARNESS_PROCESS_TRANSCRIPTS.antigravity!.conversation.from).toBe('content')
  })

  it('reads a captured path through the table, not only through the module', () => {
    const codex = HARNESS_PROCESS_TRANSCRIPTS.codex!
    const file = codex.fileFromFds([...CODEX_NOISE, LOCK, ROLLOUT])!
    expect(codex.conversation.read(file)).toBe(C)
    const kimi = HARNESS_PROCESS_TRANSCRIPTS.kimi!
    expect(kimi.conversation.read(kimi.fileFromFds([`${KDIR}/agents/main/wire.jsonl`])!)).toBe(K)
  })

  it('has no entry where the probe found no per-session open file (gemini, opencode) or an id is assigned', () => {
    for (const h of ['gemini', 'opencode', 'claude', 'copilot'] as const) {
      expect(HARNESS_PROCESS_TRANSCRIPTS[h], h).toBeNull()
    }
  })

  it('only agy carries the post-mortem read', () => {
    for (const h of HARNESS_ORDER) {
      expect(Boolean(HARNESS_PROCESS_TRANSCRIPTS[h]?.afterTheFact), h).toBe(h === 'antigravity')
    }
  })
})
