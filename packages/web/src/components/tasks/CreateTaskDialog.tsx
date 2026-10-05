import { lazy, Suspense, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { sortTaskTypes, type TaskStatusDef, type TaskTypeDef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useDismissOverlay } from '../../lib/dismissOverlay'
import { overlayPadding } from '../../lib/mobileOverlay'
import { NO_TYPE_KEY, button, field, liveStatusMap, liveStatusOrder, microLabel, surface, typeStyle } from './board'
import { ChipSelect, statusOptions } from './ChipSelect'
import { DEFAULT_CREATE_STATUS, planCreate, TITLE_MAX } from './createPlan'
import { CreateExtras } from './CreateExtras'
import type { Lang } from './copy'

// The editor (TipTap + ProseMirror) is the heavy part and only a person creating a task needs it.
const MarkdownEditor = lazy(() => import('./MarkdownEditor').then(m => ({ default: m.MarkdownEditor })))

const W = {
  title: { en: 'Create a task', pt: 'Criar uma tarefa' },
  name: { en: 'Title', pt: 'Título' },
  namePh: { en: 'What is this task?', pt: 'O que é esta tarefa?' },
  type: { en: 'Type (optional)', pt: 'Tipo (opcional)' },
  noType: { en: 'No type', pt: 'Sem tipo' },
  status: { en: 'Status', pt: 'Status' },
  detail: { en: 'Description (recommended)', pt: 'Descrição (recomendado)' },
  detailHint: { en: 'Say what has to be true when this is done. Markdown works as you type: # heading, - list, **bold**, `code`.', pt: 'Diga o que precisa ser verdade quando isso estiver pronto. O markdown funciona enquanto você digita: # título, - lista, **negrito**, `código`.' },
  required: { en: 'A task needs a title.', pt: 'A tarefa precisa de um título.' },
  cancel: { en: 'Cancel', pt: 'Cancelar' },
  create: { en: 'Create task', pt: 'Criar tarefa' },
  creating: { en: 'Creating…', pt: 'Criando…' },
  close: { en: 'Close', pt: 'Fechar' },
} as const

/**
 * The create form that replaces "type a name and the task exists": Title (required), Type (optional, the
 * existing vocabulary), Status (default To do, or the column the Add was pressed in) and Description
 * (recommended; a markdown editor that formats as you type, stored as markdown). The submit is
 * `planCreate`'s; the WRITE is the caller's (`onCreate`), so the board stays the one place tasks are made.
 */
export function CreateTaskDialog(p: {
  lang: Lang
  statuses: readonly TaskStatusDef[] | null
  types: readonly TaskTypeDef[] | null
  initialStatus?: string
  initialType?: string
  onCancel: () => void
  onCreate: (plan: { title: string; detail?: string; type?: string; status: string; subtasks: string[]; sessions: Map<string, number> }) => Promise<void>
}) {
  const isMobile = useIsMobile()
  const dismiss = useDismissOverlay(() => p.onCancel())
  const [title, setTitle] = useState('')
  const [type, setType] = useState(p.initialType ?? '')
  const [status, setStatus] = useState(p.initialStatus ?? DEFAULT_CREATE_STATUS)
  const [detail, setDetail] = useState('')
  const [subs, setSubs] = useState<string[]>([])
  const [picked, setPicked] = useState<Map<string, number>>(() => new Map())
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const t = <K extends keyof typeof W>(k: K) => W[k][p.lang]
  const plan = planCreate({ title, type, status, detail })

  const submit = async () => {
    setTried(true)
    if (!plan.ok || busy) return
    setBusy(true)
    try { await p.onCreate({ ...plan, subtasks: subs, sessions: picked }) } finally { setBusy(false) }
  }

  return createPortal(
    <div
      {...dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        role="dialog" aria-modal="true" aria-label={t('title')} data-create-task
        onClick={e => e.stopPropagation()}
        style={{
          ...surface, background: 'var(--bg-card)', boxShadow: '0 12px 48px rgba(0,0,0,0.5)', display: 'grid', gap: 12, padding: 20,
          ...(isMobile
            ? { width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto', alignContent: 'start' }
            : { width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', borderRadius: 12 }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{t('title')}</span>
          <button
            type="button" onClick={p.onCancel} aria-label={t('close')}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex', ...(isMobile ? { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' } : {}) }}
          ><X size={16} /></button>
        </div>

        <label style={{ display: 'grid', gap: 5 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>{t('name')} *</span>
          <input
            autoFocus={!isMobile} data-create-title style={{ ...field(isMobile), ...(tried && !plan.ok ? { borderColor: 'var(--accent-red)' } : {}) }}
            value={title} maxLength={TITLE_MAX} placeholder={t('namePh')} aria-required="true" aria-invalid={tried && !plan.ok}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
          />
          {tried && !plan.ok && <span role="alert" style={{ fontSize: 11.5, color: 'var(--accent-red)' }}>{t('required')}</span>}
        </label>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 150px', display: 'grid', gap: 5, minWidth: 0 }}>
            <span style={{ ...microLabel, fontSize: 9 }}>{t('type')}</span>
            <ChipSelect
              value={type || NO_TYPE_KEY}
              options={[
                { value: NO_TYPE_KEY, ...typeStyle(null, undefined), label: t('noType') },
                ...sortTaskTypes(p.types ?? []).map(x => ({ value: x.id, ...typeStyle(p.types, x.id) })),
              ]}
              onPick={v => setType(v === NO_TYPE_KEY ? '' : v)}
            />
          </div>
          <div style={{ flex: '1 1 150px', display: 'grid', gap: 5, minWidth: 0 }}>
            <span style={{ ...microLabel, fontSize: 9 }}>{t('status')}</span>
            <ChipSelect
              value={status}
              options={statusOptions(liveStatusMap(p.statuses), liveStatusOrder(p.statuses))}
              onPick={setStatus}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gap: 5 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>{t('detail')}</span>
          <Suspense fallback={<div style={{ minHeight: 140, border: '1px solid var(--border)', borderRadius: 8 }} />}>
            <MarkdownEditor value="" onChange={setDetail} ariaLabel={t('detail')} isMobile={isMobile} />
          </Suspense>
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{t('detailHint')}</span>
        </div>

        <CreateExtras lang={p.lang} subs={subs} setSubs={setSubs} picked={picked} setPicked={setPicked} />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" style={button(isMobile)} onClick={p.onCancel}>{t('cancel')}</button>
          <button type="button" data-create-submit style={button(isMobile, 'primary')} disabled={busy} onClick={() => void submit()}>
            {busy ? t('creating') : t('create')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
