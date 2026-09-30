/**
 * tools/file/index.ts — B3.3: `file.read` / `file.patch` / `file.write` and the §5 edit checkpoint
 * (spec docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md §3, §4, §5). All three tools
 * share ONE `ReadLedger` (the read-before-write memory `file.patch`/`file.write` check against) and
 * ONE `Checkpoint` (every write either of them makes, for `restore()`) — that is the whole reason
 * this is a factory rather than three standalone `defineTool` exports: a session's file tools must
 * agree on what has been read and what was written, and two independently-constructed ledgers would
 * silently stop agreeing.
 */

import { createCheckpoint, type Checkpoint, type CheckpointStore } from './checkpoint.ts'
import { createReadLedger, type ReadLedger } from './ledger.ts'
import { createFilePatchTool } from './patch.ts'
import { createFileReadTool } from './read.ts'
import { createFileWriteTool } from './write.ts'
import type { Tool } from '../contract.ts'
import type { FilePatch } from './patch-grammar.ts'
import type { FileReadInput } from './read.ts'
import type { FileWriteInput } from './write.ts'

export interface FileToolsOptions {
  /** Reuse an existing ledger (e.g. across a resumed session) instead of starting empty. */
  ledger?: ReadLedger
  /** Where checkpoint entries are kept — defaults to an in-memory store (see `./checkpoint.ts`). */
  checkpointStore?: CheckpointStore
}

export interface FileTools {
  read: Tool<FileReadInput>
  patch: Tool<FilePatch[]>
  write: Tool<FileWriteInput>
  ledger: ReadLedger
  checkpoint: Checkpoint
}

export function createFileTools(opts: FileToolsOptions = {}): FileTools {
  const ledger = opts.ledger ?? createReadLedger()
  const checkpoint = createCheckpoint(opts.checkpointStore)
  return {
    ledger,
    checkpoint,
    read: createFileReadTool(ledger),
    patch: createFilePatchTool(ledger, checkpoint),
    write: createFileWriteTool(ledger, checkpoint),
  }
}

export type { ReadLedger, LedgerEntry } from './ledger.ts'
export type { Checkpoint, CheckpointEntry, CheckpointStore, DiskAccess, RestoreOutcome } from './checkpoint.ts'
export type { FileHunk, FilePatch, PatchLine, PatchOp, PatchParseError } from './patch-grammar.ts'
export { parsePatchText } from './patch-grammar.ts'
export type { MatchTier, LocateOutcome } from './match.ts'
export { locateSnippet, findAll } from './match.ts'
export type { FileReadInput } from './read.ts'
export type { FileWriteInput } from './write.ts'
export type { FilePatchFileResult, FilePatchToolResult } from './patch.ts'
