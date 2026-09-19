import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, rename, rm, writeFile, utimes } from 'node:fs/promises'
import {
  forgetChatTailContent, forgetChatTailPaths, readChatWindow, readRecentChatTurns,
  resolveChatTranscriptPath,
} from './chat-tail'
import { ATTACHMENT_DIR } from './attachment-web'

const SESSION_ID = 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789'

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

const userTurn = (text: string) => line({ type: 'user', message: { content: text } })
const assistantTurn = (text: string) => line({
  type: 'assistant', message: { content: [{ type: 'text', text }] },
})
const toolResultTurn = () => line({
  type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] },
})
/** A `queued_command` attachment — how a message typed while the assistant was busy is recorded,
 *  and also how the harness's own `<task-notification>` reaches the transcript. */
const queuedTurn = (prompt: string) => line({
  type: 'attachment',
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt' },
})

const toolUseTurn = (...names: string[]) => line({
  type: 'assistant',
  message: { content: names.map(name => ({ type: 'tool_use', name, input: {} })) },
})

describe('resolveChatTranscriptPath', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-'))
    forgetChatTailPaths()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('finds the transcript at the directly encoded project path', async () => {
    const projectDir = join(root, '-home-user-my-project')
    await mkdir(projectDir, { recursive: true })
    const file = join(projectDir, `${SESSION_ID}.jsonl`)
    await writeFile(file, userTurn('hi') + '\n')

    const resolved = await resolveChatTranscriptPath('/home/user/my-project', SESSION_ID, root)
    expect(resolved).toBe(file)
  })

  test('falls back to a scan when the directly encoded path does not exist', async () => {
    // The naive encoding of this cwd would land on a directory that is not where Claude actually
    // put the file (an ambiguous-dash collision) — the scan is what finds it anyway, by filename.
    const realDir = join(root, 'some-other-directory-name')
    await mkdir(realDir, { recursive: true })
    const file = join(realDir, `${SESSION_ID}.jsonl`)
    await writeFile(file, userTurn('hi') + '\n')

    const resolved = await resolveChatTranscriptPath('/home/user/my-project', SESSION_ID, root)
    expect(resolved).toBe(file)
  })

  test('returns null and never throws when nothing matches', async () => {
    const resolved = await resolveChatTranscriptPath('/nowhere', SESSION_ID, root)
    expect(resolved).toBeNull()
  })

  test('rejects a non-UUID session id without touching the filesystem', async () => {
    const resolved = await resolveChatTranscriptPath('/nowhere', 'not-a-uuid', root)
    expect(resolved).toBeNull()
  })

  test('caches a miss so a second lookup does not re-scan', async () => {
    const first = await resolveChatTranscriptPath('/nowhere', SESSION_ID, root)
    expect(first).toBeNull()

    // Adding the file after the miss was cached must not change the cached answer.
    const lateDir = join(root, '-late')
    await mkdir(lateDir, { recursive: true })
    await writeFile(join(lateDir, `${SESSION_ID}.jsonl`), userTurn('hi') + '\n')

    const second = await resolveChatTranscriptPath('/nowhere', SESSION_ID, root)
    expect(second).toBeNull()
  })
})

