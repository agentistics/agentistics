/**
 * tools/file/read.ts — `file.read` (kind `file`, permission `auto`; spec §3). Bounded, line-
 * numbered like `cat -n`, and the ONE place a `file.patch`/`file.write` on the same path later
 * gets to call itself "read before write": every call — text or binary — records the FULL file's
 * {sha256, mtimeMs, size} in the shared ledger, regardless of how much of it was actually shown.
 */

import { readFile, stat } from 'node:fs/promises'
import type { PolicySubject, Tool, ToolContext } from '../contract.ts'
import { defineTool } from '../define.ts'
import { resolveToolPath } from '../paths.ts'
import { mimeByExtension, looksBinary } from './binary.ts'
import { sha256OfBuffer, splitFileLines } from './fs-io.ts'
import type { ReadLedger } from './ledger.ts'

export interface FileReadInput {
  path: string
  /** 1-based first line to show. Default 1. */
  offset?: number
  /** Maximum number of lines to show. Default `DEFAULT_LINE_CAP`, hard ceiling `MAX_LINE_CAP`. */
  limit?: number
}

export const DEFAULT_LINE_CAP = 2000
export const MAX_LINE_CAP = 10_000
export const BYTE_CAP = 256 * 1024

function padLineNumber(n: number): string {
  return String(n).padStart(6, ' ')
}

function parseInput(raw: unknown): FileReadInput | string {
  if (typeof raw !== 'object' || raw === null) return 'file.read expects an object with a "path" string.'
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || r.path.length === 0) return 'file.read requires a non-empty "path".'
  if (r.offset !== undefined && (typeof r.offset !== 'number' || r.offset < 1)) {
    return 'file.read\'s "offset" must be a 1-based line number.'
  }
  if (r.limit !== undefined && (typeof r.limit !== 'number' || r.limit < 1)) {
    return 'file.read\'s "limit" must be a positive number of lines.'
  }
  return { path: r.path, offset: r.offset as number | undefined, limit: r.limit as number | undefined }
}

async function subjectsOf(input: FileReadInput, ctx: ToolContext): Promise<readonly PolicySubject[]> {
  const resolved = await resolveToolPath(ctx.cwd, input.path)
  return [{ action: 'read', path: resolved }]
}

export function createFileReadTool(ledger: ReadLedger): Tool<FileReadInput> {
  return defineTool<FileReadInput>({
    name: 'file.read',
    description: 'Read a file or a line range of it. Images and PDFs are returned by reference, not inline.',
    kind: 'file',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', minimum: 1 },
        limit: { type: 'number', minimum: 1 },
      },
      required: ['path'],
    },
    parse: parseInput,
    subjects: subjectsOf,
    async run(input, ctx) {
      const resolved = await resolveToolPath(ctx.cwd, input.path)
      let buf: Buffer
      let st: Awaited<ReturnType<typeof stat>>
      try {
        ;[buf, st] = await Promise.all([readFile(resolved), stat(resolved)])
      } catch (e) {
        const code = (e as { code?: string } | null)?.code
        if (code === 'ENOENT') {
          return { ok: false, modelText: `"${input.path}" does not exist.`, error: { class: 'not-found', detail: `"${input.path}" does not exist.` } }
        }
        if (code === 'EACCES' || code === 'EPERM') {
          return { ok: false, modelText: `"${input.path}" could not be read (permission denied).`, error: { class: 'permission' } }
        }
        throw e
      }
      const sha256 = sha256OfBuffer(buf)
      ledger.record(resolved, { sha256, mtimeMs: st.mtimeMs, size: buf.length })

      const knownMime = mimeByExtension(resolved)
      const mime = knownMime ?? (looksBinary(buf) ? 'application/octet-stream' : undefined)
      if (mime) {
        const modelText = `"${input.path}" is a binary file (${mime}, ${buf.length} bytes) — returned by reference, not inline.`
        return {
          ok: true,
          modelText,
          facts: { filesTouched: [resolved] },
          result: { kind: 'binary', path: resolved, bytes: buf.length, mime },
        }
      }

      const text = buf.toString('utf8')
      const { lines } = splitFileLines(text)
      const totalLines = lines.length
      const offset = Math.max(1, input.offset ?? 1)
      const cap = Math.min(input.limit ?? DEFAULT_LINE_CAP, MAX_LINE_CAP)
      const window = lines.slice(offset - 1, offset - 1 + cap)

      let usedBytes = 0
      const shown: string[] = []
      let cutForBytes = false
      for (const line of window) {
        const bytes = Buffer.byteLength(line, 'utf8') + 1
        if (shown.length > 0 && usedBytes + bytes > BYTE_CAP) {
          cutForBytes = true
          break
        }
        usedBytes += bytes
        shown.push(line)
      }

      const lastShown = offset - 1 + shown.length
      const remaining = totalLines - lastShown
      const numbered = shown.map((l, idx) => `${padLineNumber(offset + idx)}\t${l}`).join('\n')

      let header = `"${input.path}" — ${totalLines} line(s), ${buf.length} byte(s).`
      if (offset === 1 && shown.length === totalLines && !cutForBytes) {
        header += ' Showing the whole file.'
      } else {
        header += ` Showing lines ${offset}-${lastShown}.`
        if (remaining > 0) {
          header += ` ${remaining} more line(s) not shown${cutForBytes ? ' (byte cap reached)' : ' (line cap reached)'}.`
        }
      }

      return {
        ok: true,
        modelText: `${header}\n\n${numbered}`,
        facts: { filesTouched: [resolved] },
        result: {
          kind: 'text',
          path: resolved,
          totalLines,
          totalBytes: buf.length,
          shownFrom: offset,
          shownTo: lastShown,
          truncated: remaining > 0,
        },
      }
    },
  })
}
