/**
 * spawn-context.ts — the IO half of the agentistics context (`agentistics-context.ts` is the pure
 * one): builds the `SpawnRequest.context` for a session id and writes the instructions file an
 * `env-dir` harness reads. Best effort by design: a context that cannot be written costs the
 * session its orientation, never its start.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { contextBlock, contextText, type ContextInput } from './agentistics-context'
import { availableHarnesses } from './harness-available'
import { specificationSkillsFor } from './specification-skills'
import type { SpawnPlan, SpawnRequest } from './types'

const HARNESS_NAMES: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'Copilot', antigravity: 'Antigravity', kimi: 'Kimi',
}

/**
 * Display names of the harnesses installed here — the SAME memoized detection `/api/fleet/new` uses
 * (`availableHarnesses`), never a new probe per spawn. Undefined when detection is blind (no CLI on
 * this PATH): the section is then omitted rather than listing assistants that may not exist.
 */
/**
 * CLI form: a task by id or exact title, a subtask by id or exact title within it. Unknown → `{}`
 * for the task (the session is told it is not linked) and no subtask — a name is never invented
 * into an id.
 */
export async function resolveContextTaskByRef(
  taskRef: string | undefined,
  subtaskRef: string | undefined,
): Promise<Pick<ContextInput, 'taskId' | 'taskTitle' | 'subtaskId' | 'subtaskTitle'>> {
  if (!taskRef) return {}
  try {
    const { loadTaskBoard } = await import('./task-source')
    const { book } = await loadTaskBoard()
    const t = book.tasks.find(x => x.id === taskRef) ?? book.tasks.find(x => x.title === taskRef)
    if (!t) return {}
    const sub = subtaskRef ? book.subtasks.find(x => x.taskId === t.id && (x.id === subtaskRef || x.title === subtaskRef)) : undefined
    return { taskId: t.id, taskTitle: t.title, ...(sub ? { subtaskId: sub.id, subtaskTitle: sub.title } : {}) }
  } catch {
    return {}
  }
}

/**
 * The task (and subtask) a session is being created for, as the context names them. Best effort: a
 * book that cannot be read, or an id it does not hold, costs the titles — never the spawn. When the
 * task id is unknown but a name was given (CLI `--task "X"`), the name stands in for the title.
 */
export async function resolveContextTask(
  taskId: string | undefined,
  subtaskId: string | undefined,
  taskName?: string,
): Promise<Pick<ContextInput, 'taskId' | 'taskTitle' | 'subtaskId' | 'subtaskTitle'>> {
  if (!taskId) return {}
  let taskTitle = taskName ?? ''
  let subtaskTitle: string | undefined
  try {
    const { loadTaskBoard } = await import('./task-source')
    const { book } = await loadTaskBoard()
    const t = book.tasks.find(x => x.id === taskId)
    if (t) taskTitle = t.title
    if (subtaskId) subtaskTitle = book.subtasks.find(x => x.id === subtaskId && x.taskId === taskId)?.title
  } catch { /* titles are a courtesy */ }
  return {
    taskId,
    ...(taskTitle ? { taskTitle } : {}),
    ...(subtaskId ? { subtaskId } : {}),
    ...(subtaskTitle ? { subtaskTitle } : {}),
  }
}

/**
 * The parent session a new one reports to, as the context names it. The title is best effort (the
 * registry label, else its task name); an unknown id still yields the id — the child can message it.
 * An empty/absent parent yields nothing.
 */
export async function resolveContextParent(parentId: string | undefined): Promise<Pick<ContextInput, 'parentId' | 'parentTitle'>> {
  if (!parentId) return {}
  try {
    const link = await parentLinkOf(parentId)
    const title = link.title ?? ''
    // The CONVERSATION id is what the child is told to message: it survives a reopen of the parent.
    return { parentId: link.parentConversationId ?? parentId, ...(title ? { parentTitle: title } : {}) }
  } catch {
    return { parentId }
  }
}

/**
 * What to record for a parent given the managed id of the session that is spawning: its managed id
 * and, when its registry row knows it, its conversation id (the stable one). A reopened row carries
 * the PREVIOUS record's `parentConversationId` forward untouched.
 */
export async function parentLinkOf(
  parentManagedId: string | undefined,
): Promise<{ parentSessionId?: string; parentConversationId?: string; title?: string }> {
  if (!parentManagedId) return {}
  try {
    const { readRegistry } = await import('./registry')
    const row = (await readRegistry()).find(m => m.id === parentManagedId)
    return {
      parentSessionId: parentManagedId,
      ...(row?.conversationId ? { parentConversationId: row.conversationId } : {}),
      ...(row?.label || row?.task ? { title: (row.label || row.task)! } : {}),
    }
  } catch {
    return { parentSessionId: parentManagedId }
  }
}

export function installedHarnessNames(): string[] | undefined {
  const { ids, blind } = availableHarnesses()
  return blind ? undefined : ids.map(id => HARNESS_NAMES[id] ?? id)
}

/** The block to HOLD when the context had no channel and there was no first message to carry it. */
export function pendingContextFor(plan: SpawnPlan, context: SpawnRequest['context']): string | undefined {
  return context && plan.contextVia === 'none' ? context.block : undefined
}

export function buildSpawnContext(i: Omit<ContextInput, 'harnesses' | 'specSkills'> & { harnesses?: readonly string[]; specSkills?: readonly string[]; harness?: string }): NonNullable<SpawnRequest['context']> {
  const full: ContextInput = {
    ...i,
    ...(i.harness ? { specSkills: i.specSkills ?? specificationSkillsFor(i.harness) } : {}),
    harnesses: i.harnesses ?? installedHarnessNames(),
  }
  return { text: contextText(full), block: contextBlock(full), dir: join(AGENTISTICS_DATA_DIR, 'session-context', i.sessionId) }
}

/** Write the file `planSpawn` asked for. Resolves to false (and the session still starts) on failure. */
export async function writeContextFile(plan: SpawnPlan): Promise<boolean> {
  if (!plan.contextFile) return true
  try {
    await mkdir(plan.contextFile.dir, { recursive: true, mode: 0o700 })
    await writeFile(join(plan.contextFile.dir, plan.contextFile.name), plan.contextFile.text + '\n', { mode: 0o600 })
    for (const f of plan.contextExtraFiles ?? []) await writeFile(join(plan.contextFile.dir, f.name), f.text + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}
