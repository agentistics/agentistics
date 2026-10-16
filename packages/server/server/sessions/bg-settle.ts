/**
 * WHEN A BACKGROUND TASK HAS ENDED WITHOUT A `<task-notification>` (spec 2.3, P4).
 *
 * The chat readers draw every `run_in_background` launch as a running status line and settled it
 * only on the harness's `<task-notification>`. Three real ends never send one: the task was stopped
 * with `TaskStop`, the launch was denied/errored and never started, or the session itself ended
 * with the task in flight. This module is the pure rule both walks in `chat-tail.ts` share.
 *
 * The walks run BACKWARDS, so a result is always observed before the `tool_use` it answers.
 */

import type { ChatTaskEnd } from '@agentistics/core'

export type BgEnd = ChatTaskEnd

interface LaunchResult { isError: boolean; shellId: string | null }

export interface BgObserver {
  /** Feed every raw entry of the walk. */
  observe(e: Record<string, unknown>): void
  /** Why the task launched by `toolUseId` is over, or `null` when it is still running. */
  settle(toolUseId: string, sessionEnded: boolean): Exclude<BgEnd, 'done'> | null
}

const ID_RES = [
  /\bwith ID:\s*([A-Za-z0-9_-]+)/,
  /\b(?:task_id|shell_id|agentId)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/,
  /\bID:\s*([A-Za-z0-9_-]+)/,
]
/** Only the result of one of these tools says "this task was stopped" (spec 2.3a). */
const STOP_TOOLS = new Set(['TaskStop', 'KillShell'])
const STOPPED_RES = [
  /Successfully (?:stopped|killed) (?:task|shell|background shell)[:\s]+([A-Za-z0-9_-]+)/i,
]

function resultText(part: Record<string, unknown>): string {
  const c = part.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return (c as Record<string, unknown>[])
      .map(p => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .join('\n')
  }
  return ''
}

export function createBgObserver(): BgObserver {
  const launches = new Map<string, LaunchResult>()
  /** Stop-shaped result text, keyed by the tool_use it answers (judged at settle time: the walk
   *  runs backwards, so the `tool_use` naming the tool arrives AFTER its result). */
  const stopResults = new Map<string, string>()
  const toolNames = new Map<string, string>()
  let stopped: Set<string> | null = null

  return {
    observe(e) {
      if (e.type === 'assistant') {
        const c = (e.message as Record<string, unknown> | undefined)?.content
        if (Array.isArray(c)) {
          for (const p of c as Record<string, unknown>[]) {
            if (p.type === 'tool_use' && typeof p.id === 'string' && typeof p.name === 'string') toolNames.set(p.id, p.name)
          }
        }
        return
      }
      if (e.type !== 'user') return
      const content = (e.message as Record<string, unknown> | undefined)?.content
      if (!Array.isArray(content)) return
      for (const part of content as Record<string, unknown>[]) {
        if (part.type !== 'tool_result') continue
        const text = resultText(part)
        const isError = part.is_error === true
        const id = typeof part.tool_use_id === 'string' ? part.tool_use_id : ''
        if (!id) continue
        if (!isError) {
          for (const re of STOPPED_RES) {
            const m = re.exec(text)
            if (m) { stopResults.set(id, m[1]!); stopped = null; break }
          }
        }
        let shellId: string | null = null
        for (const re of ID_RES) {
          const m = re.exec(text)
          if (m) { shellId = m[1]!; break }
        }
        launches.set(id, { isError, shellId })
      }
    },
    settle(toolUseId, sessionEnded) {
      if (!stopped) {
        const set = new Set<string>()
        for (const [useId, shell] of stopResults) if (STOP_TOOLS.has(toolNames.get(useId) ?? '')) set.add(shell)
        stopped = set
      }
      const stoppedIds = stopped
      const r = launches.get(toolUseId)
      // (b) only a result the harness marked as an error is a launch that never started; a
      // successful result whose text carries no id we recognise is still a running task.
      if (r?.isError) return 'never-started'
      // (a) the shell id the launch announced was later stopped by TaskStop/KillShell.
      if (r?.shellId && stoppedIds.has(r.shellId)) return 'stopped'
      // (c) the session is over: nothing can still be running.
      if (sessionEnded) return 'session-ended'
      return null
    },
  }
}
