/**
 * harness-agents-io.ts — the ONE place agentop asks the harness `claude agents --json`.
 *
 * Two callers used to run it themselves (`live-claims.ts` for the reopen lock, `cli-session.ts`
 * for a takeover by name), both through `Bun.spawnSync` with no deadline. That is two defects:
 *
 *  - SYNCHRONOUS. A spawnSync blocks the whole event loop until the CLI exits, so a server answering
 *    a resume froze every other request for as long as the CLI took — and so did a test's own
 *    timer, which is why a slow run surfaced as a timeout far from its cause.
 *  - UNBOUNDED. The CLI usually answers in ~0.2 s, but measured on 2026-10-18 against claude
 *    2.1.302 it intermittently took ~5.1 s (one call in two, in a run with no login). Every resume
 *    paid that, and a test calling resume twice exceeded bun's 5 s default on its own.
 *
 * So the read is asynchronous and bounded: past `AGENTS_DEADLINE_MS` the child is killed and the
 * answer is "nothing" — the same degradation a machine without the CLI already gets, and the one
 * `live-claims.ts` documents ("every failure degrades to 'we do not know', never to a refusal").
 *
 * Tests replace the reader with `__setHarnessAgentsReaderForTest`: a unit test must not depend on
 * whichever `claude` binary the machine running it happens to have installed.
 */

import { parseHarnessAgents, type HarnessAgent } from './harness-agents'

/**
 * Twice the slowest answer measured (~5.1 s). The read is asynchronous, so waiting costs nothing but
 * the caller's own latency — and giving up too early is worse than waiting: the reopen lock and the
 * takeover then see "nothing holds this conversation" and could reopen one that is still alive.
 */
export const AGENTS_DEADLINE_MS = 10_000

type Reader = () => Promise<HarnessAgent[]>

let override: Reader | null = null

/** Replace (or, with null, restore) the reader. Test-only. */
export function __setHarnessAgentsReaderForTest(reader: Reader | null): void {
  override = reader
}

/**
 * `claude agents --json`, or nothing. Never throws, never waits past the deadline.
 *
 * The child runs in its OWN process group (`detached`), and a late one is killed as a GROUP with its
 * pipe cancelled: killing only the CLI would leave any helper it forked holding stdout open, and the
 * read — and the process — would outlive the deadline it was given.
 */
export async function readHarnessAgents(deadlineMs: number = AGENTS_DEADLINE_MS): Promise<HarnessAgent[]> {
  if (override) return override()
  let child: ReturnType<typeof Bun.spawn> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    reader?.cancel().catch(() => {})
  }
  try {
    child = Bun.spawn(['claude', 'agents', '--json'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: process.env, detached: true,
    })
    const proc = child
    reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const read = reader
    const text = (async () => {
      const chunks: Uint8Array[] = []
      for (;;) {
        const { done, value } = await read.read()
        if (done) break
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString()
    })()
    const out = Promise.all([text, proc.exited])
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), deadlineMs) })
    const done = await Promise.race([out, late])
    if (!done) { stop(); out.catch(() => {}); return [] }
    const [raw, code] = done
    return code === 0 ? parseHarnessAgents(raw) : []
  } catch {
    // No CLI on PATH (spawn throws) or a read error: a machine without the CLI behaves as before.
    stop()
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}
