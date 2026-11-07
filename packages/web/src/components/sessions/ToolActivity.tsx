/**
 * ToolActivity — a run of tool calls as ONE quiet line that opens into its steps (CHAT.ACTIVITY,
 * PROTOTYPE — not wired into `SessionChat` yet; the options page mounts it with mocked turns).
 *
 * Three looks over one model (`lib/toolActivity.ts`):
 *  - `divider` (option A): the shared `SystemLine` — centred between hairlines, like a system notice.
 *  - `inline`  (option B): left-aligned under the assistant's column, where `WorkingNote` already sits.
 *  - `live`    (option C): `inline`, but while the run is RUNNING it shows its newest steps by itself
 *              and an elapsed clock; when the run ends it falls back to the closed `inline` line.
 *
 * Every row with a `ref` opens that exact step in the Live feed (`openArtifacts('live', ref)`), which
 * is where the raw command and its output already live — the summary hides nothing that is not one
 * click away.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, Loader, Minus } from 'lucide-react'
import { SystemLine, SYS_LINK, SYS_TEXT } from './ChatBubble'
import { ActivityIcon } from './ActivityIcon'
import { openArtifacts } from '../../lib/artifactsStore'
import { useIsMobile } from '../../hooks/useIsMobile'
import { fmtSpan, groupSpanMs, outputLabel, outputLines, stepVerb, summarize, type ActivityGroup, type ActivityStep } from '../../lib/toolActivity'

export type ToolActivityVariant = 'divider' | 'inline' | 'live'

const MONO = "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace"
const CODEY = new Set(['run', 'search', 'web', 'mcp', 'other'])
/** How many of the newest steps option C shows while a run is in progress. */
export const LIVE_TAIL = 3

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function StepRow({ step, pt }: { step: ActivityStep; pt: boolean }) {
  const isMobile = useIsMobile()
  const icon = step.status === 'running'
    ? <Loader size={12} className="ag-working-spin" style={{ color: SYS_TEXT }} />
    : step.status === 'error'
      ? <AlertTriangle size={12} style={{ color: 'var(--accent-red)' }} />
      : step.status === 'unfinished'
        ? <Minus size={12} style={{ color: 'var(--text-tertiary)' }} />
        : <Check size={12} style={{ color: 'var(--text-tertiary)' }} />
  const body = (
    <>
      <span aria-hidden style={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>{icon}</span>
      <span style={{ color: step.status === 'error' ? 'var(--accent-red)' : 'var(--text-tertiary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
        {stepVerb(step, pt)}
      </span>
      <span title={step.detail ?? step.object} style={{
        color: 'var(--text-primary)', fontWeight: 500, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        ...(CODEY.has(step.kind) ? { fontFamily: MONO, fontSize: 11, fontWeight: 400 } : {}),
      }}>{step.object}</span>
      {step.ref && <ArrowUpRight className="ag-act-go" size={12} style={{ marginLeft: 'auto', flexShrink: 0, color: SYS_LINK }} />}
    </>
  )
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0,
    padding: isMobile ? '0 10px' : '3px 10px', minHeight: isMobile ? 44 : 24,
    fontSize: 12, lineHeight: 1.4, textAlign: 'left',
    border: 'none', background: 'none', font: 'inherit', color: 'inherit',
  }
  const main = step.ref
    ? <button type="button" className="ag-act-row" onClick={() => openArtifacts('live', step.ref)}
        aria-label={`${stepVerb(step, pt)} ${step.object} — ${pt ? 'abrir no Live' : 'open in Live'}`}
        style={{ ...row, cursor: 'pointer', borderRadius: 6 }}>{body}</button>
    : <div style={row}>{body}</div>
  if (!step.output) return main
  return <StepWithOutput step={step} pt={pt} isMobile={isMobile} main={main} />
}

/**
 * A step that carries what it PRINTED (item 35: "the command and its output, not just 'execute'"): the row as always, plus
 * a quiet "output" toggle beside it that opens the output below — collapsed by default, its own scroll, the tail already
 * trimmed by the source. The toggle is a sibling of the row, never inside it (the row is itself a button when it has a ref).
 */
function StepWithOutput({ step, pt, isMobile, main }: { step: ActivityStep; pt: boolean; isMobile: boolean; main: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const label = outputLabel(step.kind, pt)
  const diff = step.output ? outputLines(step.kind, step.output) : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>{main}</div>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          aria-label={`${open ? (pt ? 'Ocultar' : 'Hide') : (pt ? 'Mostrar' : 'Show')} ${label}: ${step.object}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
            border: 'none', background: 'none', font: 'inherit', fontSize: 11, color: SYS_LINK, cursor: 'pointer',
            padding: isMobile ? '0 10px' : '0 10px 0 4px', minHeight: isMobile ? 44 : 24, ...(isMobile ? { minWidth: 44 } : {}),
          }}>
          {label}
          <ChevronDown size={12} aria-hidden style={{ transition: 'transform 140ms', transform: open ? 'rotate(180deg)' : 'none' }} />
        </button>
      </div>
      {open && (
        <pre data-testid="tool-output" style={{
          margin: '2px 10px 6px 32px', padding: '6px 8px', maxHeight: 220, overflow: 'auto',
          fontFamily: MONO, fontSize: 11, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          // Neutral even on a failed step: the row's icon and verb already say it failed, and most of a failing
          // command's output is ordinary text — painting all of it in the fault colour drowns the line that matters.
          color: 'var(--text-secondary)',
          background: 'var(--bg-base, transparent)', border: '1px solid var(--border)', borderRadius: 6,
        }}>{diff
          // A change reads as a diff: added lines green, removed red, the hunk header dim — the step's own colours, never a fault.
          ? diff.map((l, i) => (
              <span key={i} data-mark={l.mark ?? undefined} style={{ display: 'block', color: l.mark === 'add' ? 'var(--accent-green, #22c55e)' : l.mark === 'del' ? 'var(--accent-red, #ef4444)' : l.mark === 'hunk' ? 'var(--text-tertiary, var(--text-secondary))' : undefined }}>{l.text || ' '}</span>
            ))
          : step.output}</pre>
      )}
    </div>
  )
}

function StepsCard({ steps, pt, more, onMore }: { steps: ActivityStep[]; pt: boolean; more?: number; onMore?: () => void }) {
  const isMobile = useIsMobile()
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 0, padding: '4px 0', width: '100%', minWidth: 0,
      background: 'color-mix(in srgb, var(--bg-surface) 70%, transparent)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
    }}>
      {more ? (
        <button type="button" onClick={onMore} style={{
          border: 'none', background: 'none', font: 'inherit', fontSize: 11, color: SYS_LINK,
          textAlign: 'left', padding: '2px 10px 2px 32px', cursor: 'pointer', ...(isMobile ? { minHeight: 44 } : {}),
        }}>{pt ? `+ ${more} passos anteriores` : `+ ${more} earlier steps`}</button>
      ) : null}
      {steps.map((s, i) => <StepRow key={`${s.ref ?? ''}${i}`} step={s} pt={pt} />)}
    </div>
  )
}

export function ToolActivity({ group, lang, variant, defaultOpen = false, now: nowProp }: {
  group: ActivityGroup
  lang: 'pt' | 'en'
  variant: ToolActivityVariant
  defaultOpen?: boolean
  /** Fixed clock for screenshots; absent = live clock while running. */
  now?: number
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  /**
   * THE READER'S CHOICE, kept apart from the default. `null` = nobody has clicked: the line follows
   * the run (the live tail while it runs, `defaultOpen` once it has ended). Once clicked it is the
   * reader's, and it STAYS theirs through every live update and after the run finishes. It used to
   * be one boolean that the live tail was derived from (`!open`) and that was reset when the run
   * ended: collapsing a running group only swapped the full list for the same tail card — so the
   * click looked ignored — and the choice was thrown away the moment the run finished.
   */
  const [choice, setChoice] = useState<boolean | null>(null)
  const open = choice ?? defaultOpen
  const setOpen = (v: boolean) => setChoice(v)
  const ticking = useNow(group.running && nowProp === undefined)
  const now = nowProp ?? ticking
  const span = fmtSpan(groupSpanMs(group, now))
  const errors = group.steps.filter(s => s.status === 'error').length
  const unfinished = group.steps.some(s => s.status === 'unfinished')
  const summary = summarize(group.steps, group.running, pt)
  const count = group.steps.length

  const label = (
    <>
      <ActivityIcon steps={group.steps} />
      <span title={summary} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
      {group.running
        ? <Loader size={12} className="ag-working-spin" style={{ flexShrink: 0 }} />
        : errors > 0 ? <AlertTriangle size={12} style={{ flexShrink: 0, color: 'var(--accent-red)' }} />
          : unfinished ? <Minus size={12} style={{ flexShrink: 0 }} /> : null}
      <span style={{ flexShrink: 0, whiteSpace: 'nowrap', opacity: 0.8 }}>
        {' · '}{count} {pt ? (count === 1 ? 'passo' : 'passos') : (count === 1 ? 'step' : 'steps')}
        {errors > 0 && <span style={{ color: 'var(--accent-red)' }}>{' · '}{errors} {pt ? (errors === 1 ? 'falhou' : 'falharam') : 'failed'}</span>}
        {span && ` · ${span}`}
      </span>
      <ChevronDown size={13} style={{ flexShrink: 0, transition: 'transform 140ms', transform: open ? 'rotate(180deg)' : 'none' }} />
    </>
  )
  const toggle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%',
    border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer',
    ...(isMobile ? { minHeight: 44 } : {}),
  }
  const button = (
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={toggle}>{label}</button>
  )

  if (variant === 'divider') {
    return (
      <SystemLine isMobile={isMobile} below={open && (
        <div style={{ width: isMobile ? '100%' : '88%', paddingBottom: 6 }}><StepsCard steps={group.steps} pt={pt} /></div>
      )}>
        {button}
      </SystemLine>
    )
  }

  // inline + live
  const liveTail = variant === 'live' && group.running && choice === null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: 11, color: SYS_TEXT }}>
      <div style={{ display: 'flex', minWidth: 0 }}>{button}</div>
      {open && <StepsCard steps={group.steps} pt={pt} />}
      {liveTail && (
        <StepsCard
          steps={group.steps.slice(-LIVE_TAIL)}
          pt={pt}
          {...(count > LIVE_TAIL ? { more: count - LIVE_TAIL, onMore: () => setOpen(true) } : {})}
        />
      )}
    </div>
  )
}