describe('readRecentChatTurns', () => {
  let root: string
  let file: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-content-'))
    file = join(root, 'transcript.jsonl')
    forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('returns turns oldest-first with real roles', async () => {
    await writeFile(file, [
      userTurn('what does this do'),
      assistantTurn('it does the thing'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([
      { role: 'user', text: 'what does this do' },
      { role: 'assistant', text: 'it does the thing' },
    ])
  })

  // The reader takes the END of the file, not the whole of it — a live session's transcript is
  // re-read on every poll, and reading megabytes to show six lines is what made /api/fleet take
  // seconds. These two pin the part that can go wrong silently: the window must never COST turns.
  test('reads the last turns out of a transcript far larger than the tail window', async () => {
    // ~2 MB of history in front of them, so the read starts mid-file and mid-line.
    const filler: string[] = []
    for (let i = 0; i < 200; i++) filler.push(assistantTurn('x'.repeat(10_000)))
    await writeFile(file, [
      ...filler,
      userTurn('the last question'),
      assistantTurn('the last answer'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file, 2)
    expect(turns).toEqual([
      { role: 'user', text: 'the last question' },
      { role: 'assistant', text: 'the last answer' },
    ])
  })

  test('widens the window rather than returning fewer turns than were asked for', async () => {
    // One enormous newest entry: the first window lands entirely INSIDE it, so the partial-line rule
    // discards everything and the pass finds nothing. Truncating there would silently drop five real
    // turns; the reader must read further back instead.
    await writeFile(file, [
      userTurn('one'),
      assistantTurn('two'),
      userTurn('three'),
      assistantTurn('four'),
      userTurn('five'),
      assistantTurn('y'.repeat(400_000)),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file, 6)
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(turns[0]).toEqual({ role: 'user', text: 'one' })
    expect(turns[5]!.text.length).toBe(400_000)
  })

  test('filters out tool-result-only user entries', async () => {
    await writeFile(file, [
      userTurn('do the thing'),
      assistantTurn('doing it'),
      toolResultTurn(),
      assistantTurn('done'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  test('surfaces a pending tool-activity turn when the newest event is a tool call with no text yet', async () => {
    await writeFile(file, [
      userTurn('fix the bug'),
      assistantTurn('looking into it'),
      toolUseTurn('Bash'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'looking into it' },
      { role: 'assistant', text: 'Running Bash', pending: true },
    ])
  })

  test('names every tool called in the newest entry', async () => {
    await writeFile(file, [userTurn('go'), toolUseTurn('Read', 'Bash')].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.at(-1)).toEqual({ role: 'assistant', text: 'Running Read, Bash', pending: true })
  })

  test('does NOT synthesize a pending turn for an older tool call that already has a result', async () => {
    // Only the newest event in the file may be read as "busy right now" — an earlier tool_use with
    // nothing after it in this fixture would otherwise misreport a finished exchange as still running.
    await writeFile(file, [
      toolUseTurn('Bash'),
      toolResultTurn(),
      assistantTurn('done'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([{ role: 'assistant', text: 'done' }])
  })

  test('stops parsing once `max` turns are collected, from the end', async () => {
    const lines: string[] = []
    for (let i = 0; i < 20; i++) {
      lines.push(userTurn(`q${i}`))
      lines.push(assistantTurn(`a${i}`))
    }
    await writeFile(file, lines.join('\n') + '\n')

    const turns = await readRecentChatTurns(file, 2)
    expect(turns).toEqual([
      { role: 'user', text: 'q19' },
      { role: 'assistant', text: 'a19' },
    ])
  })

  test('skips malformed lines without throwing', async () => {
    await writeFile(file, [
      'not json at all',
      userTurn('hello'),
    ].join('\n') + '\n')

    const turns = await readRecentChatTurns(file)
    expect(turns).toEqual([{ role: 'user', text: 'hello' }])
  })

  test('returns empty for a missing file rather than throwing', async () => {
    const turns = await readRecentChatTurns(join(root, 'nope.jsonl'))
    expect(turns).toEqual([])
  })

  test('re-parses when the file changes and reuses the cache when it has not', async () => {
    await writeFile(file, userTurn('first') + '\n')
    const first = await readRecentChatTurns(file)
    expect(first).toEqual([{ role: 'user', text: 'first' }])

    // Unchanged mtime: appending nothing and re-reading must return the cached array instance.
    const cached = await readRecentChatTurns(file)
    expect(cached).toBe(first)

    // Bump mtime forward so the cache is invalidated even on filesystems with coarse resolution.
    const future = new Date(Date.now() + 5_000)
    await writeFile(file, userTurn('first') + '\n' + assistantTurn('second') + '\n')
    await utimes(file, future, future)

    const updated = await readRecentChatTurns(file)
    expect(updated).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'second' },
    ])
  })
})

/**
 * A watcher is the one tool call worth a line in a conversation. Its END was already reported (the
 * `<task-notification>` that comes back as a system note); only the START was missing, so a task
 * appeared to finish having never begun.
 */
describe('background tasks', () => {
  let root: string
  let file: string

  const bgStart = (id: string, description: string) => line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'x', description, run_in_background: true } }] },
  })
  const bgDone = (id: string) => line({
    type: 'user',
    message: { content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` },
  })
  const foreground = () => line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_fg', name: 'Bash', input: { command: 'ls', description: 'List files' } }] },
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-bg-'))
    const dir = join(root, '-p')
    await mkdir(dir, { recursive: true })
    file = join(dir, `${SESSION_ID}.jsonl`)
    forgetChatTailPaths(); forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('a started task is a RUNNING line, by the label the assistant gave it', async () => {
    await writeFile(file, [bgStart('tu_1', 'Ship the grant')].join('\n') + '\n')
    const turns = await readRecentChatTurns(file, 20)
    const task = turns.find(t => t.task)
    expect(task?.task).toEqual({ label: 'Ship the grant', running: true })
  })

  test('its notification settles it, paired by tool-use-id', async () => {
    // The exact pairing: the notification carries the id of the very tool_use that launched it.
    await writeFile(file, [bgStart('tu_1', 'Ship the grant'), bgDone('tu_1')].join('\n') + '\n')
    const turns = await readRecentChatTurns(file, 20)
    expect(turns.find(t => t.task)?.task).toEqual({ label: 'Ship the grant', running: false })
  })

  test("someone else's notification does not settle it", async () => {
    await writeFile(file, [bgStart('tu_1', 'Watch the release'), bgDone('tu_other')].join('\n') + '\n')
    expect(turns2(await readRecentChatTurns(file, 20)).running).toBe(true)
  })

  test('a FOREGROUND tool call draws no line at all', async () => {
    // Rendering every tool call would turn a conversation into a command log — the discriminator is
    // the tool's own `run_in_background`, never a guess about how long something might take.
    await writeFile(file, [foreground()].join('\n') + '\n')
    const turns = await readRecentChatTurns(file, 20)
    expect(turns.some(t => t.task)).toBe(false)
  })

  test('two tasks are settled independently', async () => {
    await writeFile(file, [
      bgStart('tu_1', 'First'), bgStart('tu_2', 'Second'), bgDone('tu_2'),
    ].join('\n') + '\n')
    const byLabel = new Map(
      (await readRecentChatTurns(file, 20)).filter(t => t.task).map(t => [t.task!.label, t.task!.running]),
    )
    expect(byLabel.get('First')).toBe(true)
    expect(byLabel.get('Second')).toBe(false)
  })
})

function turns2(turns: { task?: { label: string; running: boolean } }[]): { label: string; running: boolean } {
  const t = turns.find(x => x.task)?.task
  if (!t) throw new Error('no task line')
  return t
}

describe('a queued_command carries envelopes too', () => {
  let root: string
  let file: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-queued-'))
    file = join(root, 'transcript.jsonl')
    forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('a task notification queued by the harness is not shown as the user\'s message', async () => {
    // Measured on a real transcript: a background task's completion reaches the file as an
    // `attachment` / `queued_command`, not as a `user` entry — so the envelope filter, which only
    // ever ran on the `user` path, never saw it. Seven of them were drawn in the reader's own
    // bubble, and they were reported exactly as the skill body was: "that message wasn't me".
    await writeFile(file, [
      userTurn('go ahead'),
      queuedTurn('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'),
    ].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.some(t => (t.text ?? '').includes('<task-notification>'))).toBe(false)
    expect(turns.some(t => (t.text ?? '').includes('<task-id>'))).toBe(false)
  })

  test('a real message queued while the assistant was busy still appears', async () => {
    // The whole point of reading this entry type. Filtering must not cost the feature it serves.
    await writeFile(file, [
      userTurn('go ahead'),
      queuedTurn('also fix the header while you are there'),
    ].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.some(t => t.role === 'user' && t.text === 'also fix the header while you are there')).toBe(true)
  })

  test('a slash command queued by the user is unwrapped, not hidden', async () => {
    // `<command-name>` is the person ACTING — dropping it would erase a turn that happened.
    await writeFile(file, [
      queuedTurn('<command-name>/login</command-name>'),
    ].join('\n') + '\n')
    const turns = await readRecentChatTurns(file)
    expect(turns.some(t => t.role === 'user' && (t.text ?? '').includes('/login'))).toBe(true)
    expect(turns.some(t => (t.text ?? '').includes('<command-name>'))).toBe(false)
  })
})

describe('readChatWindow — the cap is a fact about the READ, and it says so', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'chat-window-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const userLine = (text: string): string =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

  test('a conversation SHORTER than the cap reports nothing older', async () => {
    const path = join(root, 'short.jsonl')
    await writeFile(path, `${[userLine('one'), userLine('two')].join('\n')}\n`)
    const out = await readChatWindow(path, 10)
    expect(out.turns.length).toBe(2)
    expect(out.older).toBe(false)
  })

  test('a walk that stops ON the cap with transcript above it reports older', async () => {
    // The reported bug: a long session's gallery emptied itself and nothing on screen said why.
    // The gallery lists the files of the turns it was given, so the cap has to be visible here or
    // it is invisible everywhere.
    const path = join(root, 'long.jsonl')
    const lines = Array.from({ length: 20 }, (_, i) => userLine(`m${i}`))
    await writeFile(path, `${lines.join('\n')}\n`)
    const out = await readChatWindow(path, 5)
    expect(out.turns.length).toBe(5)
    expect(out.older).toBe(true)
    // The window is the END of the conversation, not its start.
    expect(out.turns[out.turns.length - 1]!.text).toContain('m19')
  })

  test('the trailing newline every transcript ends with is not "there is more"', async () => {
    const path = join(root, 'exact.jsonl')
    await writeFile(path, `${[userLine('a'), userLine('b')].join('\n')}\n`)
    expect((await readChatWindow(path, 2)).older).toBe(false)
  })
})

describe('a marker turn resolves through its own companion — attachment-companion.ts', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'chat-companion-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const a = join(ATTACHMENT_DIR, '7f06ed4a-image.png')
  const b = join(ATTACHMENT_DIR, '005d6e1c-image.png')

  const marker = (text: string, promptId: string, pasteIds: number[]) => line({
    type: 'user',
    promptId,
    imagePasteIds: pasteIds,
    message: { content: [{ type: 'text', text }] },
  })

  const companion = (promptId: string, paths: string[]) => line({
    type: 'user',
    promptId,
    isMeta: true,
    turnCompanion: true,
    message: { content: paths.map(p => ({ type: 'text', text: `[Image: source: ${p}]` })) },
  })

  test('exact match: the turn carries the resolved paths, and the companion draws no turn of its own', async () => {
    const path = join(root, 'a.jsonl')
    await writeFile(path, [
      marker('[Image #1] [Image #2]look at this', 'p1', [1, 2]),
      companion('p1', [a, b]),
    ].join('\n') + '\n')
    const out = (await readChatWindow(path, 10)).turns
    // ONE turn — the marker's. The companion is plumbing, not a message; it must never appear as
    // its own "an image was attached" chip once its paths have been folded into the turn beside it.
    expect(out.length).toBe(1)
    expect(out[0]!.imagePaths).toEqual([a, b])
    expect(out[0]!.text).toBe('[Image #1] [Image #2]look at this')
  })

  test('a count mismatch resolves nothing — the chip stays, never a wrong thumbnail', async () => {
    const path = join(root, 'b.jsonl')
    await writeFile(path, [
      // The companion names three paths; the turn claims only two markers and two pasteIds.
      marker('[Image #1] [Image #2]oi', 'p2', [1, 2]),
      companion('p2', [a, b, join(ATTACHMENT_DIR, 'extra.png')]),
    ].join('\n') + '\n')
    const out = (await readChatWindow(path, 10)).turns
    expect(out.length).toBe(1)
    expect(out[0]!.imagePaths).toBeUndefined()
  })

  test('a companion path outside the attachments directory is not served, and the turn does not resolve', async () => {
    const path = join(root, 'c.jsonl')
    await writeFile(path, [
      marker('[Image #1] [Image #2]oi', 'p3', [1, 2]),
      companion('p3', [a, '/etc/passwd']),
    ].join('\n') + '\n')
    const out = (await readChatWindow(path, 10)).turns
    expect(out.length).toBe(1)
    expect(out[0]!.imagePaths).toBeUndefined()
  })

  test('a marker turn with no companion at all falls back untouched — no imagePaths field', async () => {
    const path = join(root, 'd.jsonl')
    await writeFile(path, marker('[Image #1]sozinho', 'p4', [1]) + '\n')
    const out = (await readChatWindow(path, 10)).turns
    expect(out.length).toBe(1)
    expect(out[0]!.imagePaths).toBeUndefined()
    expect(out[0]!.text).toBe('[Image #1]sozinho')
  })

  /**
   * THE PIN: a conversation this change may never touch behaves EXACTLY as the original
   * implementation, compared against that behaviour directly rather than against the new code run
   * twice — a prior attempt at this fix compared the new code against itself and a reviewer caught
   * it. `turnCompanion` also marks a skill's loaded body beside the turn that invoked it
   * (`chat-envelope.ts`'s `META_KINDS`), which is unrelated to images and must still become the
   * ordinary "a skill was loaded" system note it always has.
   */
  test('a non-image turnCompanion (a skill load) is unaffected — still the system note it always was', async () => {
    const path = join(root, 'skill.jsonl')
    await writeFile(path, line({
      type: 'user',
      promptId: 'p5',
      isMeta: true,
      turnCompanion: true,
      message: { content: 'Base directory for this skill: /opt/elsewhere/thing' },
    }) + '\n')
    const out = (await readChatWindow(path, 10)).turns
    expect(out).toEqual([
      { role: 'user', text: 'a skill was loaded', system: 'a skill was loaded' },
    ])
  })

  test('the same resolution reaches the six-row tail reader, not only the full chat window', async () => {
    const path = join(root, 'tail.jsonl')
    await writeFile(path, [
      marker('[Image #1]oi', 'p6', [1]),
      companion('p6', [a]),
    ].join('\n') + '\n')
    const out = await readRecentChatTurns(path, 6)
    expect(out.length).toBe(1)
    expect(out[0]!.imagePaths).toEqual([a])
  })
})

describe('the tool call carries the id its step is opened with', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-ref-'))
    forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const withId = (id: string) => line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'bun test' } }] },
  })

  /**
   * THIS TEST EXISTS BECAUSE THE FIELD WAS DROPPED ONCE, SILENTLY.
   *
   * `ref` shipped with the expanding Live feed in #368. A later merge took the restructured
   * `chat-tail.ts` wholesale, which removed it — while `/api/fleet/step`, the pure `step-detail.ts`
   * and the whole UI all survived. So the feature was in production, complete, and unreachable:
   * every row drew no chevron, because a row with no `ref` deliberately does not open. Nothing
   * failed, nothing was logged, and it was found by somebody asking why clicking did nothing.
   * Measured on the live session that reported it: 257 tool calls, zero with a ref.
   */
  test('a tool_use id reaches the turn as `ref`', async () => {
    const file = join(root, 'conv.jsonl')
    await writeFile(file, `${withId('toolu_01ABC')}\n`)
    const { turns } = await readChatWindow(file)
    const call = turns.flatMap(t => t.tools ?? [])[0]
    expect(call?.ref).toBe('toolu_01ABC')
  })

  test('a transcript that carries no id yields no ref, rather than an empty one', async () => {
    // A row with no `ref` draws no chevron — the honest half of the same rule. An empty string
    // would pass every truthiness check downstream and open onto nothing.
    const file = join(root, 'conv.jsonl')
    await writeFile(file, `${toolUseTurn('Bash')}\n`)
    const { turns } = await readChatWindow(file)
    const call = turns.flatMap(t => t.tools ?? [])[0]
    expect(call?.name).toBe('Bash')
    expect(call?.ref).toBeUndefined()
  })
})

/**
 * THE REPORTED CASE — a session created from the wizard was un-chattable for the life of the
 * server process.
 *
 * A harness writes a conversation's transcript when the conversation first SAYS something, so a
 * session agentop has just started has no file for its first seconds. The chat view's very first
 * poll lands inside that window, and the `null` it got back used to be cached by conversation id
 * forever: the step-3 prompt never appeared, every later message sat at "delivered to the session
 * — not read yet", and no reply ever arrived, while the terminal tab — which reads the pane, not
 * the transcript — showed the whole conversation.
 */
describe('a transcript that does not exist YET', () => {
  const CWD = '/home/u/proj'
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-tail-late-'))
    forgetChatTailPaths(); forgetChatTailContent()
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('is found the moment it appears, not after a restart', async () => {
    // The first poll: nothing on disk.
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(null)

    // The session says its first thing and the harness writes the file.
    const dir = join(root, '-home-u-proj')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${SESSION_ID}.jsonl`)
    await writeFile(file, line({ type: 'user', message: { content: 'oi' } }) + '\n')

    // The next poll finds it. Before the fix this returned the remembered `null` forever.
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(file)
  })

  test('a miss does not spend the whole-tree SCAN on every poll', async () => {
    // The reason the `null` was cached at all. The direct path is one `stat` and is always
    // checked; the scan is a readdir plus a stat per project, and stays paced by the miss TTL.
    const other = join(root, '-somewhere-else')
    await mkdir(other, { recursive: true })
    const now = 1_000_000
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root, now)).toBe(null)

    // Inside the TTL the answer is still null — and the file placed OUTSIDE the direct path is
    // deliberately not found yet, which is what proves the scan was skipped.
    const stray = join(other, `${SESSION_ID}.jsonl`)
    await writeFile(stray, line({ type: 'user', message: { content: 'oi' } }) + '\n')
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root, now + 1000)).toBe(null)

    // Past it, the scan runs again and finds it.
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root, now + 31_000)).toBe(stray)
  })

  test('a path once found is not re-scanned for WHILE IT IS STILL THERE', async () => {
    const dir = join(root, '-home-u-proj')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${SESSION_ID}.jsonl`)
    await writeFile(file, line({ type: 'user', message: { content: 'oi' } }) + '\n')
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(file)
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(file)
  })

  test('THE REPORTED CASE: the transcript MOVED, and the memo must not go on answering the old path', async () => {
    // This test used to assert the opposite, in these words: "removing the tree does not un-answer
    // it: a transcript does not move". It does. Claude Code files a transcript under the project
    // directory derived from the session's CURRENT cwd, so a session whose cwd changes has its
    // `<id>.jsonl` re-filed elsewhere — measured 2026-09-08 on a live 2.4 MB conversation. The
    // stale answer then failed every read, `chat-web.ts` turned that into `turns: []`, and because
    // the session was live it carried no refusal: the panel said "This conversation has no messages
    // yet" over a full transcript, and the user stopped receiving replies altogether.
    const here = join(root, '-home-u-proj')
    await mkdir(here, { recursive: true })
    const first = join(here, `${SESSION_ID}.jsonl`)
    await writeFile(first, line({ type: 'user', message: { content: 'oi' } }) + '\n')
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(first)

    // The cwd changed under the session: same conversation, another project directory.
    const there = join(root, '-home-u-proj--worktrees-x')
    await mkdir(there, { recursive: true })
    const moved = join(there, `${SESSION_ID}.jsonl`)
    await rename(first, moved)

    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(moved)
  })

  test('THE DELETION CASE: a transcript Claude Code cleaned up stops being answered', async () => {
    // No cwd change needed. Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by
    // default) on every startup, so a long-lived server holds a path to a file removed under it.
    const dir = join(root, '-home-u-proj')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${SESSION_ID}.jsonl`)
    await writeFile(file, line({ type: 'user', message: { content: 'oi' } }) + '\n')
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(file)
    await rm(root, { recursive: true, force: true })
    expect(await resolveChatTranscriptPath(CWD, SESSION_ID, root)).toBe(null)
  })
})


