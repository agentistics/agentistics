import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HARNESS_TRANSCRIPTS, forgetCodexTranscriptPaths, forgetGeminiTranscriptPaths, forgetKimiTranscriptPaths,
  resolveAntigravityTranscript, resolveCodexTranscript, resolveCopilotTranscript, resolveGeminiTranscript,
  resolveKimiTranscript, transcriptReaderFor, recentCodexDayDirs,
} from './harness-transcript'

const CONV = '01d0814f-ef39-4838-8461-c50e540e552a'

/** One agy step, in the shape measured on the live transcript. */
const step = (idx: number, o: Record<string, unknown>): string => JSON.stringify({
  step_index: idx, status: 'DONE', created_at: '2026-09-05T17:22:28Z', ...o,
})

describe('the reader registry', () => {
  it('names every harness, so adding one is a decision here rather than a lookup miss', () => {
    expect(Object.keys(HARNESS_TRANSCRIPTS).sort())
      .toEqual(['antigravity', 'claude', 'codex', 'copilot', 'gemini', 'kimi', 'opencode'])
  })

  it('has no nulls left — gemini was the last, and its reason was the LINK', () => {
    // It read `expect(transcriptReaderFor('gemini')).toBeNull()` for as long as a gemini row could
    // not carry a conversation id: no `assignId`, and a `--resume` that takes "latest" or an index.
    // `planFirstSightingClaims` includes gemini deliberately and claims the SYNTHETIC id the store
    // is already keyed on, which names the chat file directly — so the entry stopped being
    // unreachable code and became a reader. A null here is now a gap, not a finding.
    for (const h of ['claude', 'codex', 'copilot', 'kimi', 'antigravity', 'gemini'] as const) {
      expect(transcriptReaderFor(h), h).not.toBeNull()
    }
  })

  it("a row whose harness the registry forgot ('') resolves to nothing rather than throwing", () => {
    expect(transcriptReaderFor('')).toBeNull()
    expect(transcriptReaderFor(undefined)).toBeNull()
    expect(transcriptReaderFor('a-harness-from-a-newer-build')).toBeNull()
  })
})

describe('the antigravity reader', () => {
  let brain: string
  let logs: string

  beforeAll(async () => {
    brain = await mkdtemp(join(tmpdir(), 'agy-brain-'))
    logs = join(brain, CONV, '.system_generated', 'logs')
    await mkdir(logs, { recursive: true })
  })
  afterAll(async () => { await rm(brain, { recursive: true, force: true }) })

  it('prefers transcript_full.jsonl — transcript.jsonl is the truncated copy of it', async () => {
    await writeFile(join(logs, 'transcript.jsonl'), '')
    expect(await resolveAntigravityTranscript({ conversationId: CONV }, brain))
      .toBe(join(logs, 'transcript.jsonl'))
    await writeFile(join(logs, 'transcript_full.jsonl'), '')
    expect(await resolveAntigravityTranscript({ conversationId: CONV }, brain))
      .toBe(join(logs, 'transcript_full.jsonl'))
  })

  it('a conversation id that is not a UUID resolves to nothing, and reaches no filesystem', async () => {
    expect(await resolveAntigravityTranscript({ conversationId: '../../etc' }, brain)).toBeNull()
  })

  it('an unknown conversation resolves to nothing rather than to a path that does not exist', async () => {
    const other = '11111111-2222-4333-8444-555555555555'
    expect(await resolveAntigravityTranscript({ conversationId: other }, brain)).toBeNull()
  })

  it('reads the whole conversation, and the TAIL reads only its end', async () => {
    const lines: string[] = []
    for (let i = 0; i < 300; i++) {
      lines.push(step(i, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: `m${i}` }))
    }
    const path = join(logs, 'transcript_full.jsonl')
    await writeFile(path, `${lines.join('\n')}\n`)

    const reader = HARNESS_TRANSCRIPTS.antigravity!
    const all = await reader.read(path, 400)
    expect(all.turns).toHaveLength(300)
    expect(all.turns[0]!.text).toBe('m0')
    expect(all.turns[299]!.text).toBe('m299')
    // Shorter than the window: nothing was hidden, so nothing is claimed.
    expect(all.older).toBe(false)

    // The 5s poll's budget: the last few turns, off the end of the file.
    const tail = await reader.readRecent(path, 6)
    expect(tail.map(t => t.text)).toEqual(['m294', 'm295', 'm296', 'm297', 'm298', 'm299'])
  })

  it('the tail WIDENS its window rather than returning fewer turns than asked for', async () => {
    // One turn, then padding far larger than the 256 KB first window, so a fixed window would
    // reach the end of the file and find nothing — the answer would be silently short.
    const pad = Array.from({ length: 4000 }, (_, i) =>
      step(i + 1, { source: 'MODEL', type: 'VIEW_FILE', content: 'x'.repeat(200) }))
    const path = join(logs, 'wide.jsonl')
    await writeFile(path, [
      step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\noi\n</USER_REQUEST>' }),
      ...pad,
    ].join('\n'))

    const tail = await HARNESS_TRANSCRIPTS.antigravity!.readRecent(path, 1)
    expect(tail).toEqual([{ role: 'user', text: 'oi', at: '2026-09-05T17:22:28Z' }])
  })

  it('an unreadable file is an empty conversation, never a throw', async () => {
    const reader = HARNESS_TRANSCRIPTS.antigravity!
    expect(await reader.read(join(logs, 'nope.jsonl'), 10)).toEqual({ turns: [], older: false })
    expect(await reader.readRecent(join(logs, 'nope.jsonl'), 10)).toEqual([])
  })
})

