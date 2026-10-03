/**
 * code-editor.ts — CD-17: the `code` tab's "open the draft in my editor" (`ctrl+g`, `/editor`).
 *
 * Two halves, kept apart on purpose:
 *
 * - PURE: which command to run (`resolveEditorCommand`, `$VISUAL` then `$EDITOR`, split on
 *   whitespace so `code --wait` works) and what to do with the text that comes back
 *   (`stripOneTrailingNewline` — an editor saves a final newline the person never typed, and the
 *   composer would carry it as an empty last line). Both are tested without a terminal.
 * - IO: `createDraftEditor` writes the draft to a 0600 temp file, hands the REAL terminal to the
 *   editor through the control center's suspend (the editor draws a full screen and reads keys; Ink
 *   must not be listening), reads the file back and deletes it — always, in `finally`, because a
 *   draft is the person's own words and must not be left behind in `/tmp`.
 *
 * Every failure is a refusal in words that leaves the draft as it was — the contract's
 * `editDraft` promise. Nothing here throws out.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodeResult } from '@agentistics/tui/control/code-types'

type Lang = 'en' | 'pt'

const T = {
  noEditor: {
    en: 'No editor is set — set $VISUAL or $EDITOR (e.g. `export EDITOR=nano`).',
    pt: 'Nenhum editor definido — defina $VISUAL ou $EDITOR (ex.: `export EDITOR=nano`).',
  },
  noStart: {
    en: (cmd: string) => `The editor \`${cmd}\` could not be started; your draft is unchanged.`,
    pt: (cmd: string) => `Não foi possível iniciar o editor \`${cmd}\`; seu rascunho não mudou.`,
  },
  exited: {
    en: (n: string) => `The editor exited with ${n}; your draft is unchanged.`,
    pt: (n: string) => `O editor terminou com ${n}; seu rascunho não mudou.`,
  },
  noTemp: {
    en: 'The draft could not be written to a temporary file; it is unchanged.',
    pt: 'Não foi possível gravar o rascunho em um arquivo temporário; ele não mudou.',
  },
  noRead: {
    en: 'The edited draft could not be read back; your draft is unchanged.',
    pt: 'Não foi possível ler o rascunho editado; seu rascunho não mudou.',
  },
  edited: {
    en: 'Draft updated from the editor.',
    pt: 'Rascunho atualizado pelo editor.',
  },
} as const

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────

export type EditorCommand = { ok: true; argv: string[]; source: 'VISUAL' | 'EDITOR' | 'fallback' } | { ok: false; reason: 'no-editor' }

/**
 * `$VISUAL` first (the full-screen editor, by the long-standing convention), then `$EDITOR`, each
 * split on whitespace so `code --wait` becomes argv. An empty or blank variable is "not set". When
 * neither is set, `vi` is used ONLY if it is actually on the PATH (`hasVi`) — otherwise the refusal
 * names the variables, rather than spawning something that is not there.
 */
export function resolveEditorCommand(env: Readonly<Record<string, string | undefined>>, hasVi: () => boolean): EditorCommand {
  for (const key of ['VISUAL', 'EDITOR'] as const) {
    const argv = (env[key] ?? '').trim().split(/\s+/).filter(Boolean)
    if (argv.length > 0) return { ok: true, argv, source: key }
  }
  if (hasVi()) return { ok: true, argv: ['vi'], source: 'fallback' }
  return { ok: false, reason: 'no-editor' }
}

/** Exactly ONE trailing newline (`\n` or `\r\n`) removed — a blank line the person typed stays. */
export function stripOneTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

// ── IO ──────────────────────────────────────────────────────────────────────────────────────────

/** How the editor gets the real terminal: the control center's editor suspend (cli-start.ts). */
export type EditorSuspend = <T>(fn: () => Promise<T>) => Promise<T>

export interface DraftEditorOptions {
  suspend: EditorSuspend
  lang: () => Lang
  env?: Readonly<Record<string, string | undefined>>
  /** Default: `command -v vi` through `sh`. */
  hasVi?: () => boolean
  /** Default `os.tmpdir()`. */
  tmpDir?: string
  /** Default `spawnSync` with `stdio: 'inherit'`. */
  run?: (argv: string[]) => { status: number | null; signal: NodeJS.Signals | null; error?: Error }
}

function viOnPath(): boolean {
  const r = spawnSync('sh', ['-c', 'command -v vi'], { stdio: 'ignore', timeout: 3000 })
  return r.status === 0
}

export function createDraftEditor(o: DraftEditorOptions): (draft: string) => Promise<CodeResult<{ text: string; sentence: string }>> {
  const lang = (): Lang => (o.lang() === 'pt' ? 'pt' : 'en')
  const run = o.run ?? ((argv: string[]) => {
    const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' })
    return { status: r.status, signal: r.signal, ...(r.error ? { error: r.error } : {}) }
  })
  return async (draft) => {
    const cmd = resolveEditorCommand(o.env ?? process.env, o.hasVi ?? viOnPath)
    if (!cmd.ok) return { ok: false, sentence: T.noEditor[lang()] }
    const file = join(o.tmpDir ?? tmpdir(), `agentop-draft-${crypto.randomUUID()}.md`)
    try {
      try {
        // `wx`: a name that somehow exists already is refused rather than followed or overwritten.
        writeFileSync(file, draft, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
      } catch {
        return { ok: false, sentence: T.noTemp[lang()] }
      }
      let r: ReturnType<typeof run>
      try {
        r = await o.suspend(async () => run([...cmd.argv, file]))
      } catch {
        return { ok: false, sentence: T.noStart[lang()](cmd.argv[0]!) }
      }
      if (r.error) return { ok: false, sentence: T.noStart[lang()](cmd.argv[0]!) }
      if (r.signal) return { ok: false, sentence: T.exited[lang()](r.signal) }
      if (r.status !== 0) return { ok: false, sentence: T.exited[lang()](String(r.status)) }
      let text: string
      try { text = readFileSync(file, 'utf-8') } catch { return { ok: false, sentence: T.noRead[lang()] } }
      return { ok: true, text: stripOneTrailingNewline(text), sentence: T.edited[lang()] }
    } finally {
      try { rmSync(file, { force: true }) } catch { /* nothing left to do */ }
    }
  }
}
