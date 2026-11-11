import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardList, Info, X } from 'lucide-react'
import { PRIORITY_ORDER, type ComposerTaskOptions } from '@agentistics/core'
import { ComposerIconButton } from './ComposerShell'
import { ChipSelect } from '../tasks/ChipSelect'
import { PRIORITY, surface } from '../tasks/board'
import { DatePicker } from '../DatePicker'
import { useEscapeOwner } from '../../lib/overlayStack'

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
  const explanation = pt
    ? 'Registrar tarefa: ao enviar, esta mensagem vira uma tarefa no Agentask com a prioridade e o prazo escolhidos.'
    : 'Register a task: sending turns this message into an Agentask task with the chosen priority and due date.'
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const [anchor, setAnchor] = useState({ left: 8, bottom: 48 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const skipHint = useRef(false)
  const hintId = useId()
  const panelId = useId()
  const position = () => {
    const r = trigger.current?.getBoundingClientRect()
    if (r) setAnchor({ left: Math.max(8, Math.min(r.left, window.innerWidth - 376)), bottom: Math.max(8, window.innerHeight - r.top + 8) })
  }
  const close = () => { setOpen(false); setHint(false) }
  const closeAndFocus = () => { close(); skipHint.current = document.activeElement !== trigger.current; trigger.current?.focus() }
  useEscapeOwner(open || hint, closeAndFocus)
  useEffect(() => { if (!options || disabled) close() }, [options, disabled])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      const target = e.target as Node
      // ChipSelect owns a portal outside this dialog; selecting a priority must keep it open.
      if (panel.current?.contains(target) || trigger.current?.contains(target) || (target instanceof Element && target.closest('[data-chip-select-panel]'))) return
      close()
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', close)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close) }
  }, [open])
  useEffect(() => { if (open) panel.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [open])
  const date = options?.dueDate?.slice(0, 10) ?? ''
  const time = options?.dueDate?.slice(11) ?? ''
  const changeDate = (day: string) => options && onChange({ ...options, dueDate: day ? `${day}${time ? `T${time}` : ''}` : undefined })
  const dueLabel = pt ? 'Prazo opcional' : 'Optional due date'
  return <>
    <ComposerIconButton ref={trigger} data-composer-task-trigger aria-label={label}
      aria-pressed={options !== null} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-describedby={hint && !open ? hintId : undefined} disabled={disabled}
      onMouseEnter={() => { position(); setHint(true) }} onMouseLeave={() => setHint(false)}
      onFocus={() => { if (skipHint.current) { skipHint.current = false; return }; position(); setHint(true) }} onBlur={() => setHint(false)}
      onClick={() => { position(); setHint(false); if (open) close(); else { if (!options) onChange({ priority: 'medium' }); setOpen(true) } }}
      style={{ color: options ? 'var(--anthropic-orange)' : undefined }}>
      <ClipboardList size={15} aria-hidden />
    </ComposerIconButton>
    {hint && !open && createPortal(<div id={hintId} role="tooltip" data-composer-menu style={{ ...surface, position: 'fixed', ...anchor, zIndex: 1180, width: 304, maxWidth: 'calc(100vw / var(--ui-zoom, 1) - 16px)', boxSizing: 'border-box', padding: 12, display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5, boxShadow: 'var(--shadow-elevated)', pointerEvents: 'none' }}>
      <Info size={16} color="var(--anthropic-orange)" style={{ flexShrink: 0, marginTop: 2 }} aria-hidden />{explanation}
    </div>, document.body)}
    {open && options && createPortal(<div ref={panel} id={panelId} role="dialog" aria-label={label} data-composer-menu data-composer-task-popover
      style={{ ...surface, position: 'fixed', ...anchor, zIndex: 1180, width: 368, maxWidth: 'calc(100vw / var(--ui-zoom, 1) - 16px)', maxHeight: `calc(100dvh / var(--ui-zoom, 1) - ${anchor.bottom + 8}px)`, overflowY: 'auto', boxSizing: 'border-box', padding: 12, display: 'grid', gap: 10, boxShadow: 'var(--shadow-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
        <Info size={16} color="var(--anthropic-orange)" aria-hidden />{pt ? 'Registrar tarefa' : 'Register a task'}
        <ComposerIconButton aria-label={pt ? 'Fechar' : 'Close'} onClick={closeAndFocus} style={{ marginLeft: 'auto' }}><X size={15} /></ComposerIconButton>
      </div>
      <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>{pt ? 'Prioridade' : 'Priority'}
        <ChipSelect value={options.priority} title={pt ? 'Prioridade' : 'Priority'} options={PRIORITY_ORDER.map(id => ({ value: id, ...PRIORITY[id]! }))}
          onPick={priority => onChange({ ...options, priority: priority as ComposerTaskOptions['priority'] })} />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
        <span>{dueLabel}{date ? ` · ${date.split('-').reverse().join('/')}` : ''}</span>
        {date && <button type="button" className="ag-composer-task-control" onClick={() => changeDate('')}>{pt ? 'Limpar prazo' : 'Clear due date'}</button>}
      </div>
      <DatePicker inline allowFuture value={date} onChange={changeDate} label={dueLabel} placeholder={dueLabel} lang={pt ? 'pt' : 'en'} />
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
        {pt ? 'Hora opcional (local)' : 'Optional time (local)'}
        <input className="ag-composer-task-control" aria-label={pt ? 'Hora opcional (local)' : 'Optional time (local)'} type="time" value={time} disabled={!date}
          onChange={e => onChange({ ...options, dueDate: `${date}${e.target.value ? `T${e.target.value}` : ''}` })} style={{ padding: '0 8px', minWidth: 0 }} />
      </label>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 11.5, lineHeight: 1.5 }}>{pt ? 'O próximo envio registra a tarefa. Fechar mantém suas opções.' : 'The next send registers the task. Closing keeps your choices.'}</p>
      <button type="button" className="ag-composer-task-control" onClick={() => { onChange(null); closeAndFocus() }}>{pt ? 'Desligar' : 'Turn off'}</button>
    </div>, document.body)}
  </>
}