describe('the codex reader', () => {
  const ID = '019f3e9a-43b1-7391-b8a2-19fcdfeb88b0'
  let root: string

  beforeAll(async () => {
    forgetCodexTranscriptPaths()
    root = await mkdtemp(join(tmpdir(), 'codex-sessions-'))
    await mkdir(join(root, '2026', '07', '07'), { recursive: true })
    await writeFile(
      join(root, '2026', '07', '07', `rollout-2026-07-07T19-02-05-${ID}.jsonl`),
      [
        JSON.stringify({ timestamp: '2026-07-07T22:02:11Z', type: 'session_meta', payload: { id: ID } }),
        JSON.stringify({
          timestamp: '2026-07-07T22:02:40Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Salve' }] },
        }),
        // The duplicate copy, which must not be read.
        JSON.stringify({
          timestamp: '2026-07-07T22:02:40Z', type: 'event_msg',
          payload: { type: 'user_message', message: 'Salve' },
        }),
      ].join('\n'),
    )
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('finds the rollout by the conversation id in its FILENAME, across the day tree', async () => {
    expect(await resolveCodexTranscript({ conversationId: ID }, root))
      .toBe(join(root, '2026', '07', '07', `rollout-2026-07-07T19-02-05-${ID}.jsonl`))
  })

  it('an id that is not a UUID resolves to nothing and reaches no filesystem', async () => {
    expect(await resolveCodexTranscript({ conversationId: '../../etc/passwd' }, root)).toBeNull()
  })

  it('an unknown conversation resolves to nothing — and the MISS is memoized', async () => {
    const other = '11111111-2222-4333-8444-555555555555'
    expect(await resolveCodexTranscript({ conversationId: other }, root)).toBeNull()
    // A machine keeps a directory per day forever; a miss must cost one scan, not one per poll.
    expect(await resolveCodexTranscript({ conversationId: other }, root)).toBeNull()
  })

  it('a rollout written AFTER a miss is found on the NEXT resolve, not 30 s later', async () => {
    // The chat is opened before codex writes its rollout (~1 s after the first message): the miss
    // must not hide the file for the miss TTL — the recent day directories are probed every time.
    const late = '22222222-3333-4444-8555-666666666666'
    const now = Date.UTC(2026, 9, 9, 15, 0, 0)
    expect(await resolveCodexTranscript({ conversationId: late }, root, now)).toBeNull()
    const dir = join(root, ...recentCodexDayDirs(now)[0]!.split('/'))
    await mkdir(dir, { recursive: true })
    const file = join(dir, `rollout-2026-10-09T12-00-00-${late}.jsonl`)
    await writeFile(file, '')
    expect(await resolveCodexTranscript({ conversationId: late }, root, now + 1_000)).toBe(file)
  })

  it('recentCodexDayDirs: today and yesterday, local and UTC, deduplicated', () => {
    // 01:30 UTC at UTC-3 is still the previous local day.
    expect(recentCodexDayDirs(Date.UTC(2026, 9, 9, 1, 30), 180)).toEqual(['2026/10/08', '2026/10/09', '2026/10/07'])
    expect(recentCodexDayDirs(Date.UTC(2026, 9, 9, 15, 0), 0)).toEqual(['2026/10/09', '2026/10/08'])
  })

  it('reads the conversation, taking exactly one copy of the duplicated message', async () => {
    const path = join(root, '2026', '07', '07', `rollout-2026-07-07T19-02-05-${ID}.jsonl`)
    const read = await HARNESS_TRANSCRIPTS.codex!.read(path, 400)
    expect(read).toEqual({
      turns: [{ role: 'user', text: 'Salve', at: '2026-07-07T22:02:40Z' }],
      older: false,
    })
    expect(await HARNESS_TRANSCRIPTS.codex!.readRecent(path, 6)).toEqual(read.turns)
  })
})

