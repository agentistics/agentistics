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

/** Ten times the CLI's ordinary answer, and far below a slow one. */
export const AGENTS_DEADLINE_MS = 2_000

type Reader = () => Promise<HarnessAgent[]>

let override: Reader | null = null

/** Replace (or, with null, restore) the reader. Test-only. */
export function __setHarnessAgentsReaderForTest(reader: Reader | null): void {
  override = reader
}

/** `claude agents --json`, or nothing. Never throws, never waits past the deadline. */
export async function readHarnessAgents(): Promise<HarnessAgent[]> {
  if (override) return override()
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    child = Bun.spawn(['claude', 'agents', '--json'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: process.env })
    const proc = child
    const out = Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited])
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), AGENTS_DEADLINE_MS) })
    const done = await Promise.race([out, late])
    if (!done) { proc.kill(); return [] }
    const [text, code] = done
    return code === 0 ? parseHarnessAgents(text) : []
  } catch {
    // No CLI on PATH (spawn throws) or a read error: a machine without the CLI behaves as before.
    child?.kill()
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}
