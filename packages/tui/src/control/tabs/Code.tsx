/**
 * Code — the native session, in the terminal (the `code` tab; spec items CD-01…19, NW-01, NW-06,
 * GL-02/04/05/06).
 *
 * Everything that decides what a frame SAYS is in `../code.ts`, `../code-panels.ts`,
 * `../prompt-history.ts`, `../clipboard.ts` and `../code-wizard.ts` (pure, tested): the fold of the
 * host's events, the layout, every line, what each key means and which keys the footer names. This
 * file holds React state, talks to `host.code`, and draws.
 *
 * It owns no rule about a session either — the "control center owns no logic" rule. The host decides
 * whether a native session can run here, what a permission's options are and in which order, what
 * a refusal says; this screen folds, renders and reports intents. Every action and every refusal
 * leaves ONE sentence on the shell's status row (`onSay`), so nothing is silently inert.
 *
 * It CAPTURES the keyboard whenever the native runtime is available — the composer is always live,
 * and a `q` typed into a prompt must be a `q`, not a quit. That is why the shell hands it `onTab`:
 * with the shell's global keys standing down, `[` and `]` (on an empty draft) are this screen's to
 * forward, or the tab would be a room with no door.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { COLORS } from '../../theme'
import { Pane, paneBody, paneRows } from '../Pane'
import { windowOffset } from '../nav'
import {
  CODE_HEADER_ROWS,
  EMPTY_VIEW,
  FOLLOW,
  STREAM_FLUSH_MS,
  effectiveMode,
  lastFinishedAnswer,
  longOutputShown,
  modeWord,
  nextPanel,
  panelTitle,
  codeHints,
  codeKeyIntent,
  codeLayout,
  columnRows,
  composerHint,
  composerLine,
  conversationLines,
  createCoalescer,
  fitLine,
  fullDiffLines,
  headerLine,
  matchCommands,
  narrowStatusLine,
  permissionCardLines,
  permissionTitle,
  popupLines,
  reduceAll,
  scrollTail,
  seg,
  sessionPanelLines,
  tailStart,
  wrapText,
  type CodeIntent,
  type CodeView,
  type Line,
  type PanelSide,
  type TailScroll,
} from '../code'
import { clampPanelTop, inspectorLines, panelWindow, resolveTurn, timelineLines } from '../code-panels'
import { historyKey, historyLines, openHistory, type HistoryState } from '../prompt-history'
import { OSC52_MAX_CHARS, charCount, osc52 } from '../clipboard'
import { writeFrame } from '../altScreen'
import {
  openWizard,
  taskCreated,
  wizardHints,
  wizardKey,
  wizardLines,
  withModels,
  harnessModels,
  assistantRows,
  folderRows,
  type WizardEffect,
  type WizardServices,
  type WizardState,
} from '../code-wizard'
import { codeStrings } from '../code-i18n'
import type { CodeEvent, CodeHost, CodeLaunch, CodeSessionFacts } from '../code-types'
import type { ControlStrings } from '../i18n'
import type { CliLang } from '../lang'
import type { ActionResult } from '../types'
import type { TabChrome } from '../ControlCenter'

export interface CodeProps {
  /** The native harness is experimental and off (`agentop experimental enable`): said instead. */
  gateSentence?: string
  /** NW-02…NW-05: what the wizard asks the control center for (assistants, models, folders, spawn). */
  services?: WizardServices
  /** Absent: this build has no native runtime, and the tab says so in words. */
  code?: CodeHost
  /** How `agentop code …` opened the tab — acted on once, on the first mount. */
  launch?: CodeLaunch
  /** GL-03: a command the palette sends here — a new object each time, performed once. */
  command?: { intent: CodeIntent }
  /** GL-03: `ctrl+p` opens the shell's palette (this tab captures the keyboard, so it forwards it). */
  onPalette?: () => void
  /** GL-03: what the palette needs to say which commands can run here. */
  onPaletteContext?: (ctx: { sessionOpen: boolean; running: boolean; askWithDiff: boolean }) => void
  lang: CliLang
  strings: ControlStrings
  width: number
  height: number
  isActive: boolean
  onChrome: (chrome: TabChrome) => void
  /** One sentence on the shell's status row, without the heavy `run()` path (GL-06). */
  onSay: (result: ActionResult) => void
  /** Change tab — the shell's own keys stand down while this screen captures. */
  onTab: (step: 1 | -1) => void
  /**
   * GL-02: how many things on this tab wait on a person — 1 while a question is open, 0 otherwise.
   * Reported whether or not the tab is on screen: the question is asked while it is hidden too.
   */
  onAttention?: (count: number) => void
  /** GL-04: `?` on an empty draft opens the shell's help overlay. Absent: `?` is typed. */
  onHelp?: () => void
  /**
   * CD-19: where a terminal control sequence goes. Default `writeFrame` — the gate Ink draws through,
   * never `process.stdout.write`, which would land in the buffer Ink is repainting. A test passes a
   * recorder.
   */
  writeTerminal?: (bytes: string) => void
  /** Whether this process runs inside tmux (the OSC 52 caveat). Default: `$TMUX` is set. */
  inTmux?: boolean
}