describe('the copilot reader', () => {
  const ID = 'dbd94500-8d79-4c7c-8c69-a2cd0c044201'
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'copilot-state-'))
    await mkdir(join(root, ID), { recursive: true })
    await writeFile(join(root, ID, 'events.jsonl'), [
      JSON.stringify({ type: 'session.start', data: { sessionId: ID }, timestamp: '2026-06-30T14:53:06Z' }),
      JSON.stringify({
        type: 'user.message', timestamp: '2026-06-30T14:53:11Z',
        data: { content: 'salve mano', transformedContent: '<current_datetime>x</current_datetime>\n\nsalve mano' },
      }),
    ].join('\n'))
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('the session DIRECTORY is named with the conversation id, so no scan is needed', async () => {
    expect(await resolveCopilotTranscript({ conversationId: ID }, root))
      .toBe(join(root, ID, 'events.jsonl'))
  })

  it('resolves an agentop mc_session_id through workspace metadata', async () => {
    const managed = 'agentop-session-id'
    await writeFile(join(root, ID, 'workspace.yaml'), `id: ${ID}\nmc_session_id: ${managed}\n`)
    expect(await resolveCopilotTranscript({ conversationId: managed }, root))
      .toBe(join(root, ID, 'events.jsonl'))
  })

  it('an unknown managed id resolves to nothing without treating it as a path', async () => {
    expect(await resolveCopilotTranscript({ conversationId: '../../etc' }, root)).toBeNull()
  })

  it('reads the person’s own text, not the transformed copy', async () => {
    const path = join(root, ID, 'events.jsonl')
    const read = await HARNESS_TRANSCRIPTS.copilot!.read(path, 400)
    expect(read.turns).toEqual([{ role: 'user', text: 'salve mano', at: '2026-06-30T14:53:11Z' }])
    expect(await HARNESS_TRANSCRIPTS.copilot!.readRecent(path, 6)).toEqual(read.turns)
  })
})

describe('the kimi reader', () => {
  const ID = 'f8f1e9b0-235e-44c3-8d66-7a5cd6b54009'
  let root: string
  let wire: string

  beforeAll(async () => {
    forgetKimiTranscriptPaths()
    root = await mkdtemp(join(tmpdir(), 'kimi-sessions-'))
    wire = join(root, 'wd_scratchpad_a2dd52466aab', `session_${ID}`, 'agents', 'main', 'wire.jsonl')
    await mkdir(join(root, 'wd_scratchpad_a2dd52466aab', `session_${ID}`, 'agents', 'main'), { recursive: true })
    await writeFile(wire, [
      JSON.stringify({
        type: 'context.append_message', time: 1785943919760,
        message: { role: 'user', content: [{ type: 'text', text: 'salve' }], origin: { kind: 'user' } },
      }),
      // The duplicate copy, which must not be read.
      JSON.stringify({ type: 'turn.prompt', time: 1785943919757, input: [{ type: 'text', text: 'salve' }] }),
    ].join('\n'))
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('finds the MAIN agent’s wire under whichever workspace holds the session', async () => {
    expect(await resolveKimiTranscript({ conversationId: ID }, root)).toBe(wire)
  })

  it('an unknown conversation resolves to nothing', async () => {
    const other = '11111111-2222-4333-8444-555555555555'
    expect(await resolveKimiTranscript({ conversationId: other }, root)).toBeNull()
    expect(await resolveKimiTranscript({ conversationId: other }, root)).toBeNull()
  })

  it('a wire written AFTER a miss is found on the NEXT resolve, not 30 s later', async () => {
    const late = '33333333-4444-4555-8666-777777777777'
    expect(await resolveKimiTranscript({ conversationId: late }, root)).toBeNull()
    const dir = join(root, 'wd_scratchpad_a2dd52466aab', `session_${late}`, 'agents', 'main')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'wire.jsonl'), '')
    expect(await resolveKimiTranscript({ conversationId: late }, root)).toBe(join(dir, 'wire.jsonl'))
  })

  it('reads the conversation, taking exactly one copy of the duplicated prompt', async () => {
    const read = await HARNESS_TRANSCRIPTS.kimi!.read(wire, 400)
    expect(read.turns).toHaveLength(1)
    expect(read.turns[0]).toMatchObject({ role: 'user', text: 'salve' })
    expect(await HARNESS_TRANSCRIPTS.kimi!.readRecent(wire, 6)).toEqual(read.turns)
  })
})

