/**
 * tools/file/patch-grammar.ts — the pure parser for `file.patch`'s input grammar (spec §2 D-T1,
 * §4 `FilePatch`): Codex `apply_patch`-style TEXT, never JSON — "it removes a whole class of
 * escaping failure from multi-line edits" (§2). This module only turns that text into the typed
 * `FilePatch[]` structure; it never touches a filesystem and never decides whether a hunk's
 * context actually matches anything on disk (`./match.ts` does that).
 *
 * ## Grammar (one patch, any number of file sections)
 *
 * ```
 * *** Begin Patch
 * *** Add File: <path>
 * +line
 * +line
 * *** Delete File: <path>
 * *** Update File: <path>
 * *** Move to: <newPath>        (optional, only after Update File)
 * @@ <optional context line>    (0+ of these, stacked, before a hunk's body)
 *  context line
 * -removed line
 * +added line
 * *** End Patch
 * ```
 *
 * An `Update File` section may repeat `@@ …` hunks any number of times (non-contiguous edits to
 * one file); `Move to` — when present — is read once, immediately after `Update File`, and is
 * carried on the FIRST hunk only (`UpdateHunk.moveTo`), because a rename is a fact about the FILE,
 * not about any one hunk. A rename with no content change is legal (`Move to` with zero `@@`
 * blocks) and parses to one hunk with empty `context`/`lines` — `../file/patch.ts` reads that as
 * "just move, nothing to locate".
 *
 * Every failure names the 1-based LINE it failed at (§ "a malformed patch is invalid-input naming
 * the line") — `FileToolInput.parse` turns that into the tool's `invalid-input` refusal, so a
 * malformed patch never reaches the policy at all.
 */

export type PatchOp = ' ' | '+' | '-'

export interface PatchLine {
  op: PatchOp
  text: string
}

export type FileHunk =
  | { kind: 'add'; body: string }
  | { kind: 'delete' }
  | { kind: 'update'; moveTo?: string; context: string[]; lines: PatchLine[] }

export interface FilePatch {
  path: string
  hunks: FileHunk[]
}

export interface PatchParseError {
  line: number
  message: string
}

function err(line: number, message: string): PatchParseError {
  return { line, message }
}

function splitLines(text: string): string[] {
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
  // A trailing newline produces one trailing '' element that is not a real line of the patch.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

const ADD_PREFIX = '*** Add File: '
const DELETE_PREFIX = '*** Delete File: '
const UPDATE_PREFIX = '*** Update File: '
const MOVE_PREFIX = '*** Move to: '
const BEGIN = '*** Begin Patch'
const END = '*** End Patch'

/** Parses the whole `*** Begin Patch … *** End Patch` text into one `FilePatch` per file section. */
export function parsePatchText(text: string): FilePatch[] | PatchParseError {
  const lines = splitLines(text)
  if (lines.length === 0) return err(1, 'the patch is empty')
  if (lines[0]!.trim() !== BEGIN) return err(1, `expected "${BEGIN}" as the first line`)

  const files: FilePatch[] = []
  let i = 1
  let sawEnd = false

  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === END) {
      sawEnd = true
      i++
      break
    }
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith(ADD_PREFIX)) {
      const path = line.slice(ADD_PREFIX.length).trim()
      if (!path) return err(i + 1, 'Add File is missing a path')
      i++
      const bodyLines: string[] = []
      while (i < lines.length && !lines[i]!.startsWith('*** ')) {
        const l = lines[i]!
        if (l !== '' && l[0] !== '+') {
          return err(i + 1, `expected a '+'-prefixed line in the body of "Add File: ${path}", got: ${JSON.stringify(l)}`)
        }
        bodyLines.push(l === '' ? '' : l.slice(1))
        i++
      }
      files.push({ path, hunks: [{ kind: 'add', body: bodyLines.join('\n') }] })
      continue
    }
    if (line.startsWith(DELETE_PREFIX)) {
      const path = line.slice(DELETE_PREFIX.length).trim()
      if (!path) return err(i + 1, 'Delete File is missing a path')
      i++
      files.push({ path, hunks: [{ kind: 'delete' }] })
      continue
    }
    if (line.startsWith(UPDATE_PREFIX)) {
      const path = line.slice(UPDATE_PREFIX.length).trim()
      if (!path) return err(i + 1, 'Update File is missing a path')
      i++
      let moveTo: string | undefined
      if (i < lines.length && lines[i]!.startsWith(MOVE_PREFIX)) {
        moveTo = lines[i]!.slice(MOVE_PREFIX.length).trim()
        if (!moveTo) return err(i + 1, 'Move to is missing a path')
        i++
      }
      const hunks: FileHunk[] = []
      let first = true
      while (i < lines.length && lines[i]!.startsWith('@@')) {
        const context: string[] = []
        while (i < lines.length && lines[i]!.startsWith('@@')) {
          const t = lines[i]!.slice(2).trim()
          if (t) context.push(t)
          i++
        }
        const hunkLines: PatchLine[] = []
        while (i < lines.length && !lines[i]!.startsWith('*** ') && !lines[i]!.startsWith('@@')) {
          const l = lines[i]!
          if (l === '') {
            hunkLines.push({ op: ' ', text: '' })
            i++
            continue
          }
          const op = l[0] as PatchOp
          if (op !== ' ' && op !== '+' && op !== '-') {
            return err(
              i + 1,
              `expected a ' '/'+'/'-'-prefixed line in an update hunk of "${path}", got: ${JSON.stringify(l)}`
            )
          }
          hunkLines.push({ op, text: l.slice(1) })
          i++
        }
        if (hunkLines.length === 0) return err(i, `an update hunk of "${path}" has no lines`)
        hunks.push({ kind: 'update', moveTo: first ? moveTo : undefined, context, lines: hunkLines })
        first = false
      }
      if (hunks.length === 0) {
        if (moveTo === undefined) {
          return err(i + 1, `Update File "${path}" has no hunks and no Move to — nothing to apply`)
        }
        hunks.push({ kind: 'update', moveTo, context: [], lines: [] })
      }
      files.push({ path, hunks })
      continue
    }
    return err(i + 1, `unexpected line: ${JSON.stringify(line)}`)
  }

  if (!sawEnd) return err(lines.length, `missing "${END}"`)
  if (files.length === 0) return err(1, 'the patch has no file sections')
  return files
}