type ViewAction = { type: 'events'; events: CodeEvent[] } | { type: 'reset' }

function viewReducer(view: CodeView, a: ViewAction): CodeView {
  return a.type === 'reset' ? EMPTY_VIEW : reduceAll(view, a.events)
}

/** One pre-fitted line: its segments, each in its own style. */
function LineRow({ line }: { line: Line }) {
  if (line.length === 0) return <Text> </Text>
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          backgroundColor={s.bg}
          bold={s.bold}
          dimColor={s.dim}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

/** Exactly `rows` rows of `lines` — cut, never grown, and never composited over what is below. */
export function Lines({ lines, rows, width, indent = 0 }: { lines: Line[]; rows: number; width: number; indent?: number }) {
  if (rows <= 0) return null
  return (
    <Box flexDirection="column" width={width} height={rows} flexShrink={0} overflow="hidden" paddingLeft={indent}>
      {lines.slice(0, rows).map((l, i) => <LineRow key={i} line={l} />)}
    </Box>
  )
}

/**
 * `useState` whose newest value is also kept in a ref, written in the same call that queues the
 * render. A key handler that reads the render's closure sees the value of the LAST RENDER, so two
 * keystrokes delivered before React re-renders both extend the same old draft and the first one is
 * lost; reading the ref makes each keystroke build on the one before it.
 */
function useLatestState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void, { readonly current: T }] {
  const [value, setValue] = useState<T>(initial)
  const ref = useRef<T>(initial)
  const set = useCallback((next: T | ((prev: T) => T)) => {
    const v = typeof next === 'function' ? (next as (prev: T) => T)(ref.current) : next
    ref.current = v
    setValue(v)
  }, [])
  return [value, set, ref]
}

const defaultWrite = (bytes: string): void => { writeFrame(bytes) }