describe('the window says it is a window, on every harness', () => {
  /**
   * `older` was introduced for Claude (`readChatWindow`) because the gallery, built on whatever
   * turns it was handed, emptied itself on a long transcript with nothing saying why. Every reader
   * owes the same answer, or four harnesses inherit the silent version of that bug.
   */
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'older-'))
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reports `older` when the cap cut the conversation, and the LAST turns are the ones kept', async () => {
    const path = join(dir, 'agy.jsonl')
    await writeFile(path, Array.from({ length: 30 }, (_, i) => JSON.stringify({
      step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: `m${i}`,
    })).join('\n'))

    const cut = await HARNESS_TRANSCRIPTS.antigravity!.read(path, 5)
    expect(cut.older).toBe(true)
    expect(cut.turns).toHaveLength(5)
    // The END of the conversation, not its beginning — the window is a tail.
    expect(cut.turns.map(t => t.text)).toEqual(['m25', 'm26', 'm27', 'm28', 'm29'])

    // Exactly the cap is NOT `older`: nothing was hidden.
    expect((await HARNESS_TRANSCRIPTS.antigravity!.read(path, 30)).older).toBe(false)
  })

  it('every reader answers it, not only the one it was written for', async () => {
    const files: Array<[keyof typeof HARNESS_TRANSCRIPTS, string, string[]]> = [
      ['codex', 'codex.jsonl', Array.from({ length: 12 }, (_, i) => JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ text: `m${i}` }] },
      }))],
      ['copilot', 'copilot.jsonl', Array.from({ length: 12 }, (_, i) => JSON.stringify({
        type: 'user.message', data: { content: `m${i}` },
      }))],
      ['kimi', 'kimi.jsonl', Array.from({ length: 12 }, (_, i) => JSON.stringify({
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: `m${i}` }], origin: { kind: 'user' } },
      }))],
    ]
    for (const [harness, name, lines] of files) {
      const path = join(dir, name)
      await writeFile(path, lines.join('\n'))
      const cut = await HARNESS_TRANSCRIPTS[harness]!.read(path, 4)
      expect(cut.older).toBe(true)
      expect(cut.turns.map(t => t.text)).toEqual(['m8', 'm9', 'm10', 'm11'])
      expect((await HARNESS_TRANSCRIPTS[harness]!.read(path, 50)).older).toBe(false)
    }
  })
})

/**
 * EVERY HARNESS WHOSE RESOLVER MEMOIZES: a session's transcript does not exist until the
 * conversation first says something, so the first poll after a spawn always misses — and a miss
 * remembered for the life of the process makes that conversation unreadable for the life of the
 * process. Reported on a claude session started from the wizard; codex and kimi memoize the same
 * way and would fail the same way. Antigravity and copilot re-check their two paths on every call
 * and are immune by construction, which is why they are absent here.
 */
describe('a transcript that appears AFTER the first miss', () => {
  const ID = '99999999-8888-4777-8666-555555555555'

  it('codex: is found once the rollout is written', async () => {
    forgetCodexTranscriptPaths()
    const root = await mkdtemp(join(tmpdir(), 'codex-late-'))
    const at = 5_000_000
    expect(await resolveCodexTranscript({ conversationId: ID }, root, at)).toBeNull()

    const dir = join(root, '2026', '09', '08')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `rollout-2026-09-08T10-00-00-${ID}.jsonl`)
    await writeFile(file, '')

    // Inside the TTL the scan is deliberately not repeated; past it, the file is found.
    expect(await resolveCodexTranscript({ conversationId: ID }, root, at + 1_000)).toBeNull()
    expect(await resolveCodexTranscript({ conversationId: ID }, root, at + 31_000)).toBe(file)
    await rm(root, { recursive: true, force: true })
  })

  it('kimi: is found once the wire is written', async () => {
    forgetKimiTranscriptPaths()
    const root = await mkdtemp(join(tmpdir(), 'kimi-late-'))
    const at = 5_000_000
    expect(await resolveKimiTranscript({ conversationId: ID }, root, at)).toBeNull()

    const dir = join(root, 'wd_x', `session_${ID}`, 'agents', 'main')
    await mkdir(dir, { recursive: true })
    const wire = join(dir, 'wire.jsonl')
    await writeFile(wire, '')

    expect(await resolveKimiTranscript({ conversationId: ID }, root, at + 31_000)).toBe(wire)
    await rm(root, { recursive: true, force: true })
  })
})


