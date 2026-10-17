/** Keep prompt/context payloads out of tmux's command message, independent of the harness. */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pasteBufferName, TMUX_SOCKET, tmuxName } from './tmux-cli'

// Leave room for tmux's options/environment below the observed ~4 KB failure boundary.
const INLINE_ARGV_BYTES = 2048

/** POSIX shell literal: no expansion of $, backticks, quotes, or embedded newlines. */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, `'"'"'`)}'`
}

function needsPayloadTransport(argv: string[]): boolean {
  return argv.reduce((n, arg) => n + Buffer.byteLength(arg, 'utf8') + 1, 0) > INLINE_ARGV_BYTES
    || argv.some(arg => /[\r\n]/.test(arg))
}

/** First-message channels (e.g. kimi) also keep their context off send-keys' command line. */
export function planTmuxLiteral(id: string, text: string): { load: string[]; paste: string[]; stdin: string } | null {
  if (!needsPayloadTransport([text])) return null
  const name = pasteBufferName(id)
  return {
    load: ['-L', TMUX_SOCKET, 'load-buffer', '-b', name, '-'],
    // Raw paste, without bracketed-paste markers or LF -> CR conversion: same bytes as send-keys -l.
    paste: ['-L', TMUX_SOCKET, 'paste-buffer', '-r', '-d', '-b', name, '-t', tmuxName(id)],
    stdin: text,
  }
}

export function planTmuxLaunch(argv: string[], dir: string, nonce: string): {
  argv: string[]
  file?: { path: string; text: string }
} {
  if (!needsPayloadTransport(argv)) return { argv }
  const path = join(dir, `launch-${nonce}.sh`)
  // exec preserves the pane pid, signals, terminal and exit status. The script is data on disk;
  // tmux only sees /bin/sh and its short path, never the payload, even for first-message channels.
  // The launcher deletes itself before anything else: the shell already holds the open file, so the
  // rest is still read, while the context never outlives the one read tmux's pane makes of it.
  // Done by the script rather than by the backend because the backend cannot know when the pane
  // has read it (`new-session` returns before the shell does).
  return { argv: ['/bin/sh', path], file: { path, text: `#!/bin/sh\nrm -f -- "$0"\nexec ${argv.map(quote).join(' ')}\n` } }
}

const LAUNCHER_NAME = /^launch-[0-9a-f-]+\.sh$/i
export const STALE_LAUNCHER_MS = 10 * 60_000
const SWEEP_MAX_DIRS = 500

/**
 * Remove launchers a crashed spawn left behind (written, never run). Only files named like the
 * ones `planTmuxLaunch` makes, directly inside `<root>/<session-id>/`, older than `maxAgeMs`.
 * Never throws; bounded by `SWEEP_MAX_DIRS`. Returns how many were removed.
 */
export async function sweepStaleLaunchers(root: string, now = Date.now(), maxAgeMs = STALE_LAUNCHER_MS): Promise<number> {
  let removed = 0
  const dirs = (await readdir(root).catch(() => [] as string[])).slice(0, SWEEP_MAX_DIRS)
  for (const d of dirs) {
    const dir = join(root, d)
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!LAUNCHER_NAME.test(f)) continue
      const path = join(dir, f)
      const st = await stat(path).catch(() => null)
      if (!st?.isFile() || now - st.mtimeMs < maxAgeMs) continue
      if (await unlink(path).then(() => true, () => false)) removed++
    }
  }
  return removed
}

export function tmuxSpawnError(code: number, out: string, err: string): string {
  const detail = [err.trim(), out.trim()].filter(Boolean).join('\n')
  return `tmux new-session failed (code ${code})${detail ? `: ${detail}` : ''}`
}
