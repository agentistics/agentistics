/**
 * tools/file/write.ts — `file.write` (kind `file`, permission `ask`; spec §3): create a new file,
 * or overwrite an existing one whole. Creating needs no prior read (there is nothing to be stale
 * against); overwriting an EXISTING file follows the same read-before-write rule as `file.patch`
 * (`../file/fs-io.ts` `checkNotStale`, over the ledger the three file tools share) — a session that
 * never read the file, or read it and it changed since, is refused `stale` rather than silently
 * clobbering whatever changed.
 */

import { readFile } from 'node:fs/promises'
import type { PolicySubject, Tool, ToolContext } from '../contract.ts'
import { defineTool } from '../define.ts'
import { resolveToolPath } from '../paths.ts'
import type { Checkpoint } from './checkpoint.ts'
import { atomicWriteFile, checkNotStale, classifyFsError, ledgerEntryOf, pathExists } from './fs-io.ts'
import type { ReadLedger } from './ledger.ts'

export interface FileWriteInput {
  path: string
  content: string
}

function parseInput(raw: unknown): FileWriteInput | string {
  if (typeof raw !== 'object' || raw === null) return 'file.write expects an object with "path" and "content" strings.'
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || r.path.length === 0) return 'file.write requires a non-empty "path".'
  if (typeof r.content !== 'string') return 'file.write requires a "content" string (may be empty).'
  return { path: r.path, content: r.content }
}

async function subjectsOf(input: FileWriteInput, ctx: ToolContext): Promise<readonly PolicySubject[]> {
  const resolved = await resolveToolPath(ctx.cwd, input.path)
  const exists = await pathExists(resolved)
  return [{ action: 'write', path: resolved, op: exists ? 'overwrite' : 'create' }]
}

export function createFileWriteTool(ledger: ReadLedger, checkpoint: Checkpoint): Tool<FileWriteInput> {
  return defineTool<FileWriteInput>({
    name: 'file.write',
    description: 'Create a new file, or overwrite an existing one, with the given whole content.',
    kind: 'file',
    permission: 'ask',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    parse: parseInput,
    subjects: subjectsOf,
    async run(input, ctx) {
      const resolved = await resolveToolPath(ctx.cwd, input.path)
      const exists = await pathExists(resolved)
      let before: string | null = null

      if (exists) {
        const stale = await checkNotStale(ledger, resolved)
        if (stale.stale) {
          return { ok: false, modelText: `"${input.path}": ${stale.reason}`, error: { class: 'stale', detail: stale.reason } }
        }
        before = (await readFile(resolved)).toString('utf8')
      }

      try {
        await atomicWriteFile(resolved, input.content)
      } catch (e) {
        const cls = classifyFsError(e)
        const detail = `"${input.path}" could not be written.`
        return { ok: false, modelText: detail, error: { class: cls, detail } }
      }

      ledger.record(resolved, await ledgerEntryOf(resolved))
      await checkpoint.record({ path: resolved, before, after: input.content, toolExecutionId: ctx.toolExecutionId }, ctx.now)

      const lines = input.content === '' ? 0 : input.content.split('\n').length
      return {
        ok: true,
        modelText: `${exists ? 'Overwrote' : 'Created'} "${input.path}" (${lines} line(s), ${Buffer.byteLength(input.content, 'utf8')} bytes).`,
        facts: { filesTouched: [resolved] },
        result: { path: resolved, op: exists ? 'overwrite' : 'create' },
      }
    },
  })
}