describe('the gemini reader resolves BOTH of its ids', () => {
  // Layout measured live on gemini 0.63.0 (2026-10-09): `tmp/<project>/chats/session-<ts>-<uuid8>.jsonl`
  // with a header line `{"sessionId":"<uuid>",…}`.
  const UUID = '04d97770-e53f-4b7d-86d2-63bd12ec32eb'
  const SAME_SUFFIX = '04d97770-0000-4000-8000-000000000000' // a different chat sharing the 8-char hint
  let tmp: string
  const header = (id: string) => JSON.stringify({ sessionId: id, projectHash: 'h', startTime: '2026-10-09T10:49:54.676Z', kind: 'main' }) + '\n'

  beforeAll(async () => {
    forgetGeminiTranscriptPaths()
    tmp = await mkdtemp(join(tmpdir(), 'gemini-tmp-'))
    const chats = join(tmp, 'work', 'chats')
    await mkdir(chats, { recursive: true })
    await writeFile(join(chats, 'session-2026-10-09T10-49-04d97770.jsonl'), header(UUID))
    // another project holds a chat whose file name carries the SAME eight characters
    await mkdir(join(tmp, 'other', 'chats'), { recursive: true })
    await writeFile(join(tmp, 'other', 'chats', 'session-2026-10-08T09-00-04d97770.jsonl'), header(SAME_SUFFIX))
  })
  afterAll(async () => { await rm(tmp, { recursive: true, force: true }) })

  it('finds the chat of an assigned uuid by the file-name suffix, CONFIRMED by the header', async () => {
    expect(await resolveGeminiTranscript({ conversationId: UUID }, tmp))
      .toBe(join(tmp, 'work', 'chats', 'session-2026-10-09T10-49-04d97770.jsonl'))
    // eight hex characters are a hint, the header is the proof: the neighbour is its own chat
    expect(await resolveGeminiTranscript({ conversationId: SAME_SUFFIX }, tmp))
      .toBe(join(tmp, 'other', 'chats', 'session-2026-10-08T09-00-04d97770.jsonl'))
  })

  it('answers null for a uuid no header carries, even when a file name matches its suffix', async () => {
    const liar = '04d97770-ffff-4fff-8fff-ffffffffffff'
    expect(await resolveGeminiTranscript({ conversationId: liar }, tmp, Date.now() + 1)).toBeNull()
  })

  it('still resolves the store\'s synthetic <project>/<file> id and refuses traversal', async () => {
    expect(await resolveGeminiTranscript({ conversationId: 'work/session-2026-10-09T10-49-04d97770' }, tmp))
      .toBe(join(tmp, 'work', 'chats', 'session-2026-10-09T10-49-04d97770.jsonl'))
    for (const bad of ['../x/y', 'work/../../etc', 'a/b/c', 'work', '/', 'work/..']) {
      expect(await resolveGeminiTranscript({ conversationId: bad }, tmp), bad).toBeNull()
    }
  })

  it('a MISS expires: the chat appears at the first turn, after the first poll missed it', async () => {
    forgetGeminiTranscriptPaths()
    const later = '77777777-7777-4777-8777-777777777777'
    const t0 = 1_000_000
    expect(await resolveGeminiTranscript({ conversationId: later }, tmp, t0)).toBeNull()
    const f = join(tmp, 'work', 'chats', 'session-2026-10-09T11-00-77777777.jsonl')
    await writeFile(f, header(later))
    // inside the miss TTL the expensive scan is not repeated…
    expect(await resolveGeminiTranscript({ conversationId: later }, tmp, t0 + 1_000)).toBeNull()
    // …and once it expires the file is found. A remembered "nowhere" must not outlive the wait.
    expect(await resolveGeminiTranscript({ conversationId: later }, tmp, t0 + 31_000)).toBe(f)
  })

  it('forgets a remembered path whose file is gone', async () => {
    forgetGeminiTranscriptPaths()
    const gone = '88888888-8888-4888-8888-888888888888'
    const f = join(tmp, 'work', 'chats', 'session-2026-10-09T11-30-88888888.jsonl')
    await writeFile(f, header(gone))
    expect(await resolveGeminiTranscript({ conversationId: gone }, tmp)).toBe(f)
    await rm(f)
    expect(await resolveGeminiTranscript({ conversationId: gone }, tmp)).toBeNull()
  })
})