export function Code({
  code, gateSentence, services, launch, command, lang, strings: s, width, height, isActive, onChrome, onSay, onTab,
  onAttention, onHelp, onPalette, onPaletteContext, writeTerminal = defaultWrite, inTmux = Boolean(process.env.TMUX),
}: CodeProps) {
  const t = codeStrings(lang)
  const availability = useMemo(() => (code ? code.availability() : null), [code])
  const available = Boolean(code && availability?.ok)

  const [facts, setFacts] = useState<CodeSessionFacts | null>(null)
  const [view, dispatch] = useReducer(viewReducer, EMPTY_VIEW)
  const [draft, setDraft, draftRef] = useLatestState('')
  const [popup, setPopup] = useState(0)
  const [wizard, setWizard, wizardRef] = useLatestState<WizardState | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  // CD-08: the reason being typed for a denial; null while the options show.
  const [reason, setReason] = useState<string | null>(null)
  const [diffTop, setDiffTop] = useState(0)
  const [scroll, setScroll] = useState<TailScroll>(FOLLOW)
  // Two switches because the panel's default differs by layout: beside the conversation on a wide
  // terminal (so `ctrl+b` HIDES it), over it on a narrow one (so `ctrl+b` SHOWS it). One flag would
  // flip its meaning when the terminal is resized across the threshold.
  const [wideHidden, setWideHidden] = useState(false)
  const [narrowShown, setNarrowShown] = useState(false)
  /** What the panel shows (D-TUI-2): the session, the picked turn, or the run's timeline. */
  const [side, setSide] = useState<PanelSide>('session')
  /** The turn the inspector has picked; `null` follows the newest one as turns arrive. */
  const [selTurn, setSelTurn] = useState<number | null>(null)
  /** CD-10: long tool output expanded (`ctrl+o`), for the whole tab. */
  const [outputOpen, setOutputOpen] = useState(false)
  /** CD-18: the prompt-history overlay. */
  const [hist, setHist, histRef] = useLatestState<HistoryState | null>(null)
  /** CD-17: `$EDITOR` holds the draft; keys are ignored until it gives it back. */
  const [editing, setEditing, editingRef] = useLatestState(false)
  /** A clock tick for the live figures (a running turn's duration, an open wait's bar). */
  const [, setTick] = useState(0)
  /** The panel's own scroll (its content can outgrow its rows). */
  const [panelTop, setPanelTop] = useState(0)

  /** A prompt to send once the session's events are being read — see the subscribe effect. */
  const pendingSend = useRef<string | null>(null)
  const factsRef = useRef<CodeSessionFacts | null>(null)
  factsRef.current = facts

  const say = useCallback((ok: boolean, message: string) => {
    if (message) onSay({ ok, message })
  }, [onSay])

  // ── the session ──────────────────────────────────────────────────────────────────────────

  /**
   * Show `next`. The session that was open is released (`end` drops its lease; it stays on disk,
   * resumable) — driving two sessions from one tab would leave the first one asking questions
   * nobody can see, and an unwatched question is a denial.
   */
  const openSession = useCallback((next: CodeSessionFacts) => {
    const prev = factsRef.current
    if (prev && prev.sessionId !== next.sessionId) void code?.end(prev.sessionId)
    dispatch({ type: 'reset' })
    setScroll(FOLLOW)
    setDiffOpen(false)
    setDraft('')
    setSelTurn(null)
    setOutputOpen(false)
    setFacts(next)
  }, [code])

  // Subscribe for as long as a session is open — including while the tab is HIDDEN: a run only asks
  // while somebody is watching, so dropping the reader on a tab switch would turn every permission
  // into a silent denial. Deltas are coalesced (CD-02): at most one repaint per `STREAM_FLUSH_MS`.
  useEffect(() => {
    if (!code || !facts) return
    const coalescer = createCoalescer({
      intervalMs: STREAM_FLUSH_MS,
      deliver: events => dispatch({ type: 'events', events }),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    })
    const unsubscribe = code.subscribe(facts.sessionId, e => coalescer.push(e))
    // A prompt that arrived with a RESUME is sent only now: sent before the reader exists, the run
    // it starts could ask a question nobody is subscribed to, and the hub reads that as a denial.
    const first = pendingSend.current
    if (first) {
      pendingSend.current = null
      const r = code.submit(facts.sessionId, first)
      if (!r.ok) say(false, r.sentence)
    }
    return () => { unsubscribe(); coalescer.dispose() }
  }, [code, facts, say])

  // ── the wizard ───────────────────────────────────────────────────────────────────────────

  // NW-02: each installed harness's own model rows, kept by id for the model step.
  const harnessInfo = useRef(new Map<string, { modelSuggestions: string[]; defaultModel?: string }>())
  const startWizard = useCallback((firstMessage?: string, taskId?: string) => {
    if (!code) return
    setWizard(openWizard(firstMessage ?? ''))
    // The reads start at once; each lands only on a wizard that is still open. TK-06: a task chosen
    // by the `tasks` tab is picked as soon as the list arrives, and the wizard goes to the assistant.
    void code.openTasks().then(r => setWizard(w => {
      if (!w) return w
      if (!r.ok) return { ...w, tasksError: r.sentence }
      const chosen = taskId ? r.tasks.find(t => t.id === taskId) : undefined
      return chosen
        ? { ...w, tasks: r.tasks, tasksError: null, task: chosen, cursor: 0, step: 'assistant' }
        : { ...w, tasks: r.tasks, tasksError: null }
    }))
    const defaultsP = code.defaults()
    void defaultsP.then(d => setWizard(w => (w ? { ...w, defaults: d } : w)))
    void (services?.harnesses?.() ?? Promise.resolve([])).catch(() => []).then(list => {
      harnessInfo.current = new Map(list.map(h => [h.id, { modelSuggestions: h.modelSuggestions, ...(h.defaultModel ? { defaultModel: h.defaultModel } : {}) }]))
      const assistants = assistantRows(list, { native: true, nativeLabel: t.assistantNative, nativeNote: t.nativeAssistantNote, harnessNote: t.harnessAssistantNote })
      setWizard(w => (w ? { ...w, assistants } : w))
    })
    void Promise.all([defaultsP.catch(() => null), (services?.places?.() ?? Promise.resolve([])).catch(() => [])]).then(([d, places]) => {
      const folders = folderRows(places, d?.cwd ?? null, t)
      setWizard(w => (w ? { ...w, folders } : w))
    })
  }, [code, services, t])

  // `agentop code "…"` / `agentop code --resume <id>`, and the `home` tab's prompt / resume (HM-02,
  // HM-04): each LAUNCH OBJECT is acted on once. A new launch (a new object) is acted on again; a
  // re-render with the same one is harmless.
  const launched = useRef<CodeLaunch | undefined>(undefined)
  useEffect(() => {
    if (!launch || launched.current === launch || !code || !available) return
    launched.current = launch
    if (launch.resume) {
      void code.resume(launch.resume).then(r => {
        if (!r.ok) { say(false, r.sentence); return }
        if (launch.prompt?.trim()) pendingSend.current = launch.prompt.trim()
        openSession(r.facts)
        say(true, r.sentence)
      })
      return
    }
    startWizard(launch.prompt, launch.taskId)
  }, [launch, code, available, openSession, startWizard, say])

  const performWizard = useCallback((effect: WizardEffect) => {
    if (!code) return
    switch (effect.kind) {
      case 'none': return
      case 'close': setWizard(null); return
      case 'say':
        say(false, effect.code === 'empty-title' ? t.sayEmptyTitle : t.sayLoadingDefaults)
        return
      case 'refuse': say(false, effect.sentence); return
      case 'create-task':
        say(true, t.sayCreatingTask)
        void code.createTask(effect.title).then(r => {
          if (r.ok) { setWizard(w => (w ? taskCreated(w, r.task) : w)); say(true, t.sayTaskCreated(r.task.ref, r.task.title)) }
          else { say(false, r.sentence); setWizard(w => (w ? { ...w, busy: false } : w)) }
        })
        return
      case 'load-models': {
        // NW-03: the native assistant's catalogue comes from the host; a harness's from its own spec.
        const a = effect.assistant
        if (!a.native) {
          const info = harnessInfo.current.get(a.id) ?? { modelSuggestions: [] }
          setWizard(w => (w ? withModels(w, { models: harnessModels(info, t) }) : w))
          return
        }
        const read = services?.nativeModels
        // No catalogue to ask (a host without one): the model the tab would use anyway, or why none.
        if (!read) {
          setWizard(w => {
            if (!w) return w
            const d = w.defaults
            return withModels(w, d?.model
              ? { models: [{ id: d.model.id, provider: d.provider, label: `${d.provider} · ${d.model.id}`, detail: d.model.source === 'flag' ? t.fromFlag : t.fromLastSession }] }
              : { sentence: d?.noModelSentence ?? t.unavailableBuild })
          })
          return
        }
        void read().then(r => setWizard(w => (w ? withModels(w, r) : w)))
        return
      }
      case 'start':
      case 'spawn': {
        const fail = (sentence: string) => { say(false, sentence); setWizard(w => (w ? { ...w, busy: false } : w)) }
        // NW-04: a new worktree is created first; the session starts in the folder it made.
        const makeWorktree = async (): Promise<string | null> => {
          if (!effect.worktree) return effect.cwd
          if (!services?.createWorktree) { fail(t.unavailableBuild); return null }
          say(true, t.sayCreatingWorktree)
          const r = await services.createWorktree(effect.cwd, effect.taskTitle)
          if (!r.ok) { fail(r.sentence); return null }
          say(true, r.sentence)
          return r.path
        }
        void makeWorktree().then(cwd => {
          if (cwd === null) return
          if (effect.kind === 'start') {
            say(true, t.sayStarting)
            void code.start({
              taskId: effect.taskId,
              model: effect.model,
              ...(effect.provider ? { provider: effect.provider } : {}),
              cwd,
              ...(effect.firstMessage ? { firstMessage: effect.firstMessage } : {}),
            }).then(r => {
              if (!r.ok) { fail(r.sentence); return }
              // NW-06: it lands on the new session — the host holds the first message until the
              // subscribe effect attaches, so nothing is sent unwatched.
              setWizard(null)
              openSession(r.facts)
              say(true, r.sentence)
            })
            return
          }
          // An installed harness runs under tmux, filed on the task; it lands on its new row.
          if (!services?.spawn) { fail(t.unavailableBuild); return }
          say(true, t.sayStartingHarness(effect.label))
          void services.spawn({
            harness: effect.harness, cwd, taskId: effect.taskId, task: effect.taskTitle,
            ...(effect.model ? { model: effect.model } : {}), ...(effect.prompt ? { prompt: effect.prompt } : {}),
          }).then(r => {
            if (!r.ok) { fail(r.message); return }
            setWizard(null)
            say(true, r.message)
            if (r.id) services.landOn?.(r.id)
          })
        })
        return
      }
    }
  }, [code, say, t, openSession, services])

  // ── geometry and lines ───────────────────────────────────────────────────────────────────

  const narrowNow = width < 100
  const panelOpen = narrowNow ? narrowShown : !wideHidden
  const layout = codeLayout(width, height, { panelOpen })
  const ask = view.ask
  // A new (or no) question closes a reason field that belonged to the previous one.
  useEffect(() => { setReason(null) }, [ask?.id])
  const closed = view.closed !== null
  const running = view.runId !== null
  const sessionOpen = facts !== null
  const mode = effectiveMode(view, facts)
  const shownFacts = facts && mode ? { ...facts, mode } : facts
  const inspecting = panelOpen && side === 'inspector'
  const pickedTurn = resolveTurn(view, selTurn)
  const convOptions = { expand: inspecting ? pickedTurn : null, highlight: inspecting, outputOpen }
  const longOutput = longOutputShown(view, convOptions.expand)
  const now = Date.now()

  // The panel's lines are built here, not inside its pane, because the footer has to know whether
  // they overflow before it can name the key that scrolls them.
  const panelInner = paneBody(layout.panelWidth)
  const panelRows = paneRows(layout.bodyRows)
  const panelAll: Line[] = layout.panel === 'hidden'
    ? []
    : side === 'inspector'
      ? inspectorLines(view, selTurn, shownFacts, t, panelInner, now)
      : side === 'timeline'
        ? timelineLines(view, selTurn, t, panelInner, now)
        : sessionPanelLines(view, shownFacts, t, panelInner)
  const panelOverflow = panelAll.length > panelRows
  const panelStart = clampPanelTop(panelAll.length, panelRows, panelTop)

  const mainInner = paneBody(layout.mainWidth)
  const convWidth = Math.max(1, layout.mainWidth - 2)
  const matches = ask ? [] : matchCommands(draft)
  const popupIndex = matches.length > 0 ? Math.min(popup, matches.length - 1) : null
  const hint = ask ? null : composerHint(draft, t, convWidth)
  const cardWant = ask ? permissionCardLines(ask, t, mainInner, undefined, mode).length + 2 : 0
  const rows = columnRows(layout.bodyRows, {
    card: cardWant,
    popup: matches.length > 0 ? matches.length + 2 : 0,
    hint: hint ? 1 : 0,
  })

  const convAll: Line[] = facts
    ? conversationLines(view, shownFacts, t, convWidth, convOptions)
    : wrapText(t.noSession, convWidth).map(l => [seg(l, { color: COLORS.muted })])
  const convStart = tailStart(convAll.length, rows.conversation, scroll)
  let convShown = convAll.slice(convStart, convStart + rows.conversation)
  // Say that there is more above, in words, where it is — but only when the pane can spare the row.
  if (convStart > 0 && rows.conversation >= 4) convShown = [fitLine([seg(t.olderAbove(convStart + 1), { color: COLORS.muted })], convWidth), ...convShown.slice(1)]
  const canScroll = convAll.length > rows.conversation

  const diff = ask && diffOpen ? fullDiffLines(ask, t, paneBody(width)) : null
  const underHeader = Math.max(0, height - CODE_HEADER_ROWS)
  // The body gets what the head and the options leave, and no more than it has: a short diff is
  // followed by its options directly rather than by a wall of blank rows above them.
  const diffRoom = diff ? Math.max(0, paneRows(underHeader) - diff.head.length - diff.options.length - 1) : 0
  const diffBodyRows = diff ? Math.min(diffRoom, diff.body.length) : 0
  const diffMax = diff ? Math.max(0, diff.body.length - diffBodyRows) : 0

  // A diff whose question closed (answered elsewhere, timed out) has nothing left to show.
  useEffect(() => { if (diffOpen && !ask) setDiffOpen(false) }, [diffOpen, ask])
  useEffect(() => { setPopup(0) }, [draft])
  // A different side or a different turn is a different document: it opens at its top.
  useEffect(() => { setPanelTop(0) }, [side, pickedTurn])

  // GL-02: a question waits on a person whether or not this tab is showing — the shell counts it.
  const asking = ask !== null
  useEffect(() => { onAttention?.(asking ? 1 : 0) }, [asking, onAttention])

  // The live figures move while nothing arrives: a running turn's duration, a wait that is still
  // open. One tick a second, only while the panel shows one of them and something is live.
  const liveFigures = panelOpen && side !== 'session' && (running || asking)
  useEffect(() => {
    if (!liveFigures) return
    const h = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(h)
  }, [liveFigures])

  const applyPanel = (next: { side: PanelSide; open: boolean }) => {
    setSide(next.side)
    if (narrowNow) setNarrowShown(next.open)
    else setWideHidden(!next.open)
  }

  // ── keys ─────────────────────────────────────────────────────────────────────────────────

  // GL-03: a command from the palette, performed once per object (a re-render is harmless).
  const performedCommand = useRef<{ intent: CodeIntent } | undefined>(undefined)
  useEffect(() => {
    if (!command || performedCommand.current === command || !available) return
    performedCommand.current = command
    perform(command.intent)
  })
  useEffect(() => {
    onPaletteContext?.({ sessionOpen, running, askWithDiff: Boolean(ask?.diff && ask.diff.files.length > 0) })
  }, [sessionOpen, running, ask?.id])

  const perform = (intent: CodeIntent) => {
    const sid = facts?.sessionId
    switch (intent.kind) {
      case 'none': return
      case 'draft': setDraft(intent.draft); return
      case 'tab': onTab(intent.step); return
      case 'toggle-panel': applyPanel(nextPanel({ side, open: panelOpen }, 'toggle')); return
      case 'panel-side': applyPanel(nextPanel({ side, open: panelOpen }, intent.side)); return
      case 'turn-move': {
        if (pickedTurn === null) return
        const last = view.turnStats.length - 1
        const next = Math.min(Math.max(0, pickedTurn + intent.delta), last)
        setSelTurn(next === last ? null : next)
        return
      }
      case 'panel-scroll': {
        const step = intent.page ? Math.max(1, panelRows - 2) : 1
        setPanelTop(clampPanelTop(panelAll.length, panelRows, panelStart + intent.dir * step))
        return
      }
      case 'cycle-mode': {
        if (!code || !sid || closed) { say(false, t.sayNoSessionForMode); return }
        const r = code.cycleMode(sid)
        if (r.ok) dispatch({ type: 'events', events: [{ kind: 'mode', mode: r.mode, direction: 'same', dropped: 0 }] })
        say(r.ok, r.sentence)
        return
      }
      case 'toggle-output':
        if (!outputOpen && !longOutput) { say(false, t.sayNoLongOutput); return }
        setOutputOpen(v => !v)
        return
      case 'open-editor': {
        if (ask) { say(false, t.sayLocked); return }
        if (!code) return
        setEditing(true)
        void code.editDraft(draftRef.current).then(r => {
          setEditing(false)
          if (r.ok) setDraft(r.text)
          say(r.ok, r.sentence)
        })
        return
      }
      case 'open-history': {
        if (ask) { say(false, t.sayLocked); return }
        if (!code) return
        setHist(openHistory())
        void code.promptHistory().then(r => setHist(h => (h
          ? (r.ok ? { ...h, prompts: r.prompts, error: null } : { ...h, error: r.sentence })
          : h)))
        return
      }
      case 'copy': {
        const text = lastFinishedAnswer(view)
        if (text === null) { say(false, t.sayNothingToCopy); return }
        const n = charCount(text)
        if (n > OSC52_MAX_CHARS) { say(false, t.sayCopyTooLong(n, OSC52_MAX_CHARS)); return }
        writeTerminal(osc52(text))
        say(true, t.sayCopied(n, inTmux))
        return
      }
      case 'help': onHelp?.(); return
      case 'scroll': setScroll(sc => scrollTail(convAll.length, rows.conversation, sc, intent.dir)); return
      case 'popup-move':
        setPopup(p => Math.min(Math.max(0, p + intent.delta), Math.max(0, matches.length - 1)))
        return
      case 'unknown-command': say(false, t.sayNoSuchCommand(intent.text)); setDraft(''); return
      case 'say': say(false, intent.code === 'no-diff' ? t.sayNoDiff : intent.code === 'locked' ? t.sayLocked : intent.code === 'reason-empty' ? t.sayReasonEmpty : t.sayAnswerFirst); return
      // CD-08: the reason field — open, edit, back to the options, or send the policy's Deny with it.
      case 'reason-open': setDiffOpen(false); setReason(''); return
      case 'reason-close': setReason(null); return
      case 'reason-draft': setReason(intent.draft); return
      case 'deny-reason': {
        if (!code || !sid || !ask || ask.denyIndex === null) return
        const r = code.answer(sid, ask.id, ask.denyIndex, intent.reason)
        say(r.ok, r.sentence)
        if (r.ok) { setReason(null); setDiffOpen(false) }
        return
      }
      case 'open-wizard': setDraft(''); startWizard(intent.firstMessage); return
      case 'close-diff': setDiffOpen(false); return
      case 'diff-scroll': setDiffTop(v => Math.min(Math.max(0, v + intent.delta), diffMax)); return
      case 'open-diff':
        setDraft(d => (d.startsWith('/') ? '' : d))
        if (!ask?.diff || ask.diff.files.length === 0) { say(false, t.sayNoDiff); return }
        setDiffTop(0)
        setDiffOpen(true)
        return
      case 'send': {
        if (!code || !sid) { say(false, t.sayNoSessionForCommand); return }
        const r = code.submit(sid, intent.text)
        if (!r.ok) { say(false, r.sentence); return }
        setDraft('')
        setScroll(FOLLOW)
        if (r.sentence) say(true, r.sentence)
        return
      }
      case 'answer': {
        if (!code || !sid || !ask) return
        const r = code.answer(sid, ask.id, intent.choice)
        say(r.ok, r.sentence)
        if (r.ok) setDiffOpen(false)
        return
      }
      case 'deny': {
        if (!code || !sid || !ask) return
        // `esc` is a DENY (D-TUI-7): the policy's own Deny option when it has one. Without one the
        // question is withdrawn by cancelling the run that asked it, which the policy also reads as a
        // denial — the contract has no separate dismiss call.
        const r = ask.denyIndex !== null ? code.answer(sid, ask.id, ask.denyIndex) : code.cancel(sid)
        say(r.ok, r.sentence)
        return
      }
      case 'cancel-run': {
        setDraft(d => (d.startsWith('/') ? '' : d))
        if (!code || !sid) { say(false, t.sayNoSessionForCommand); return }
        if (!running) { say(false, t.sayNothingRunning); return }
        const r = code.cancel(sid)
        say(r.ok, r.sentence)
        return
      }
    }
  }

  useInput((input, key) => {
    // `$EDITOR` holds the draft: what is typed now belongs to it, not to this screen.
    if (editingRef.current) return
    const hist = histRef.current
    if (hist) {
      const r = historyKey(hist, {
        input, return: key.return, escape: key.escape, backspace: key.backspace, delete: key.delete,
        ctrl: key.ctrl, meta: key.meta, tab: key.tab, upArrow: key.upArrow, downArrow: key.downArrow,
      })
      if (r.effect.kind === 'close') { setHist(null); return }
      if (r.effect.kind === 'use') {
        // CD-18: back in the composer to be edited — never sent from here.
        setHist(null)
        setDraft(r.effect.text)
        say(true, t.sayHistoryUsed)
        return
      }
      setHist(r.state)
      return
    }
    // Read the LATEST draft and wizard, never the render's closure: keys that arrive between two
    // renders (fast typing, key repeat, a slow terminal) were each computed against the same stale
    // value, and every one but the last was lost — measured by the e2e, where a typed prompt
    // arrived as its final letter only.
    const wizard = wizardRef.current
    const draft = draftRef.current
    if (wizard) {
      const r = wizardKey(wizard, {
        input,
        return: key.return,
        escape: key.escape,
        backspace: key.backspace,
        delete: key.delete,
        ctrl: key.ctrl,
        meta: key.meta,
        tab: key.tab,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
      })
      setWizard(r.state)
      performWizard(r.effect)
      return
    }
    // GL-03: the palette is the shell's; this tab holds the keyboard, so it hands `ctrl+p` over.
    if (key.ctrl && input === 'p' && onPalette) { onPalette(); return }
    const intent = codeKeyIntent({
      draft,
      sessionOpen,
      closed,
      ask,
      diffOpen: Boolean(diff),
      panelFull: layout.panel === 'full',
      running,
      popup: popupIndex,
      panelSide: side,
      panelVisible: panelOpen,
      help: Boolean(onHelp),
      reason,
    }, {
      input,
      return: key.return,
      escape: key.escape,
      backspace: key.backspace,
      delete: key.delete,
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift,
      tab: key.tab,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
    })
    // A command run from the composer (`/timeline` + enter) leaves the composer empty, whatever it
    // did — the typed `/word` was the request, not a draft.
    if (key.return && draft.startsWith('/') && intent.kind !== 'unknown-command' && intent.kind !== 'draft') setDraft('')
    perform(intent)
  }, { isActive: isActive && available })

  // ── the footer ───────────────────────────────────────────────────────────────────────────

  const hints = !available
    // Nothing to type, so nothing is captured: the shell's own keys work, and it is those that are named.
    ? [s.keyQuit, s.keyTabs]
    : editing
      ? [t.editorOpen]
      : hist
        ? [t.keyFilter, t.keyChoose, t.keyUse, t.keyClose]
        : wizard
          ? wizardHints(wizard, t)
          : codeHints({
            draft,
            sessionOpen,
            closed,
            ask,
            diffOpen: Boolean(diff),
            panelFull: layout.panel === 'full',
            running,
            popup: popupIndex,
            panelSide: side,
            panelVisible: panelOpen,
            help: Boolean(onHelp),
            reason,
            canScroll,
            narrow: layout.narrow,
            longOutput,
            panelOverflow,
          }, t)

  useEffect(() => {
    if (!isActive) return
    onChrome({ capture: available, hints })
  }, [isActive, available, hints.join('\u0000'), onChrome])

  // ── drawing ──────────────────────────────────────────────────────────────────────────────

  const headerRow = <Lines lines={[headerLine(shownFacts, t, width)]} rows={CODE_HEADER_ROWS} width={width} />

  const frame = (body: React.ReactNode) => (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} overflowY="hidden">
      {headerRow}
      {body}
    </Box>
  )

  if (!available) {
    const sentence = !code ? (gateSentence ?? t.unavailableBuild) : availability && !availability.ok ? availability.sentence : t.unavailableBuild
    const inner = paneBody(width)
    return frame(
      <Pane title={s.tabsShort.code} width={width} height={underHeader}>
        <Lines lines={wrapText(sentence, inner).map(l => [seg(l, { color: COLORS.muted })])} rows={paneRows(underHeader)} width={inner} />
      </Pane>,
    )
  }

  if (hist) {
    const inner = paneBody(width)
    const h = historyLines(hist, t, inner)
    const room = paneRows(underHeader)
    const headRows = Math.min(h.head.length, room)
    const footRows = Math.min(h.foot.length, Math.max(0, room - headRows - 1))
    const bodyRows = Math.max(0, room - headRows - footRows)
    const offset = h.selected === null ? 0 : windowOffset(h.selected, h.body.length, bodyRows)
    return frame(
      <Pane title={t.histTitle} badge="ctrl+r" focused width={width} height={underHeader}>
        <Lines lines={h.head} rows={headRows} width={inner} />
        <Lines lines={h.body.slice(offset)} rows={bodyRows} width={inner} />
        <Lines lines={h.foot} rows={footRows} width={inner} />
      </Pane>,
    )
  }

  if (wizard) {
    const inner = paneBody(width)
    const w = wizardLines(wizard, t, inner)
    const bodyRows = Math.max(0, paneRows(underHeader) - w.head.length)
    const offset = w.selected === null ? 0 : windowOffset(w.selected, w.body.length, bodyRows)
    return frame(
      <Pane title={t.wizardTitle} focused width={width} height={underHeader}>
        <Lines lines={w.head} rows={Math.min(w.head.length, paneRows(underHeader))} width={inner} />
        <Lines lines={w.body.slice(offset)} rows={bodyRows} width={inner} />
      </Pane>,
    )
  }

  if (diff && ask) {
    const inner = paneBody(width)
    const top = Math.min(diffTop, diffMax)
    return frame(
      <Pane title={t.fullDiffTitle(ask.toolName ?? ask.title)} badge={t.needsYou} focused width={width} height={underHeader}>
        <Lines lines={diff.head} rows={Math.min(diff.head.length, paneRows(underHeader))} width={inner} />
        <Lines lines={diff.body.slice(top)} rows={diffBodyRows} width={inner} />
        <Lines lines={[[]]} rows={Math.min(1, Math.max(0, paneRows(underHeader) - diff.head.length - diffBodyRows))} width={inner} />
        <Lines lines={diff.options} rows={Math.max(0, paneRows(underHeader) - diff.head.length - diffBodyRows - 1)} width={inner} />
      </Pane>,
    )
  }

  const panelPane = (w: number, h: number) => (
    <Pane title={panelTitle(side, t, w)} badge={facts?.shortId ?? ''} focused={layout.panel === 'full' || side !== 'session'} width={w} height={h}>
      <Lines lines={panelWindow(panelAll, panelRows, panelStart, t, panelInner, layout.panel === 'full')} rows={panelRows} width={panelInner} />
    </Pane>
  )

  if (layout.panel === 'full') return frame(panelPane(width, layout.bodyRows))

  const column = (
    <Box flexDirection="column" width={layout.mainWidth} height={layout.bodyRows} flexShrink={0} overflow="hidden">
      <Lines lines={convShown} rows={rows.conversation} width={layout.mainWidth} indent={1} />
      {hint ? <Lines lines={[hint]} rows={rows.hint} width={layout.mainWidth} indent={1} /> : null}
      {rows.popup > 0 && popupIndex !== null
        ? (
          <Pane title={t.popupTitle} width={layout.mainWidth} height={rows.popup}>
            <Lines lines={popupLines(matches, popupIndex, t, mainInner)} rows={paneRows(rows.popup)} width={mainInner} />
          </Pane>
        )
        : null}
      {ask && rows.card > 0
        ? (
          <Pane title={permissionTitle(ask, t)} badge={t.needsYou} focused width={layout.mainWidth} height={rows.card}>
            <Lines lines={permissionCardLines(ask, t, mainInner, paneRows(rows.card), mode)} rows={paneRows(rows.card)} width={mainInner} />
          </Pane>
        )
        : null}
      <Pane title={t.composerTitle} badge={facts ? modeWord(mode, t) : ''} focused={!ask} width={layout.mainWidth} height={rows.composer}>
        <Lines
          lines={[composerLine({ draft, ask, closed: view.closed, sessionOpen, busy: editing, reason }, t, mainInner)]}
          rows={paneRows(rows.composer)}
          width={mainInner}
        />
      </Pane>
    </Box>
  )

  return frame(
    <>
      {layout.statusRows > 0 ? <Lines lines={[narrowStatusLine(view, shownFacts, t, width)]} rows={layout.statusRows} width={width} /> : null}
      {layout.panel === 'side'
        ? (
          <Box flexDirection="row" height={layout.bodyRows} flexShrink={0}>
            {column}
            {panelPane(layout.panelWidth, layout.bodyRows)}
          </Box>
        )
        : column}
    </>,
  )
}
