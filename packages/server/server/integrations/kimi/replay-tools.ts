/**
 * integrations/kimi/replay-tools.ts — PURE. One `tool.requested` per `context.append_loop_event`
 * `tool.call`, one `tool.completed`/`tool.failed` per matching `tool.result` — paired by the
 * harness's own `toolCallId`, which both carry (verified on real wire data: `tool.call.toolCallId`
 * and `tool.result.toolCallId`, the latter also repeated on `parentUuid` pointing at the call's own
 * `uuid`).
 *
 * No cross-line state is needed: a `tool.result` names its own `toolCallId` and carries its own
 * error signal, so nothing from the REQUEST has to be remembered to build the RESPONSE event —
 * unlike Claude's Edit/Write tools. `HARNESS_CAPABILITIES.kimi.gitLines` is `false` ("Kimi records
 * the Edit/Write strings but no diff counters"), and legacy's `buildKimiSession` hardcodes
 * `lines_added: 0, lines_removed: 0, files_modified: 0` for EVERY kimi session regardless of what
 * ran — so this replay deliberately does not populate `filesTouched`/`linesAdded`/`linesRemoved`
 * either. Inventing a real figure here (which the request's own `args.path`/`args.content` would
 * make possible) would turn a declared, always-0 legacy absence into a genuine mismatch instead of
 * the EQUAL 0-vs-0 the differential expects.
 *
 * ## The error check is REUSED, not reimplemented — including its measured limitation
 * `isToolError` (`adapters/kimi-parse.ts`, exported for this replay) is called on the SAME shape
 * legacy passes it: the loop event itself (`{type:'tool.result', parentUuid, toolCallId, result}`),
 * never `event.result`. On this integration's real store every genuine `result.isError: true` flag
 * sits ONE LEVEL DEEPER than `isToolError` checks (`ev.isError`, not `ev.result.isError`) — measured:
 * 21 nested flags across the 16 real kimi sessions here, 0 detected by `isToolError` on either the
 * legacy or the replay side. This is a PRE-EXISTING FINDING in `kimi-parse.ts`, reproduced here on
 * purpose for parity (never "fixed" independently, which the shared brief forbids: this file may
 * only ADD `export` to that module, never change its behaviour) — see this integration's handback.
 */
import { redactSecrets } from '@agentistics/core'
import { canonicalTool } from '../../harness-activity'
import { commandSummary } from '../../sessions/shell-writes'
import { isToolError } from '../../adapters/kimi-parse'
import type { ToolCompletedData, ToolFailedData, ToolKind, ToolRequestedData } from '@agentistics/core'
import { lineRef, makeEvent, str, timeOf, toolExecutionIdOf, type EmitEvent, type KimiReplayContext } from './replay-core'

const SHELL_NAMES = new Set(['Bash'])
const FILE_NAMES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SEARCH_NAMES = new Set(['Grep', 'Glob'])
const AGENT_NAMES = new Set(['Agent', 'AgentSwarm', 'Task'])

/** The `<server>` segment of an `mcp__<server>__<tool>` name, up to the NEXT `__`. */
function mcpServerOf(canonicalName: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(canonicalName)
  return m?.[1]
}

/**
 * `Bash` -> shell; `Read`/`Write`/`Edit`/`MultiEdit`/`NotebookEdit` -> file; `Grep`/`Glob` -> search;
 * `mcp__<server>__<tool>` -> mcp; `Agent`/`AgentSwarm`/`Task` -> agent; everything else `other` —
 * never guessed as `browser`, which nothing in a kimi `tool.call` name ever states.
 */
function classifyTool(canonicalName: string): { kind: ToolKind; mcpServer?: string } {
  const mcpServer = mcpServerOf(canonicalName)
  if (mcpServer) return { kind: 'mcp', mcpServer }
  if (canonicalName.startsWith('mcp__')) return { kind: 'mcp' }
  if (SHELL_NAMES.has(canonicalName)) return { kind: 'shell' }
  if (FILE_NAMES.has(canonicalName)) return { kind: 'file' }
  if (SEARCH_NAMES.has(canonicalName)) return { kind: 'search' }
  if (AGENT_NAMES.has(canonicalName)) return { kind: 'agent' }
  return { kind: 'other' }
}

/** `entry.event`, when `entry.type === 'context.append_loop_event'`. */
function loopEventOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type !== 'context.append_loop_event') return undefined
  const ev = entry.event
  return ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : undefined
}

function foldToolCall(
  ctx: KimiReplayContext, ev: Record<string, unknown>, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const toolCallId = str(ev.toolCallId)
  const name = str(ev.name)
  if (!toolCallId || !name) return

  const canonicalName = canonicalTool('kimi', name)
  const { kind, mcpServer } = classifyTool(canonicalName)
  const data: ToolRequestedData = {
    toolExecutionId: toolExecutionIdOf(ctx.kimiSessionId, toolCallId),
    name, canonicalName, kind,
  }
  if (mcpServer) data.mcpServer = mcpServer
  if (kind === 'shell') {
    const args = ev.args as Record<string, unknown> | undefined
    const cmd = str(args?.command)
    if (cmd) data.summary = redactSecrets(commandSummary(cmd))
  }

  const at = timeOf(entry)
  emit(makeEvent(ctx, 'tool.requested', data, {
    sourceRef: lineRef(ctx, lineNo), occurredAt: at ?? ctx.recordedAt, confidence: at ? 'exact' : 'estimated',
  }))
}

function foldToolResult(
  ctx: KimiReplayContext, ev: Record<string, unknown>, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const toolCallId = str(ev.toolCallId)
  if (!toolCallId) return
  const toolExecutionId = toolExecutionIdOf(ctx.kimiSessionId, toolCallId)
  const at = timeOf(entry)
  const confidence: 'exact' | 'estimated' = at ? 'exact' : 'estimated'
  const opts = { sourceRef: lineRef(ctx, lineNo), occurredAt: at ?? ctx.recordedAt, confidence }

  if (isToolError(ev)) {
    const data: ToolFailedData = { toolExecutionId, status: 'failed' }
    emit(makeEvent(ctx, 'tool.failed', data, opts))
    return
  }
  const data: ToolCompletedData = { toolExecutionId }
  emit(makeEvent(ctx, 'tool.completed', data, opts))
}

export function foldToolEntry(
  ctx: KimiReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const ev = loopEventOf(entry)
  if (!ev) return
  if (ev.type === 'tool.call') foldToolCall(ctx, ev, entry, lineNo, emit)
  else if (ev.type === 'tool.result') foldToolResult(ctx, ev, entry, lineNo, emit)
}