describe('a system note carries WHICH thing it is about, where the body named one', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'chat-tail-ref-')); forgetChatTailContent() })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function turnsOf(text: string) {
    const file = join(root, 'x.jsonl')
    await writeFile(file, line({ type: 'user', isMeta: true, message: { content: text } }) + '\n')
    forgetChatTailContent()
    return (await readChatWindow(file, 10)).turns
  }

  test('a skill load reaches the browser naming the skill', async () => {
    // Without this the chip opens the skills tab and lands at the top of a list to be searched —
    // the limitation CLAUDE.md records. The identity was in the body all along.
    const [turn] = await turnsOf(
      'Base directory for this skill: /home/u/.claude/plugins/cache/superpowers-dev/superpowers/6.0.2/skills/brainstorming',
    )
    expect(turn?.system).toBe('a skill was loaded')
    expect(turn?.systemRef).toBe('superpowers:brainstorming')
  })

  test('a note that names nothing carries no reference at all', async () => {
    const [turn] = await turnsOf('Continue from where you left off.')
    expect(turn?.system).toBe('the session was resumed')
    expect(turn?.systemRef).toBeUndefined()
  })
})

describe('the assistant VIEWED an image — viewed-image.ts, end to end', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'chat-tail-viewed-')); forgetChatTailContent() })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const readUse = (uuid: string, parentUuid: string, id: string, filePath: string, name = 'Read') => line({
    type: 'assistant', uuid, parentUuid,
    message: { content: [{ type: 'tool_use', id, name, input: { file_path: filePath } }] },
  })
  const imageResult = (uuid: string, parentUuid: string, toolUseId: string) => line({
    type: 'user', uuid, parentUuid,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'image' }] }] },
  })
  const viewedCompanion = (uuid: string, parentUuid: string) => line({
    type: 'user', uuid, parentUuid, isMeta: true, turnCompanion: true,
    message: { content: '[Image: original 2223x888, displayed at 2000x799. Multiply coordinates by 1.11 to map to original image.]' },
  })

  test('names the note correctly and carries the Read call’s own file_path as systemRef — never "an image was attached"', async () => {
    const path = join(root, 'a.jsonl')
    await writeFile(path, [
      readUse('u1', 'p0', 'toolu_1', '/repo/screenshot.png'),
      imageResult('r1', 'u1', 'toolu_1'),
      viewedCompanion('c1', 'r1'),
    ].join('\n') + '\n')
    const out = (await readChatWindow(path, 10)).turns
    const note = out.find(t => t.system !== undefined)
    expect(note?.system).toBe('the assistant viewed an image')
    expect(note?.systemRef).toBe('/repo/screenshot.png')
  })

  test('THE MEASURED CASE, through the real reader: three Reads, one companion, pairs with the THIRD', async () => {
    const path = join(root, 'b.jsonl')
    await writeFile(path, [
      readUse('u1', 'p0', 'toolu_1', '/repo/small-a.png'),
      imageResult('r1', 'u1', 'toolu_1'),
      readUse('u2', 'r1', 'toolu_2', '/repo/small-b.png'),
      imageResult('r2', 'u2', 'toolu_2'),
      readUse('u3', 'r2', 'toolu_3', '/repo/big-resized.jpg'),
      imageResult('r3', 'u3', 'toolu_3'),
      viewedCompanion('c1', 'r3'),
    ].join('\n') + '\n')
    const out = (await readChatWindow(path, 10)).turns
    const note = out.find(t => t.system !== undefined)
    expect(note?.systemRef).toBe('/repo/big-resized.jpg')
  })

  test('a companion whose chain cannot be traced carries the note and no reference — never a guess', async () => {
    const path = join(root, 'c.jsonl')
    await writeFile(path, viewedCompanion('c1', 'nowhere-in-this-file') + '\n')
    const out = (await readChatWindow(path, 10)).turns
    expect(out).toHaveLength(1)
    expect(out[0]!.system).toBe('the assistant viewed an image')
    expect(out[0]!.systemRef).toBeUndefined()
  })
})