describe('a REOPENED gemini conversation spans several files (measured on 0.63.0)', () => {
  // Interactive `--resume <uuid>` writes the new turns to a NEW headerless file; the original keeps
  // its header, a `$set.sessionId` patch and a snapshot of the turns it already had.
  const UUID = '550dc3a6-6fb8-42b5-9ad3-22dc68f74e88'
  let tmp: string
  let chats: string
  const A = 'session-2026-10-09T11-02-550dc3a6.jsonl'
  const B = 'session-2026-10-09T11-03-550dc3a6.jsonl'
  const msg = (id: string, type: string, text: string, ts: string) =>
    JSON.stringify({ id, timestamp: ts, type, content: type === 'user' ? [{ text }] : text })

  beforeAll(async () => {
    forgetGeminiTranscriptPaths()
    tmp = await mkdtemp(join(tmpdir(), 'gemini-family-'))
    chats = join(tmp, 'work', 'chats')
    await mkdir(chats, { recursive: true })
    await writeFile(join(chats, A), [
      JSON.stringify({ sessionId: UUID, projectHash: 'h', startTime: '2026-10-09T11:02:06.822Z', kind: 'main' }),
      msg('u1', 'user', 'reply with ok', '2026-10-09T11:02:07.000Z'),
      msg('g1', 'gemini', 'ok', '2026-10-09T11:02:09.000Z'),
      JSON.stringify({ $set: { sessionId: UUID } }),
      // the snapshot the original receives on reopen REPEATS the turns it already has
      JSON.stringify({ $set: { messages: [
        { id: 'u1', timestamp: '2026-10-09T11:02:07.000Z', type: 'user', content: [{ text: 'reply with ok' }] },
        { id: 'g1', timestamp: '2026-10-09T11:02:09.000Z', type: 'gemini', content: 'ok' },
      ] } }),
    ].join('\n') + '\n')
    await writeFile(join(chats, B), [
      msg('u2', 'user', 'reply with third', '2026-10-09T11:03:20.000Z'),
      msg('g2', 'gemini', 'third', '2026-10-09T11:03:22.000Z'),
    ].join('\n') + '\n')
  })
  afterAll(async () => { await rm(tmp, { recursive: true, force: true }) })

  it('resolves the uuid to the NEWEST member — the file gemini is writing now', async () => {
    expect(await resolveGeminiTranscript({ conversationId: UUID }, tmp)).toBe(join(chats, B))
  })

  it('reads the whole conversation from either member, repeated snapshot turns shown once', async () => {
    const reader = transcriptReaderFor('gemini')!
    for (const member of [A, B]) {
      const r = await reader.read(join(chats, member), 50)
      expect(r.turns.map(t => `${t.role}:${t.text}`), member)
        .toEqual(['user:reply with ok', 'assistant:ok', 'user:reply with third', 'assistant:third'])
      expect(r.older).toBe(false)
    }
  })

  it('the recent-tail read spans the family too', async () => {
    const reader = transcriptReaderFor('gemini')!
    const turns = await reader.readRecent(join(chats, B), 3)
    expect(turns.map(t => t.text)).toEqual(['ok', 'reply with third', 'third'])
  })

  it('the synthetic <project>/<file> id of the ORIGINAL file reads the same conversation', async () => {
    const p = await resolveGeminiTranscript({ conversationId: `work/${A.replace('.jsonl', '')}` }, tmp)
    expect(p).toBe(join(chats, A))
    const r = await transcriptReaderFor('gemini')!.read(p!, 50)
    expect(r.turns).toHaveLength(4)
  })

  it('a conversation that was never reopened is read exactly as before (one file)', async () => {
    const solo = join(chats, 'session-2026-10-09T09-00-aaaaaaaa.jsonl')
    await writeFile(solo, [
      JSON.stringify({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', projectHash: 'h', startTime: '2026-10-09T09:00:00.000Z' }),
      msg('s1', 'user', 'solo question', '2026-10-09T09:00:01.000Z'),
    ].join('\n') + '\n')
    const reader = transcriptReaderFor('gemini')!
    expect((await reader.read(solo, 10)).turns.map(t => t.text)).toEqual(['solo question'])
    expect((await reader.readRecent(solo, 10)).map(t => t.text)).toEqual(['solo question'])
  })
})
