import { useRef, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import type { ComposerTaskOptions } from '@agentistics/core'

/** The switch belongs to ONE send; a refused send restores the same id for an honest retry. */
export function useComposerTask() {
  const [options, setOptions] = useState<ComposerTaskOptions | null>(null)
  const retry = useRef<{ key: string; id: string } | null>(null)
  return {
    options, setOptions,
    complete() { retry.current = null },
    take(text: string): { asTask?: ComposerTaskOptions; messageId?: string } {
      if (!options) return {}
      const key = JSON.stringify([text, options])
      if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() }
      setOptions(null)
      return { asTask: options, messageId: retry.current.id }
    },
  }
}

export function ComposerTaskButton({ options, onChange, disabled, pt }: {
  options: ComposerTaskOptions | null; onChange: (v: ComposerTaskOptions | null) => void; disabled: boolean; pt: boolean
}) {
  const label = pt ? 'Criar tarefa com esta mensagem' : 'Create a task from this message'
  return <button type="button" className="ag-composer-task-control" aria-label={label} title={label}
    aria-pressed={options !== null} disabled={disabled}
    onClick={() => onChange(options ? null : { priority: 'medium' })}
    style={{ flexShrink: 0, width: 'var(--ag-composer-control)', borderRadius: 8, cursor: 'pointer',
      border: options ? '1px solid var(--anthropic-orange)' : '1px solid var(--border)',
      color: options ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
      background: options ? 'var(--anthropic-orange-dim)' : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
    <ClipboardList size={17} />
  </button>
}

export function ComposerTaskFields({ options, onChange, pt }: {
  options: ComposerTaskOptions | null; onChange: (v: ComposerTaskOptions) => void; pt: boolean
}) {
  if (!options) return null
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '4px 2px', minWidth: 0 }}>
    <select className="ag-composer-task-control" aria-label={pt ? 'Prioridade' : 'Priority'} value={options.priority}
      onChange={e => onChange({ ...options, priority: e.target.value as ComposerTaskOptions['priority'] })}>
      <option value="urgent">{pt ? 'Urgente' : 'Urgent'}</option>
      <option value="high">{pt ? 'Alta' : 'High'}</option>
      <option value="medium">{pt ? 'Média' : 'Medium'}</option>
      <option value="low">{pt ? 'Baixa' : 'Low'}</option>
    </select>
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 0 }}>
      {pt ? 'Prazo opcional' : 'Optional due date'}
      <input className="ag-composer-task-control" type="date" value={options.dueDate ?? ''}
        aria-label={pt ? 'Prazo opcional' : 'Optional due date'}
        onChange={e => onChange({ ...options, dueDate: e.target.value || undefined })} style={{ minWidth: 0, maxWidth: 155 }} />
    </label>
  </div>
}
