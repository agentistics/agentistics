/**
 * LiveQueuePriority — change a QUEUED card's priority right on the card (FILA.PRIORIDADE).
 *
 * The queue leaves in the order of the task's priority, so editing it here reorders the exit. It sits BESIDE the card (the
 * card is itself a button, and a button must not hold another), like `LiveApprove`, and is the very same chip the board and
 * the task page use — one control, one write (`editTask`), no second path to a priority.
 */
import { useEffect, useState } from 'react'
import { PRIORITY_ORDER } from '@agentistics/core'
import { editTask } from '../../lib/tasks'
import { PRIORITY } from './board'
import { ChipSelect } from './ChipSelect'
import { priorityIdOf, priorityWord } from './LivePriorityChip'

export function LiveQueuePriority({ taskId, priority, pt }: { taskId: string; priority: string | null | undefined; pt: boolean }) {
  const shown = priorityIdOf(priority)
  const [local, setLocal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The Live reply catches up on its next read: once it agrees (or moves on), the local value gives way to it.
  useEffect(() => { setLocal(null) }, [shown])
  const value = local ?? shown
  return (
    <div data-live-queue-priority={taskId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
      <span>{pt ? 'Prioridade (muda a ordem de saída)' : 'Priority (changes the leaving order)'}</span>
      <ChipSelect
        value={value} compact block={false} disabled={busy}
        options={PRIORITY_ORDER.filter(p => p !== 'none').map(p => ({ value: p, label: priorityWord(p, pt), color: PRIORITY[p]!.color, dim: PRIORITY[p]!.dim }))}
        onPick={async v => { setLocal(v); setBusy(true); const ok = await editTask(taskId, { priority: v as never }).then(() => true, () => false); setBusy(false); if (!ok) setLocal(null) }}
      />
    </div>
  )
}
