/**
 * bash-mode.ts — PURE: a `!` command the person ran inside a Claude Code session, and what it printed.
 *
 * Claude Code's bash mode (a prompt line starting with `!`) runs the line in a shell WITHOUT a model
 * turn, and records it as TWO `user` entries with string content. MEASURED on this machine
 * (2026-09-30, every transcript under `~/.claude/projects`, 9 pairs across 6 conversations):
 *
 *   uuid A   '<bash-input>agentop upgrade</bash-input>'
 *   uuid B   '<bash-stdout>Checking for updates…\x1b[92m…</bash-stdout><bash-stderr></bash-stderr>'
 *            parentUuid = A — on every pair, and always the very next line
 *
 * No `isMeta`, no content array, no `<local-command-caveat>` on either. The stdout carries the
 * command's own ANSI colours verbatim, and both tags are always present (an empty one is `<x></x>`).
 *
 * What the chat drew before this module: the input unwrapped to `agentop upgrade` (without the `!`
 * the person typed) and the output as a bare "command output" chip. Two consequences, both reported
 * by the owner on a screenshot: the executed command never looked executed, and the composer's echo
 * — `!agentop upgrade`, exactly what was sent — never matched the stored turn, so it sat under
 * "delivered — not read yet" forever while the terminal beside it showed the whole run.
 *
 * So the input is read back as the person's own `!line`, and the output is PAIRED to it by the exact
 * `parentUuid` link — never by position, which is the mistake `workflow-match.ts` exists to have
 * fixed once. An output whose input is outside the read window stays the note it always was.
 */

import type { ShellOutput } from '@agentistics/core'

/** The shapes live in core beside `ChatTurn` (engine-api 1.9); re-exported so nothing that imports them from here moves. */
export type { ShellOutput, ShellRun } from '@agentistics/core'



/**
 * The most of each stream the chat carries. A `!cat` of a large file is a legitimate thing to run,
 * and this payload is re-sent on every chat poll — the END is kept, because that is where a build's
 * verdict and a command's error are.
 */
export const MAX_SHELL_OUTPUT = 16_000

const INPUT_RE = /^<bash-input>([\s\S]*)<\/bash-input>$/
const OUTPUT_RE = /^<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?$/
const STDERR_ONLY_RE = /^<bash-stderr>([\s\S]*?)<\/bash-stderr>$/

// CSI sequences (colours, cursor moves) and the two-byte OSC/charset forms a CLI prints.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g

/** The command inside a `<bash-input>` entry, or `null` when the text is not one. */
export function parseBashInput(text: string): string | null {
  const m = INPUT_RE.exec(text.trim())
  if (!m) return null
  const cmd = m[1]!.trim()
  return cmd === '' ? null : cmd
}

/** Strip terminal escapes and normalise `\r\n`; a lone `\r` (a progress redraw) keeps its last frame. */
export function cleanShellText(raw: string): string {
  return raw
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => {
      const parts = line.split('\r')
      return parts[parts.length - 1]!
    })
    .join('\n')
    .replace(/\s+$/, '')
}

function capTail(s: string): { text: string; cut: boolean } {
  return s.length > MAX_SHELL_OUTPUT ? { text: s.slice(s.length - MAX_SHELL_OUTPUT), cut: true } : { text: s, cut: false }
}

/** The streams inside a `<bash-stdout>`/`<bash-stderr>` entry, or `null` when the text is not one. */
export function parseBashOutput(text: string): ShellOutput | null {
  const t = text.trim()
  const m = OUTPUT_RE.exec(t)
  const e = m ? null : STDERR_ONLY_RE.exec(t)
  if (!m && !e) return null
  const stdout = capTail(cleanShellText(m ? m[1]! : ''))
  const stderr = capTail(cleanShellText(m ? (m[2] ?? '') : e![1]!))
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    ...(stdout.cut || stderr.cut ? { truncated: true } : {}),
  }
}

/** The text of a plain (non-meta) `user` entry whose content is a STRING — the only shape bash mode writes. */
export function bashEntryText(e: Record<string, unknown>): string | null {
  if (e.type !== 'user' || e.isMeta === true) return null
  const c = (e.message as Record<string, unknown> | undefined)?.content
  return typeof c === 'string' ? c : null
}
