/**
 * Code — the native session, in the terminal (the `code` tab; spec items CD-01…04, CD-07, CD-09,
 * CD-11, CD-12 P1, NW-01, NW-06, GL-05, GL-06).
 *
 * Everything that decides what a frame SAYS is in `../code.ts` and `../code-wizard.ts` (pure,
 * tested): the fold of the host's events, the layout, every line, what each key means and which keys
 * the footer names. This file holds React state, talks to `host.code`, and draws.
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
  type TailScroll,
} from '../code'
import {
  openWizard,
  taskCreated,
  wizardHints,
  wizardKey,
  wizardLines,
  type WizardEffect,
  type WizardState,
} from '../code-wizard'
import { codeStrings } from '../code-i18n'
import type { CodeEvent, CodeHost, CodeLaunch, CodeSessionFacts } from '../code-types'
import type { ControlStrings } from '../i18n'
import type { CliLang } from '../lang'
import type { ActionResult } from '../types'
import type { TabChrome } from '../ControlCenter'

export interface CodeProps {
  /** Absent: this build has no native runtime, and the tab says so in words. */
  code?: CodeHost
  /** How `agentop code …` opened the tab — acted on once, on the first mount. */
  launch?: CodeLaunch
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
function Lines({ lines, rows, width, indent = 0 }: { lines: Line[]; rows: number; width: number; indent?: number }) {
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

export function Code({ code, launch, lang, strings: s, width, height, isActive, onChrome, onSay, onTab }: CodeProps) {
  const t = codeStrings(lang)
  const availability = useMemo(() => (code ? code.availability() : null), [code])
  const available = Boolean(code && availability?.ok)

  const [facts, setFacts] = useState<CodeSessionFacts | null>(null)
  const [view, dispatch] = useReducer(viewReducer, EMPTY_VIEW)
  const [draft, setDraft, draftRef] = useLatestState('')
  const [popup, setPopup] = useState(0)
  const [wizard, setWizard, wizardRef] = useLatestState<WizardState | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffTop, setDiffTop] = useState(0)
  const [scroll, setScroll] = useState<TailScroll>(FOLLOW)
  // Two switches because the panel's default differs by layout: beside the conversation on a wide
  // terminal (so `ctrl+b` HIDES it), over it on a narrow one (so `ctrl+b` SHOWS it). One flag would
  // flip its meaning when the terminal is resized across the threshold.
  const [wideHidden, setWideHidden] = useState(false)
  const [narrowShown, setNarrowShown] = useState(false)

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

  const startWizard = useCallback((firstMessage?: string) => {
    if (!code) return
    setWizard(openWizard(firstMessage ?? ''))
    // Both reads start at once; each lands only on a wizard that is still open.
    void code.openTasks().then(r => setWizard(w => (w
      ? (r.ok ? { ...w, tasks: r.tasks, tasksError: null } : { ...w, tasksError: r.sentence })
      : w)))
    void code.defaults().then(d => setWizard(w => (w ? { ...w, defaults: d } : w)))
  }, [code])

  // `agentop code "…"` / `agentop code --resume <id>`: acted on ONCE, on the first mount. The host
  // clears the launch before a remount, and the ref makes a re-render harmless too.
  const launched = useRef(false)
  useEffect(() => {
    if (launched.current || !launch || !code || !available) return
    launched.current = true
    if (launch.resume) {
      void code.resume(launch.resume).then(r => {
        if (!r.ok) { say(false, r.sentence); return }
        if (launch.prompt?.trim()) pendingSend.current = launch.prompt.trim()
        openSession(r.facts)
        say(true, r.sentence)
      })
      return
    }
    startWizard(launch.prompt)
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
      case 'start':
        say(true, t.sayStarting)
        void code.start({
          taskId: effect.taskId,
          model: effect.model,
          cwd: effect.cwd,
          ...(effect.firstMessage ? { firstMessage: effect.firstMessage } : {}),
        }).then(r => {
          if (!r.ok) { say(false, r.sentence); setWizard(w => (w ? { ...w, busy: false } : w)); return }
          // NW-06: it lands on the new session — the host holds the first message until the
          // subscribe effect attaches, so nothing is sent unwatched.
          setWizard(null)
          openSession(r.facts)
          say(true, r.sentence)
        })
    }
  }, [code, say, t, openSession])

  // ── geometry and lines ───────────────────────────────────────────────────────────────────

  const narrowNow = width < 100
  const panelOpen = narrowNow ? narrowShown : !wideHidden
  const layout = codeLayout(width, height, { panelOpen })
  const ask = view.ask
  const closed = view.closed !== null
  const running = view.runId !== null
  const sessionOpen = facts !== null

  const mainInner = paneBody(layout.mainWidth)
  const convWidth = Math.max(1, layout.mainWidth - 2)
  const matches = ask ? [] : matchCommands(draft)
  const popupIndex = matches.length > 0 ? Math.min(popup, matches.length - 1) : null
  const hint = ask ? null : composerHint(draft, t, convWidth)
  const cardWant = ask ? permissionCardLines(ask, t, mainInner).length + 2 : 0
  const rows = columnRows(layout.bodyRows, {
    card: cardWant,
    popup: matches.length > 0 ? matches.length + 2 : 0,
    hint: hint ? 1 : 0,
  })

  const convAll: Line[] = facts
    ? conversationLines(view, facts, t, convWidth)
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

  // ── keys ─────────────────────────────────────────────────────────────────────────────────

  const perform = (intent: CodeIntent) => {
    const sid = facts?.sessionId
    switch (intent.kind) {
      case 'none': return
      case 'draft': setDraft(intent.draft); return
      case 'tab': onTab(intent.step); return
      case 'toggle-panel':
        if (narrowNow) setNarrowShown(v => !v)
        else setWideHidden(v => !v)
        return
      case 'scroll': setScroll(sc => scrollTail(convAll.length, rows.conversation, sc, intent.dir)); return
      case 'popup-move':
        setPopup(p => Math.min(Math.max(0, p + intent.delta), Math.max(0, matches.length - 1)))
        return
      case 'unknown-command': say(false, t.sayNoSuchCommand(intent.text)); setDraft(''); return
      case 'say': say(false, intent.code === 'no-diff' ? t.sayNoDiff : t.sayAnswerFirst); return
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
    perform(codeKeyIntent({
      draft,
      sessionOpen,
      closed,
      ask,
      diffOpen: Boolean(diff),
      panelFull: layout.panel === 'full',
      running,
      popup: popupIndex,
    }, {
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
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
    }))
  }, { isActive: isActive && available })

  // ── the footer ───────────────────────────────────────────────────────────────────────────

  const hints = !available
    // Nothing to type, so nothing is captured: the shell's own keys work, and it is those that are named.
    ? [s.keyQuit, s.keyTabs]
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
        canScroll,
        narrow: layout.narrow,
      }, t)

  useEffect(() => {
    if (!isActive) return
    onChrome({ capture: available, hints })
  }, [isActive, available, hints.join('\u0000'), onChrome])

  // ── drawing ──────────────────────────────────────────────────────────────────────────────

  const headerRow = <Lines lines={[headerLine(facts, t, width)]} rows={CODE_HEADER_ROWS} width={width} />

  const frame = (body: React.ReactNode) => (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} overflowY="hidden">
      {headerRow}
      {body}
    </Box>
  )

  if (!available) {
    const sentence = !code ? t.unavailableBuild : availability && !availability.ok ? availability.sentence : t.unavailableBuild
    const inner = paneBody(width)
    return frame(
      <Pane title={s.tabsShort.code} width={width} height={underHeader}>
        <Lines lines={wrapText(sentence, inner).map(l => [seg(l, { color: COLORS.muted })])} rows={paneRows(underHeader)} width={inner} />
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

  const panelPane = (w: number, h: number) => {
    const inner = paneBody(w)
    return (
      <Pane title={t.panelTitle} badge={facts?.shortId ?? ''} focused={layout.panel === 'full'} width={w} height={h}>
        <Lines lines={sessionPanelLines(view, facts, t, inner)} rows={paneRows(h)} width={inner} />
      </Pane>
    )
  }

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
            <Lines lines={permissionCardLines(ask, t, mainInner, paneRows(rows.card))} rows={paneRows(rows.card)} width={mainInner} />
          </Pane>
        )
        : null}
      <Pane title={t.composerTitle} badge={facts?.mode ?? ''} focused={!ask} width={layout.mainWidth} height={rows.composer}>
        <Lines
          lines={[composerLine({ draft, ask, closed: view.closed, sessionOpen }, t, mainInner)]}
          rows={paneRows(rows.composer)}
          width={mainInner}
        />
      </Pane>
    </Box>
  )

  return frame(
    <>
      {layout.statusRows > 0 ? <Lines lines={[narrowStatusLine(view, facts, t, width)]} rows={layout.statusRows} width={width} /> : null}
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
