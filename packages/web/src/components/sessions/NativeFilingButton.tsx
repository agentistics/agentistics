/**
 * NativeFilingButton — the native session page's filing control (UI follow-up 2): the task this
 * session is filed under, and the same `SessionFiling` picker a fleet session uses to file, move or
 * unfile it. A native session has no fleet row carrying its task name, so where it is filed is read
 * from the board (`fetchNativeFiling`); filing goes through the engine (`attachSession` routes a
 * native id there), which files with the session's label, folder and cost so far.
 */
import { useCallback, useEffect, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { SessionFiling } from '../tasks/SessionFiling'
import { fetchNativeFiling } from '../../lib/tasks'
import { NATIVE_HARNESS_ID } from '../../lib/nativeSession'
import { taskPath } from '../../lib/sessionTaskLink'

export function NativeFilingButton({ sessionId, title, lang }: { sessionId: string; title: string; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  const [filing, setFiling] = useState<{ taskId: string; taskTitle: string } | null>(null)
  const [open, setOpen] = useState(false)
  const reload = useCallback(async () => { setFiling(await fetchNativeFiling(sessionId)) }, [sessionId])
  useEffect(() => { void reload() }, [reload])
  const label = filing
    ? (pt ? `Tarefa: ${filing.taskTitle}` : `Task: ${filing.taskTitle}`)
    : (pt ? 'Arquivar em uma tarefa' : 'File under a task')
  return (
    <>
      <button
        type="button"
        data-testid="native-filing"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, maxWidth: 'min(160px, 28vw)', height: 34, padding: '0 10px',
          borderRadius: 9, border: '1px solid var(--border-subtle)', flexShrink: 1, minWidth: 34, cursor: 'pointer',
          background: filing ? 'var(--bg-elevated)' : 'transparent',
          color: filing ? 'var(--text-primary)' : 'var(--text-tertiary)', fontSize: 12, fontFamily: 'inherit',
        }}
      >
        <ClipboardList size={14} style={{ flexShrink: 0 }} />
        {filing && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filing.taskTitle}</span>}
      </button>
      {open && (
        <SessionFiling
          session={{ id: sessionId, title, harness: NATIVE_HARNESS_ID, ...(filing ? { task: filing.taskTitle } : {}) }}
          lang={lang}
          onChanged={reload}
          onOpenTask={taskId => navigate(taskPath(taskId))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
