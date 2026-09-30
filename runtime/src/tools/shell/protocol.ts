/**
 * tools/shell/protocol.ts — PURE: how a command is handed to the persistent shell and how its end is
 * recognised in the output stream.
 *
 * ## Two channels, on purpose
 *
 * The persistent shell reads its COMMANDS from fd 3 (NUL-terminated, `read -r -d ""`) and leaves fd 0
 * to the command it is running. With one channel, `shell.write` bytes a command did not consume
 * would be read by bash as the NEXT COMMAND once the current one finished — stdin the policy judged
 * as `shell-input` executed as a `shell` command nobody's rule ever saw. On fd 3 the control line is
 * unreachable from `shell.write`, and the command itself runs with fd 3 closed (`3<&-`) so it cannot
 * read (or eat) the control channel either.
 *
 * ## The end marker cannot be forged
 *
 * After the command, the wrapper prints `\n__AGT_<nonce>_<status>_<PWD>\n`. The nonce is 128 random
 * bits minted per CALL and it never appears on the output channel before the real marker (the
 * control line travels on fd 3, not stdout, and nothing echoes it). A command that prints something
 * shaped like a marker — or replays an old one — carries the wrong nonce and is plain output.
 *
 * ## Per-call `cwd` (46 % of real shell calls start with `cd`, §1)
 *
 * When a call names a `cwd`, the wrapper enters it for that call and, afterwards, RETURNS to where the
 * session was — unless the command itself moved (`$PWD` is no longer the call's `cwd`), in which case
 * the session stays where the command went. So `{cwd: "pkg", command: "bun test"}` does not drag the
 * session into `pkg`, while `{command: "cd pkg"}` (or `{cwd: "pkg", command: "cd sub"}`) does move it,
 * exactly as it would in a terminal. `export`, functions and aliases always persist: the command runs
 * in the session shell itself (`eval`), never in a subshell.
 */

/** Single-quote for bash: the only character that needs escaping inside '…' is ' itself. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

export function mintNonce(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

/** What the scanner looks for. The wrapper prints a `\n` right before it (see `MarkerScanner`). */
export function markerCore(nonce: string): string {
  return `__AGT_${nonce}_`
}

export function markerPrefix(nonce: string): string {
  return `\n${markerCore(nonce)}`
}

/**
 * The loop the persistent shell runs: read one NUL-terminated line from fd 3, eval it, repeat. stderr
 * is merged into stdout once, here, so the model reads one stream in the order it was written.
 */
export const SESSION_SCRIPT = 'exec 2>&1; while IFS= read -r -d "" __agt_line <&3; do eval "$__agt_line"; done'

/** The control line for one call (without its NUL terminator). */
export function controlLine(command: string, nonce: string, cwd?: string): string {
  const parts: string[] = []
  if (cwd !== undefined) {
    parts.push(`__agt_prev=$PWD`)
    parts.push(`cd -- ${shq(cwd)} && { eval ${shq(command)}; } 3<&-`)
    parts.push(`__agt_s=$?`)
    parts.push(`[ "$PWD" = ${shq(cwd)} ] && cd -- "$__agt_prev"`)
  } else {
    parts.push(`{ eval ${shq(command)}; } 3<&-`)
    parts.push(`__agt_s=$?`)
  }
  parts.push(`printf '\\n__AGT_%s_%s_%s\\n' ${shq(nonce)} "$__agt_s" "$PWD"`)
  return parts.join('; ')
}

export interface MarkerEnd {
  status: number
  /** The session's directory after the call; `undefined` when it could not be read back. */
  pwd?: string
}

/**
 * Splits a stream into the command's output and its end marker. Output is released as soon as it
 * cannot be the start of the marker, so a yielded command's partial output is readable while it runs.
 * A `$PWD` containing a newline cannot be read back; the call still ends correctly and the session's
 * directory is reported as unknown.
 */
export class MarkerScanner {
  private buf = ''
  private readonly core: string
  private readonly prefix: string

  constructor(nonce: string) {
    this.core = markerCore(nonce)
    this.prefix = markerPrefix(nonce)
  }

  push(chunk: string): { output: string; end?: MarkerEnd } {
    this.buf += chunk
    const idx = this.buf.indexOf(this.core)
    if (idx >= 0) {
      // The `\n` the wrapper printed before the marker is ours, not the command's. It is either still
      // in the buffer right before the marker, or it was already released by `release()`.
      const cut = idx > 0 && this.buf[idx - 1] === '\n' ? idx - 1 : idx
      const nl = this.buf.indexOf('\n', idx + this.core.length)
      if (nl < 0) {
        const output = this.buf.slice(0, cut)
        this.buf = this.buf.slice(cut)
        return { output }
      }
      const body = this.buf.slice(idx + this.core.length, nl)
      const output = this.buf.slice(0, cut)
      this.buf = ''
      const m = /^(\d+)_(.*)$/.exec(body)
      if (!m) return { output, end: { status: Number.parseInt(body, 10) || 0 } }
      return { output, end: { status: Number(m[1]), pwd: m[2] === '' ? undefined : m[2] } }
    }
    // Hold back the longest suffix that could still grow into the marker (with its leading `\n`).
    let keep = 0
    for (let k = Math.min(this.prefix.length - 1, this.buf.length); k > 0; k--) {
      if (this.prefix.startsWith(this.buf.slice(this.buf.length - k))) { keep = k; break }
    }
    const output = this.buf.slice(0, this.buf.length - keep)
    this.buf = this.buf.slice(this.buf.length - keep)
    return { output }
  }

  /**
   * Called when a running command's output is read: a held-back lone trailing `\n` is released, so a
   * read of `echo first` shows `first\n` rather than `first` and the next read does not start with a
   * stray newline. A held-back partial MARKER is never released — the marker could not be found then.
   */
  release(): string {
    if (this.buf !== '\n') return ''
    this.buf = ''
    return '\n'
  }

  /** Whatever was held back — the process ended without printing the marker. */
  flush(): string {
    const rest = this.buf
    this.buf = ''
    return rest
  }
}
