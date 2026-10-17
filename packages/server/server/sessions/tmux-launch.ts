/** Keep prompt/context payloads out of tmux's command message, independent of the harness. */
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
  return { argv: ['/bin/sh', path], file: { path, text: `#!/bin/sh\nexec ${argv.map(quote).join(' ')}\n` } }
}

export function tmuxSpawnError(code: number, out: string, err: string): string {
  const detail = [err.trim(), out.trim()].filter(Boolean).join('\n')
  return `tmux new-session failed (code ${code})${detail ? `: ${detail}` : ''}`
}
