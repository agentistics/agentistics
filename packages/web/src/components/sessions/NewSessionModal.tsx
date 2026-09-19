/**
 * NewSessionModal — starting a session from the dashboard, as a FOUR-STEP WIZARD.
 *
 * It was one long scrolling form. Four questions in a column is a form; a form that starts a real
 * assistant, in a real directory, spending real money, is a DECISION — and a decision is walked
 * through and then reviewed. The last step shows every answer together, because that is the only
 * moment somebody catches "wrong folder" before it costs them a session.
 *
 * What may ADVANCE is not decided here: `wizardSteps.ts` owns it, so "can I continue" and "what is
 * missing" are answerable without a DOM. A wizard whose gating lives in JSX is a wizard nothing can
 * check, and this one gates the most powerful act the server performs.
 *
 * It asks the FULL path the terminal wizard asks — assistant, where, task, model, effort, first
 * message, title — not a reduced form. What the web adds is that each answer is SHOWN rather than
 * spelled: a mark per assistant, a repository distinguished from a plain folder, and effort as a
 * coloured scale.
 *
 * TWO RULES CARRIED OVER FROM THE TERMINAL WIZARD, both load-bearing:
 *
 * - The assistants offered are the ones `availableHarnesses()` found ON PATH. Anything else would
 *   start a tmux session that dies on `command not found` behind a screen nobody is watching.
 * - `model` and `effort` are SKIPPED, not shown-and-disabled, when the spawn spec has no flag for
 *   them. `efforts` is a CLOSED set read from each CLI's own `--help` — agy prints one, codex
 *   deliberately has none — so the scale decorates a real set and may never imply a level the
 *   harness does not accept.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Check, ClipboardList, Loader, Paperclip, X } from 'lucide-react'
import { attachmentRoom, MAX_ATTACHMENTS, planPaste } from '../../lib/pastePlan'
import { Field, inputStyle } from './formBits'
import { HarnessPicker } from './HarnessPicker'
import { ModelSelect, ModelId } from './ModelSelect'
import { EffortPicker } from './EffortPicker'
import { ProjectPicker } from './ProjectPicker'
import { HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from './HarnessMark'
import { TaskPicker } from '../tasks/TaskPicker'
import { boardCopy } from '../tasks/copy'
import { useFleet } from '../../lib/fleet'
import { attachSession, useTaskList, type TaskDetail } from '../../lib/tasks'
import { BlockedSubtaskResolve } from '../tasks/BlockedSubtaskResolve'
import { deliveryHint, suggestDelivery } from '../../lib/taskSuggest'
import { useFleetNewOptions, type FleetProjectOption } from '../../hooks/useFleetNewOptions'
import {
  STEP_ORDER, modelDisplay, nextStep, prevStep, stepReady, toWizardHarness, unsetText,
  visibleQuestions, type HarnessAnswer, type MissingAnswer, type StepId, type WizardDraft,
  type WizardHarness,
} from '../../lib/wizardSteps'

/** The `/api/fleet/new` harness shape — see `wizardSteps.ts`'s `HarnessAnswer`, the one mapping
 *  this and `StagedSessionCompose` both build a `WizardHarness` through. */
type HarnessOption = HarnessAnswer
/** The `/api/fleet/new` project shape — see `useFleetNewOptions`'s `FleetProjectOption`. */
type ProjectOption = FleetProjectOption

export interface NewSessionModalProps {
  lang: 'pt' | 'en'
  onClose: () => void
  /** Called with the new session's id when one starts, so the page can select it immediately. */
  /**
   * The session was started. `started` describes it well enough for the caller to say so while the
   * row is still on its way — see `SessionCreating`; the fleet does not hold it yet, so nothing
   * downstream can look these up.
   */
  onStarted: (id?: string, started?: { harness?: string; label?: string }) => void
  /**
   * Pre-fill the task field.
   *
   * Set by the task wizard, which creates the task first and hands the title over: the one moment
   * attribution is free is the moment the session is started, and asking for it twice is how a
   * field gets left blank.
   */
  initialTask?: string
  /**
   * The real task this session is being started FOR, once one already exists.
   *
   * `initialTask` alone only ever fills the free-text label sent to `/api/fleet/new` — it never
   * files the session under the task, because a display string carries no id. When the caller
   * already has a real `Task`, it passes this too, so the wizard seeds `subtaskTarget` with a bare
   * task-level attach (no subtask — the caller never asked for one) and the session that comes out
   * the other end is actually filed, not just labeled. See spec 2026-09-11 §C.2.
   */
  initialTaskId?: string
  /**
   * Pre-fill from a session PRESET that has no `cwd` of its own (see `@agentistics/core`'s
   * `sessionPresets.ts` and `SessionsPage.tsx`'s `onSelectPreset`) — a preset that already names a
   * folder never opens this wizard at all, it launches directly through `PresetLaunchConfirm`. This
   * is only the fallback for the one field a preset cannot supply.
   *
   * Pre-fills the answers; it does not skip a step or auto-start anything — the person still walks
   * the ordinary wizard and its review step, which is the same consent gate a preset with a `cwd`
   * gets from `PresetLaunchConfirm` instead.
   */
  initialPreset?: {
    harness?: string
    prompt?: string
    model?: string
    effort?: string
    label?: string
  }
  /**
   * The exact SUBTASK (or group) this session is being started for, alongside `initialTaskId` — the
   * staged-session compose flow's fallback path (t-918cc82233), reached when a draft is missing
   * something `/api/fleet/new` requires (a harness, a folder). Seeds `subtaskTarget` with the pair,
   * so the automatic attach below files the result under the exact subtask the draft lived on rather
   * than a bare task-level attach. Ignored without `initialTaskId` — a subtask cannot be named
   * without the delivery it belongs to.
   */
  initialSubtaskId?: string
}

