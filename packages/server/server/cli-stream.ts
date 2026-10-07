/**
 * cli-stream.ts — the control center's OUTPUT CHANNEL: a long command's bytes, as pane lines.
 *
 * The commands whose output is the point — `docker compose up --build`, `bun run
 * bin` — used to run under `suspend`: the app left the alternate screen, the child inherited the
 * real tty, and the user pressed Enter to come back. They now run INSIDE the interface, streaming
 * into a framed pane, which is only possible if nothing they produce reaches the terminal directly.
 * So every one of them is spawned with BOTH pipes captured and never `inherit`.
 *
 * This module is the impure half of that: it owns the subscriber set, the read loops, and the spawn
 * helper. Everything it decides about the BYTES is in `@agentistics/tui/control/stream`, which is
 * pure and tested — the carriage-return collapsing, the escape stripping, the chunk-boundary
 * buffering and the ring bound all live there.
 *
 * It is imported statically by `cli-start.ts`, so it deliberately imports the
 * TUI's stream module by its own subpath rather than through `@agentistics/tui/control`: that entry
 * pulls in Ink and React, which have no business being loaded by a log reader.
 */

import { createLineDecoder } from '@agentistics/tui/control/stream'

type OutputHandler = (line: string) => void

/**
 * The subscribers, module-wide.
 *
 * One control center per process — `runStart()` mounts exactly one Ink app — so a module-level set
 * is the whole of the plumbing, and it means the helpers below can be plain functions rather than
 * closures threaded through every action signature.
 */
const handlers = new Set<OutputHandler>()

/** Subscribe to the current action's output. Returns an unsubscribe. */
export function onOutputLine(handler: OutputHandler): () => void {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

/**
 * Hand lines to every subscriber.
 *
 * Iterated over a COPY: a handler is free to unsubscribe while it runs (the UI's does, when a task
 * finishes), and mutating the set being walked would skip whoever came after it.
 */
export function publishLines(lines: readonly string[]): void {
  if (lines.length === 0 || handlers.size === 0) return
  const targets = [...handlers]
  for (const line of lines) for (const handler of targets) handler(line)
}

/**
 * A sink for one command's raw output: chunks in, lines published, flushed at the end.
 *
 * One per STREAM, never one shared between stdout and stderr: the two are read concurrently, and a
 * single decoder would splice a half-line of one into the middle of the other.
 */
export interface ChunkSink {
  write(chunk: string | Uint8Array): void
  /** Emit the last, unterminated line — the final state of a progress row. */
  flush(): void
}

export function createChunkSink(): ChunkSink {
  const decoder = createLineDecoder()
  return {
    write(chunk) { publishLines(decoder.push(chunk)) },
    flush() { publishLines(decoder.flush()) },
  }
}

/**
 * Read a piped stream to its end, publishing as it goes.
 *
 * A reader loop rather than async iteration, because this runs against whatever `Bun.spawn` hands
 * back and a for-await over a stream is the one part of that shape that has moved. A read that
 * throws — the child was killed mid-write — ends the loop: what arrived is already on screen, and
 * there is nobody to report a broken pipe to.
 */
export async function pumpStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  sink: ChunkSink,
): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) sink.write(value)
    }
  } catch {
    /* the child went away mid-read — whatever it said is already published */
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/**
 * What a piped child is asked to do differently.
 *
 * `NO_COLOR` because the pane owns its palette and a stripped escape is a cell nobody paid for;
 * `BUILDKIT_PROGRESS=plain` because docker's fancy renderer redraws its step table with cursor
 * moves, which flatten into one unreadable row — plain output is newline-terminated, which is what
 * a pane can hold. Both are only defaults: an explicit env from the caller wins.
 */
const STREAM_ENV: Record<string, string> = {
  NO_COLOR: '1',
  BUILDKIT_PROGRESS: 'plain',
}

export interface StreamCommandOptions {
  cwd?: string
  env?: Record<string, string>
}

/**
 * Run a command with both pipes captured, streaming its output into the channel. Returns its code.
 *
 * `stdin: 'ignore'` is not an oversight — it is the other half of the contract. Ink owns the
 * terminal while this runs, so a child reading stdin would race the keyboard for every keystroke;
 * commands that must ASK something still go through `suspend`, which hands over the real tty.
 */
export async function streamCommand(
  cmd: string[],
  opts: StreamCommandOptions = {},
): Promise<number> {
  const out = createChunkSink()
  const err = createChunkSink()
  try {
    const child = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...STREAM_ENV, ...opts.env },
    })
    await Promise.all([pumpStream(child.stdout, out), pumpStream(child.stderr, err)])
    return await child.exited
  } catch (err2) {
    // A command that cannot be spawned at all still has to say so somewhere the user is looking.
    publishLines([`${cmd[0]}: ${err2 instanceof Error ? err2.message : String(err2)}`])
    return 127
  } finally {
    out.flush()
    err.flush()
  }
}