export function NewSessionModal({
  lang, onClose, onStarted, initialTask, initialTaskId, initialSubtaskId, initialPreset,
}: NewSessionModalProps) {
  const pt = lang === 'pt'
  // The wizard's own data source — harnesses, matching projects, and the search that drives them
  // both. Shared with `StagedSessionCompose`, which needs the same fetch for the same reason —
  // see `useFleetNewOptions`'s own header.
  const { harnesses, projects, projectTotals, query, setQuery, searching } = useFleetNewOptions(lang)

  const [harness, setHarness] = useState<HarnessOption | null>(null)
  // Prefer a PRESET's own harness when this machine can actually start it; otherwise pre-select the
  // only assistant there is — a one-item picker is a question with one answer. Runs whenever the
  // list changes rather than only once, so a slow first fetch still resolves it the moment it lands.
  useEffect(() => {
    if (harnesses === null) return
    setHarness(h => h
      ?? (initialPreset?.harness ? harnesses.find(x => x.id === initialPreset.harness) ?? null : null)
      ?? (harnesses.length === 1 ? harnesses[0]! : null))
  }, [harnesses])
  const [cwd, setCwd] = useState('')
  const [task, setTask] = useState(initialTask ?? '')
  /**
   * The exact TASK (and, when the picker was used, SUBTASK) this session will be filed under, once
   * it exists. `subtaskId` is absent for a bare task-level attach — set either by `initialTaskId`
   * (the caller already has a real task and never asked for a subtask) or by the folder suggestion
   * resolving its guessed title against a real task (same reason, see the effect below); it is set
   * WITH a subtask only by the picker. `task` stays the free-text label sent at spawn either way —
   * this is the extra, exact half that lets the attach happen automatically once the session is
   * created. See spec 2026-09-11 §C.2.
   */
  const [subtaskTarget, setSubtaskTarget] = useState<{ taskId: string; subtaskId?: string } | null>(
    initialTaskId ? { taskId: initialTaskId, ...(initialSubtaskId ? { subtaskId: initialSubtaskId } : {}) } : null,
  )
  /** Set when that automatic attach comes back refused because the subtask is still blocked. */
  const [subtaskBlocked, setSubtaskBlocked] = useState<
    { taskId: string; subtaskId: string; blockedBy: string[]; sessionId: string } | null
  >(null)
  /** The blocked delivery's own subtasks/sessions, fetched once for `BlockedSubtaskResolve`. */
  const [blockedDetail, setBlockedDetail] = useState<TaskDetail | null>(null)
  /** Open when the delivery picker is up. */
  const [pickingTask, setPickingTask] = useState(false)
  const [model, setModel] = useState(initialPreset?.model ?? '')
  const [effort, setEffort] = useState(initialPreset?.effort ?? '')
  const [prompt, setPrompt] = useState(initialPreset?.prompt ?? '')
  const [label, setLabel] = useState(initialPreset?.label ?? '')

  /**
   * The delivery this session probably belongs to, from the folder that is selected RIGHT NOW.
   *
   * Both reads are ones the app already makes (the 5s refcounted fleet poll and the board's own
   * list), so this costs no request of its own. `suggestDelivery` is pure and says nothing when the
   * evidence is absent or points two ways — see its own note.
   */
  const isMobile = useIsMobile()
  const { fleet } = useFleet(lang)
  const { rows: taskRows } = useTaskList()
  const suggestion = useMemo(
    () => (cwd && taskRows
      ? suggestDelivery({
        cwd,
        sessions: fleet.rows,
        tasks: (taskRows ?? []).map(r => r.task),
      })
      : null),
    [cwd, fleet.rows, taskRows],
  )

  /**
   * The suggestion worth OFFERING right now, as a clickable hint — never written into the field on
   * its own. See `deliveryHint`'s own note for the bug this replaced: an effect used to fill the
   * field from the suggestion and, on resolving it to a real task, seed `subtaskTarget` too —
   * silently FILING the session under a delivery nobody had chosen.
   */
  const hint = deliveryHint(task, suggestion)

  /**
   * Accept the hint — the same act as picking it from `TaskPicker`, just one click closer: it
   * resolves to a real, already-created task (the only kind `suggestDelivery` ever names), so the
   * session is actually FILED, not merely labelled. See spec 2026-09-11 §C.2.
   */
  function acceptHint(h: NonNullable<typeof hint>): void {
    setTask(h.title)
    const matchedId = taskRows?.find(r => r.task.title === h.title)?.task.id
    setSubtaskTarget(matchedId ? { taskId: matchedId } : null)
  }

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  /** Which question is on screen. The ORDER and the gating are `wizardSteps.ts`'s, not this file's. */
  const [step, setStep] = useState<StepId>('assistant')
  /**
   * The model picker's own open state, held HERE rather than inside it, because the modal owns the
   * keyboard: `esc` has to close the picker before it closes the wizard, and two listeners racing
   * for one key is how a dropdown takes the whole dialog down with it.
   */
  const [modelOpen, setModelOpen] = useState(false)
  /**
   * Files already uploaded to this machine, as `{name, path}`.
   *
   * Same shape and same reason as the composer's: the first message is TYPED into a tmux pane, so
   * there is no channel a byte array could travel down — but every one of these CLIs reads a file
   * it is pointed at. The chip says the name; the message carries the path.
   */
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /** The selected assistant in the pure module's shape. One mapping, read by everything below —
   *  see `toWizardHarness`, shared with `StagedSessionCompose`. */
  const wizardHarness: WizardHarness | null = useMemo(() => harness ? toWizardHarness(harness) : null, [harness])

  /**
   * The answers so far. Rebuilt each render rather than held as state: one source for each answer,
   * and therefore no chance of the form and the gate disagreeing about what was chosen.
   */
  const draft: WizardDraft = useMemo(
    () => ({ harness: harness?.id ?? '', cwd, task, model, effort, prompt, label, attachments }),
    [harness, cwd, task, model, effort, prompt, label, attachments],
  )

  // What survives a change of assistant: a model or an effort the NEW assistant also names is KEPT,
  // and anything it cannot accept is dropped rather than sent as a flag the CLI rejects at spawn.
  useEffect(() => {
    setModel(m => (wizardHarness && wizardHarness.models.some(x => x.id === m)) ? m : '')
    setEffort(e => (wizardHarness && wizardHarness.efforts.includes(e)) ? e : '')
  }, [wizardHarness])

  const ready = stepReady(step, draft, wizardHarness)
  const canStart = stepReady('review', draft, wizardHarness).ok && !busy
  const stepIndex = STEP_ORDER.indexOf(step)

  /**
   * What a blocked step is waiting for, IN WORDS. A disabled button that says nothing is a bug.
   *
   * One sentence per `MissingAnswer`, and the mapping is exhaustive on purpose: the pure module
   * decides WHAT is missing, this file only says it, so a new gate over there cannot land here as
   * a silent fallback to the wrong sentence.
   */
  const BLOCKED_BECAUSE: Record<MissingAnswer, string> = {
    assistant: pt ? 'Escolha um assistente para continuar.' : 'Pick an assistant to continue.',
    title: pt ? 'Dê um título à sessão para continuar.' : 'Give the session a title to continue.',
    cwd: pt ? 'Escolha uma pasta para continuar.' : 'Pick a folder to continue.',
  }
  const blockedBecause = ready.ok || !ready.missing ? null : BLOCKED_BECAUSE[ready.missing]

  // WHAT HAPPENS IF YOU LEAVE IT ALONE — named where the CLI publishes it, vague where it does not.
  // See `unsetText`'s own note, shared with `StagedSessionCompose`.
  const modelUnset = unsetText(harness?.defaultModel, pt)
  const effortUnset = unsetText(harness?.defaultEffort, pt)

  const STEP_TITLE: Record<StepId, string> = {
    assistant: pt ? 'Assistente' : 'Assistant',
    where: pt ? 'Onde' : 'Where',
    message: pt ? 'Mensagem' : 'Message',
    review: pt ? 'Revisão' : 'Review',
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Innermost first. Closing the whole wizard because a dropdown was open loses every answer
      // already given, over a keypress the user meant for the dropdown.
      if (modelOpen) setModelOpen(false)
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, modelOpen])

  /**
   * Wait for the row to exist before handing the caller its id.
   *
   * The spawn returns as soon as tmux has the session; the workspace learns about it from a poll
   * that runs every five seconds. Navigating to `/sessions/<id>` in between lands on a row the page
   * does not have, and it renders "this session is no longer in this machine's list" — a sentence
   * about a session created one second earlier, which is exactly the "criou como inativa" report.
   *
   * Bounded, and it never blocks the outcome: the session IS started either way, so when the budget
   * runs out we navigate anyway and let the next poll settle it. Failing to confirm is not a reason
   * to withhold a session that exists.
   */
  async function waitForRow(id: string, budgetMs = 6000): Promise<void> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`/api/fleet?lang=${lang}`)
        if (r.ok) {
          const f = await r.json() as { rows?: { id?: string }[] }
          if (f.rows?.some(x => x.id === id)) return
        }
      } catch { /* the poll that matters is the workspace's; this one is a courtesy */ }
      await new Promise(res => setTimeout(res, 400))
    }
  }

  /**
   * Upload the picked files, one request each, and keep only what actually landed.
   *
   * A chip is added ONLY for a file the server confirmed and named a path for. Adding it
   * optimistically would put a path into the first message that resolves to nothing, and the
   * assistant would be told to read a file that is not there — a failure the person cannot see and
   * the session cannot explain.
   */
  async function pick(list: FileList | readonly File[] | null): Promise<void> {
    const picked = Array.from(list ?? [])
    if (picked.length === 0) return
    // The same cap the session composer applies, from the same module — a wizard that accepts
    // fifteen and a composer that accepts ten are two rules for one act.
    const files = picked.slice(0, attachmentRoom(attachments.length))
    if (files.length < picked.length) {
      setNotice(pt
        ? `No máximo ${MAX_ATTACHMENTS} anexos.`
        : `At most ${MAX_ATTACHMENTS} attachments.`)
    }
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      const body = new FormData()
      body.append('file', file)
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; path?: string; name?: string; message?: string }
        if (json.ok && json.path && json.name) {
          setAttachments(a => [...a, { name: json.name!, path: json.path! }])
        } else {
          setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
        }
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  /**
   * PASTE INTO THE MESSAGE, files included — reported as "let me ctrl+V a file here".
   *
   * `planPaste` is the session composer's own decision, unchanged and shared: a paste carrying
   * FILES becomes attachments, ordinary text falls through to the field (which handles the caret
   * and the undo stack better than any manual insert), and a very large block of text is attached
   * as a file instead. That last one matters here for the same reason it matters there — several
   * harnesses take their first prompt by having it TYPED into a pane (see `spawn-spec.ts`), so a
   * 4.000-line paste is not a message.
   *
   * The button stays: a paste is the shortcut, never the only way in.
   */
  function onPastePrompt(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const plan = planPaste({
      files: Array.from(e.clipboardData.files),
      text: e.clipboardData.getData('text/plain'),
      existing: attachments.length,
    })
    // An ordinary paste is left alone — the textarea does it better than we would.
    if (plan.kind === 'text') return
    e.preventDefault()
    if (plan.kind === 'files') { void pick(plan.files); return }
    if (plan.kind === 'textFile') {
      void pick([new File([plan.text], plan.name, { type: 'text/plain' })])
      setNotice(pt
        ? 'O texto colado era grande demais para a primeira mensagem, então foi anexado como arquivo.'
        : 'The pasted text was too large for a first message, so it was attached as a file.')
    }
  }

  /**
   * THE REVIEW — every answer in one place, and the honest word for each one left unset.
   *
   * "Padrão do assistente" is not the same as blank: one says a decision was deferred to the CLI,
   * the other reads as a field somebody forgot. A question the harness never asked (a model on a
   * harness that names none) is ABSENT here rather than shown as unset, for the same reason it was
   * skipped in step 1 — reporting "Model: default" for a harness with no model flag describes a
   * choice nobody was offered.
   */
  const reviewPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <ReviewRow label={pt ? 'Assistente' : 'Assistant'} value={
        harness ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <HarnessMark harness={harness.id} size={16} />
            {(HARNESS_LABELS as Record<string, string>)[harness.id] ?? harness.label}
          </span>
        ) : null
      } />
      {visibleQuestions(wizardHarness).model && (() => {
        // The SAME pure rule the picker renders, so the review cannot name the choice differently
        // one step after it was made.
        const shown = modelDisplay(wizardHarness!.models, model)
        return (
          <ReviewRow label={pt ? 'Modelo' : 'Model'}
            value={shown ? (
              // Wraps: at 390px the review's value column is ~165px, and a name plus its id is
              // wider than that on several of agy's models. Wrapping keeps the page from scrolling
              // sideways, which is the one thing no screen here may do.
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 7 }}>
                {shown.label}
                {shown.id && <ModelId id={shown.id} />}
              </span>
            ) : null}
            muted={modelUnset} />
        )
      })()}
      {visibleQuestions(wizardHarness).effort && (
        <ReviewRow label={pt ? 'Esforço' : 'Effort'} value={effort || null} muted={effortUnset} />
      )}
      {/* No `muted` fallback: the title is required, so the review can never reach this row with
          nothing in it — and offering a sentence for a state the gate forbids would describe a
          choice nobody was allowed to make. */}
      <ReviewRow label={pt ? 'Título' : 'Title'} value={label || null} />
      <ReviewRow label={pt ? 'Onde' : 'Where'} value={cwd || null} mono />
      <ReviewRow label={pt ? 'Entrega' : 'Delivery'} value={task || null}
        muted={task === '' ? (pt ? 'Nenhuma' : 'None') : undefined} />
      <ReviewRow label={pt ? 'Primeira mensagem' : 'First message'} value={prompt || null}
        muted={prompt === '' ? (pt ? 'Nenhuma — a sessão abre esperando você' : 'None — the session opens waiting for you') : undefined} />
      {attachments.length > 0 && (
        <ReviewRow label={pt ? 'Anexos' : 'Attachments'} value={
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {attachments.map(a => (
              <span key={a.path} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
                borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
                fontSize: 11.5,
              }}>
                <Paperclip size={11} /> {a.name}
              </span>
            ))}
          </span>
        } />
      )}
    </div>
  )

  /** The first message as it will be TYPED: the attachment paths, then the words. */
  const promptWithAttachments = [...attachments.map(a => a.path), prompt].filter(x => x !== '').join('\n')

  async function start() {
    if (!canStart) return
    setBusy(true)
    setNotice(null)
    try {
      // `/api/fleet/new`, never `/api/fleet/spawn`: the same body, but read by the pure
      // `fleet-spawn.ts`, which REFUSES rather than repairs — a relative cwd, an effort outside the
      // CLI's own enum, a model asked of a harness with no model flag. A spawn is the most powerful
      // thing this server does, and there is no reason for the browser to reach the unvalidated
      // twin of a validated route.
      const res = await fetch(`/api/fleet/new?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          harness: harness!.id,
          cwd,
          ...(task ? { task } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          // The paths go FIRST, each on its own line, then what was typed — the same order the
          // composer uses. An assistant reads the files it is pointed at, and a path buried inside
          // a sentence is one it can miss.
          ...(promptWithAttachments ? { prompt: promptWithAttachments } : {}),
          ...(label ? { label } : {}),
        }),
      })
      const json = await res.json() as { ok: boolean; message: string; id?: string }
      if (json.ok) {
        // Still `busy` — the button keeps saying it is working, because it is.
        if (json.id) await waitForRow(json.id)

        const finish = () => {
          setBusy(false)
          onStarted(json.id, {
            ...(harness ? { harness: harness.id } : {}),
            ...(label ? { label } : {}),
          })
        }

        // The session EXISTS now, so this is the true first moment its filing can actually be
        // attempted — a subtask picked a minute ago may have been blocked all along, or someone
        // else may have filed the last open one under it in between. Never retried silently: the
        // person picked a SPECIFIC subtask, and filing under a different one because that is what
        // was free would be a session filed somewhere nobody chose.
        if (subtaskTarget && json.id) {
          const { taskId, subtaskId } = subtaskTarget
          const result = await attachSession(taskId, json.id, subtaskId)
          // `blocked` is a SUBTASK concept — a bare task-level attach (no `subtaskId`) can never
          // come back refused this way, so the branch below only ever runs with a real subtask id.
          if (!result.ok && result.reason === 'blocked' && subtaskId) {
            const detailRes = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`).catch(() => null)
            const body = detailRes?.ok ? await detailRes.json() as { task: TaskDetail } : null
            setBlockedDetail(body?.task ?? null)
            setSubtaskBlocked({ taskId, subtaskId, blockedBy: result.blockedBy ?? [], sessionId: json.id })
            // The session already exists and is left UNFILED while this is open — it is not lost,
            // it is one `SessionFiling` click away, and finishing the wizard is not held hostage by
            // a question about a piece of work that is not this session's own.
            setBusy(false)
            return
          }
        }
        finish()
        return
      }
      setBusy(false)
      setNotice(json.message)
    } catch {
      setBusy(false)
      setNotice(pt ? 'Erro de rede ao falar com esta máquina.' : 'Network error talking to this machine.')
    }
  }

  // Replaces the wizard outright, exactly as `SessionFiling` does for the same reason: the
  // session this is about already EXISTS by the time this can appear, so the form behind it has
  // nothing left to ask, and stacking two fixed overlays would double the scrim.
  if (subtaskBlocked) {
    const finish = () => {
      setSubtaskBlocked(null)
      onStarted(subtaskBlocked.sessionId, {
        ...(harness ? { harness: harness.id } : {}),
        ...(label ? { label } : {}),
      })
    }
    return (
      <BlockedSubtaskResolve
        taskId={subtaskBlocked.taskId}
        blockedSubtaskTitle={blockedDetail?.subtasks.find(s => s.id === subtaskBlocked.subtaskId)?.title ?? ''}
        blockedBy={subtaskBlocked.blockedBy}
        subtasks={blockedDetail?.subtasks ?? []}
        sessions={blockedDetail?.sessions ?? []}
        lang={lang}
        // Declining to resolve it does not undo the session — it was created a moment ago and
        // stays exactly as unfiled as any session started outside this wizard, one `SessionFiling`
        // click away from the same subtask once it is free.
        onCancel={finish}
        onResolved={async () => {
          const { taskId, subtaskId } = subtaskBlocked
          await attachSession(taskId, subtaskBlocked.sessionId, subtaskId)
          finish()
        }}
      />
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pt ? 'Nova sessão' : 'New session'}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 16, width: '100%', maxWidth: 620, maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
            {pt ? 'Nova sessão' : 'New session'}
          </h2>
          <button
            onClick={onClose}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </header>

        {/* WHERE YOU ARE, in a band of its own.
            It was a row of pills crammed beside the title, which is why it read as clutter: four
            labelled controls competing with the heading for one line. A wizard's progress is not a
            control group — it is a TRACK you move along, so it is drawn as one, full width, with
            the line between two steps carrying the state of the passage between them.
            A step already PASSED is clickable: going back to change one answer is ordinary, and
            making it cost three presses of Back is the wizard being pleased with itself. A step
            AHEAD is not — it may be gated by an answer this one has not given, which `stepReady`
            decides. */}
        <nav aria-label={pt ? 'Etapas' : 'Steps'} style={{
          display: 'flex', alignItems: 'flex-start',
          padding: '16px 24px 14px', borderBottom: '1px solid var(--border)',
        }}>
          {STEP_ORDER.map((id, i) => {
            const done = i < stepIndex
            const here = id === step
            const reachable = done
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'flex-start', flex: i === STEP_ORDER.length - 1 ? '0 0 auto' : 1, minWidth: 0 }}>
                <button
                  onClick={() => { if (reachable) setStep(id) }}
                  disabled={!reachable && !here}
                  aria-current={here ? 'step' : undefined}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    border: 'none', background: 'transparent', padding: 0, flexShrink: 0,
                    cursor: reachable ? 'pointer' : 'default', fontFamily: 'inherit',
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 26, height: 26, borderRadius: 999, fontSize: 12, fontWeight: 700,
                    boxSizing: 'border-box',
                    background: done ? 'var(--anthropic-orange)'
                      : here ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                    border: here ? '1.5px solid var(--anthropic-orange)' : '1.5px solid transparent',
                    color: done ? '#fff' : here ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                    transition: 'background 0.18s, color 0.18s, border-color 0.18s',
                  }}>
                    {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                  </span>
                  <span style={{
                    fontSize: 11, whiteSpace: 'nowrap',
                    fontWeight: here ? 700 : 500,
                    color: here ? 'var(--text-primary)' : done ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                  }}>
                    {STEP_TITLE[id]}
                  </span>
                </button>
                {/* The line BETWEEN two steps carries the state of the passage between them: filled
                    once you have crossed it. It sits on the dot's centre line, not the label's. */}
                {i < STEP_ORDER.length - 1 && (
                  <span aria-hidden style={{
                    flex: 1, height: 2, margin: '12px 8px 0', borderRadius: 2, minWidth: 12,
                    background: done ? 'var(--anthropic-orange)' : 'var(--border)',
                    opacity: done ? 0.55 : 1,
                    transition: 'background 0.18s',
                  }} />
                )}
              </div>
            )
          })}
        </nav>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* STEP 1 — WHO. The assistant, and the two answers that only exist once one is
              chosen: a model and an effort. The TITLE is here too — it is what you will look
              for in the list later, so it is asked while you are deciding what this IS, and it
              is the one answer on this step that is REQUIRED. */}
          {step === 'assistant' && (<>
          <Field label={pt ? 'Assistente' : 'Assistant'}>
            <HarnessPicker
              lang={lang}
              harnesses={harnesses}
              value={harness?.id ?? ''}
              onChange={id => setHarness(harnesses?.find(h => h.id === id) ?? null)}
            />
          </Field>

          {/* SKIPPED, not disabled, when the CLI has no such flag — see the header. Skipped for the
              same reason when the harness offers NO names: `modelSuggestions` is empty exactly
              where that CLI publishes no list of its own (see `spawn-spec.ts`), and a closed
              dropdown whose only entry is "the assistant's default" is a control that cannot be
              used. An absent picker says "we cannot name these for you"; a one-option one says
              nothing at all. */}
          {visibleQuestions(wizardHarness).model && (
            <Field label={pt ? 'Modelo (opcional)' : 'Model (optional)'}>
              {/* A CLOSED picker, never free text: the list is the actual set this harness offers,
                  and a typed id it does not recognise fails at spawn with no explanation on
                  screen. The wizard's job is to offer only what will work.

                  It was a bare `<select>`, which on every platform draws the OS's own menu — a
                  control that ignores this application's palette and its 44px mobile target, and
                  the only one in the wizard that did. `ModelSelect` is the same shape as the value
                  pickers in `FiltersBar`: a trigger, a popover, one checked row per value. */}
              <ModelSelect
                lang={lang}
                open={modelOpen}
                onOpenChange={setModelOpen}
                value={model}
                onChange={setModel}
                options={wizardHarness!.models}
                unsetLabel={modelUnset}
              />
            </Field>
          )}

          {visibleQuestions(wizardHarness).effort && (
            <Field label={pt ? 'Esforço (opcional)' : 'Effort (optional)'} hint={pt
              ? `Mais esforço pensa por mais tempo e custa mais. Sem escolha: ${effortUnset}.`
              : `More effort thinks for longer and costs more. Left unset: ${effortUnset}.`}>
              <EffortPicker efforts={wizardHarness!.efforts} value={effort} onChange={setEffort} />
            </Field>
          )}

          {/* REQUIRED, and the gate is `stepReady('assistant')`'s — see `wizardSteps.ts`. It is
              asked here rather than at the end because a title is what this session IS, and that
              is the thing you know while you are deciding to start it. */}
          <Field label={pt ? 'Título' : 'Title'} hint={pt
            ? 'É por ele que você acha esta sessão na lista depois.'
            : 'It is how you find this session in the list later.'}>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={pt ? 'O que esta sessão é…' : 'What this session is…'}
              aria-label={pt ? 'Título' : 'Title'}
              aria-required
              style={{ ...inputStyle, paddingLeft: 12 }}
            />
          </Field>
          </>)}

          {/* STEP 2 — WHERE. The directory, and the delivery that files this session with its
              siblings. Both are about the WORK rather than about the assistant. */}
          {step === 'where' && (<>
          <Field label={pt ? 'Onde' : 'Where'}>
            <ProjectPicker
              lang={lang}
              isMobile={isMobile}
              projects={projects}
              projectTotals={projectTotals}
              query={query}
              onQueryChange={setQuery}
              searching={searching}
              value={cwd}
              onChange={setCwd}
            />
          </Field>

          {/*
            * The delivery. This is the PRIMARY door for filing a session: the field is here, filled
            * in, before the session exists — every other surface is a repair afterwards.
            *
            * It is a PICKER and not a text field. It used to be an input with a datalist, which
            * meant typing "ALM Board" where "ALM board" existed created a SECOND delivery with the
            * metrics split between the two and nothing on screen saying so. The row menu had
            * already been fixed this way; the form that files most sessions had not.
            */}
          <Field label={pt ? 'Entrega (opcional)' : 'Delivery (optional)'} hint={pt
            ? 'Agrupa várias sessões como um trabalho só, e é o que permite reabrir todas de uma vez.'
            : 'Groups several sessions as one piece of work, and is what lets you reopen them all at once.'}>
            <button
              type="button"
              onClick={() => setPickingTask(true)}
              style={{
                ...inputStyle, paddingLeft: 12, display: 'flex', alignItems: 'center', gap: 8,
                textAlign: 'left', cursor: 'pointer',
                color: task ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              <ClipboardList size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {task || (pt ? 'Nenhuma — escolher ou criar…' : 'None — pick or create…')}
              </span>
              <ChevronDown size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            </button>
            {/*
              * The hint. The field NEVER fills itself in — see `deliveryHint` — so this is the
              * only way the suggestion reaches the field at all: a click, exactly like picking it
              * from `TaskPicker`. It disappears the moment the field holds anything, chosen or
              * typed, which is also why there is no [×] to dismiss it any more — there is nothing
              * here that was ever applied without being asked for.
              */}
            {hint && (
              <button
                type="button"
                onClick={() => acceptHint(hint)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, width: '100%',
                  padding: '5px 8px', borderRadius: 6, textAlign: 'left', cursor: 'pointer',
                  background: 'var(--bg-elevated)', border: '1px dashed var(--border-subtle)',
                  fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'inherit',
                  minHeight: isMobile ? 44 : undefined, boxSizing: 'border-box',
                }}
              >
                <ClipboardList size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {pt
                    ? `Usar "${hint.title}" — ${hint.sameFolder} ${hint.sameFolder === 1 ? 'sessão desta pasta está' : 'sessões desta pasta estão'} nesta entrega`
                    : `Use "${hint.title}" — ${hint.sameFolder} session${hint.sameFolder === 1 ? '' : 's'} in this folder ${hint.sameFolder === 1 ? 'is' : 'are'} filed here`}
                </span>
              </button>
            )}
          </Field>

          {pickingTask && (
            <TaskPicker
              title={boardCopy(lang).fileUnder}
              lang={lang}
              onPick={pick => {
                setTask(pick.taskTitle)
                setSubtaskTarget({ taskId: pick.taskId, subtaskId: pick.subtaskId })
                setPickingTask(false)
              }}
              onClose={() => setPickingTask(false)}
            />
          )}
          </>)}

          {/* STEP 3 — WHAT. The first message, and the files it points at. */}
          {step === 'message' && (<>
          <Field
            label={pt ? 'Primeira mensagem (opcional)' : 'First message (optional)'}
            hint={pt
              ? 'Cole (Ctrl+V) ou arraste arquivos aqui para anexá-los.'
              : 'Paste (Ctrl+V) or drop files here to attach them.'}
          >
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onPaste={onPastePrompt}
              onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
              onDrop={e => {
                if (e.dataTransfer.files.length === 0) return
                e.preventDefault()
                void pick(e.dataTransfer.files)
              }}
              rows={3}
              placeholder={pt ? 'O que a sessão deve fazer…' : 'What the session should do…'}
              style={{ ...inputStyle, paddingLeft: 12, resize: 'vertical', minHeight: 68 }}
            />
          </Field>

          <Field label={pt ? 'Anexos (opcional)' : 'Attachments (optional)'} hint={pt
            ? 'Os arquivos ficam nesta máquina; a primeira mensagem carrega o caminho de cada um.'
            : 'The files stay on this machine; the first message carries the path of each one.'}>
            <input
              ref={fileRef}
              type="file"
              multiple
              onChange={e => void pick(e.target.files)}
              style={{ display: 'none' }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {attachments.map(a => (
                <span key={a.path} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 6px 4px 9px',
                  borderRadius: 8, background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)', fontSize: 12,
                }}>
                  <Paperclip size={11} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                  <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <button
                    onClick={() => setAttachments(list => list.filter(x => x.path !== a.path))}
                    aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
                    style={{
                      display: 'flex', border: 'none', background: 'transparent', cursor: 'pointer',
                      color: 'var(--text-tertiary)', padding: 2,
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px',
                  borderRadius: 8, cursor: uploading ? 'default' : 'pointer',
                  border: '1px dashed var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
                }}
              >
                {uploading ? <Loader size={12} /> : <Paperclip size={12} />}
                {uploading ? (pt ? 'Enviando…' : 'Uploading…') : (pt ? 'Anexar arquivo' : 'Attach file')}
              </button>
            </div>
          </Field>
          </>)}

          {/* STEP 4 — the REVIEW, rendered by `reviewRows` below. */}
          {step === 'review' && reviewPane}

          {notice && (
            <p role="status" style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--anthropic-orange)' }}>
              {notice}
            </p>
          )}
        </div>

        <footer style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          padding: '14px 20px', borderTop: '1px solid var(--border)',
        }}>
          {/* WHY THE STEP IS BLOCKED, beside the button that will not move. A disabled control
              with no sentence next to it is indistinguishable from a broken one — the rule this
              product applies to every refusal, applied to a wizard. */}
          {blockedBecause && (
            <span role="status" style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-tertiary)' }}>
              {blockedBecause}
            </span>
          )}
          <button
            onClick={() => (stepIndex === 0 ? onClose() : setStep(prevStep(step)))}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 14px', borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'transparent',
              color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 13,
            }}
          >
            {stepIndex > 0 && <ChevronLeft size={14} />}
            {stepIndex === 0 ? (pt ? 'Cancelar' : 'Cancel') : (pt ? 'Voltar' : 'Back')}
          </button>
          {step !== 'review' ? (
            <button
              onClick={() => { if (ready.ok) setStep(nextStep(step)) }}
              disabled={!ready.ok}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '9px 16px', borderRadius: 9, border: 'none',
                background: ready.ok ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                color: ready.ok ? '#fff' : 'var(--text-tertiary)',
                cursor: ready.ok ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 13, fontWeight: 650,
              }}
            >
              {pt ? 'Continuar' : 'Continue'}
              <ChevronRight size={14} />
            </button>
          ) : (
            <button
              onClick={() => void start()}
              disabled={!canStart}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '9px 16px', borderRadius: 9, border: 'none',
                background: canStart ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                color: canStart ? '#fff' : 'var(--text-tertiary)',
                cursor: canStart ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 13, fontWeight: 650,
              }}
            >
              {busy && <Loader size={14} />}
              {busy
                ? (pt ? 'Iniciando…' : 'Starting…')
                : (pt ? 'Iniciar sessão' : 'Start session')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

/**
 * One line of the review: what was asked, and what will be used.
 *
 * `muted` is the answer for a question left unset, and it is a SENTENCE rather than a blank — "the
 * assistant's default" and "none" are decisions, while an empty cell reads as a field somebody
 * forgot to fill in and sends the reader back through the steps looking for it.
 */
function ReviewRow({ label, value, muted, mono }: {
  label: string
  value: React.ReactNode | null
  muted?: string
  mono?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '9px 0', borderBottom: '1px solid var(--border-subtle)',
    }}>
      <span style={{
        minWidth: 132, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
        textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 1,
      }}>{label}</span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5,
        color: value ? 'var(--text-primary)' : 'var(--text-tertiary)',
        fontStyle: value ? 'normal' : 'italic',
        fontFamily: mono && value ? 'var(--font-mono, ui-monospace, monospace)' : 'inherit',
        wordBreak: 'break-word', whiteSpace: 'pre-wrap',
      }}>{value ?? muted ?? '—'}</span>
    </div>
  )
}


