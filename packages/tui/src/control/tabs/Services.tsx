/**
 * Services — the cockpit, and the default screen of the control center.
 *
 * The shape is lazygit's, for lazygit's reason: the data on this screen RELATES. The services list
 * is the selection and the detail pane is a view OF it, so moving the cursor repaints the pane —
 * every runtime the service could run under and the state of each, why one of them cannot be run
 * here at all, the pid and uptime of the one that is, the addresses it serves, and the machine
 * settings that bear on it.
 *
 * There is no log pane. Logs belong to the Logs screen: a tailing viewer squeezed into six rows was
 * a worse copy of a full screen one keypress away, and it was what pushed the pane this cockpit is
 * actually for into a column too narrow to state a URL. Taking it out is what let the detail pane
 * move under the band at the full width — see `cockpitLayout`.
 *
 * Three consequences worth stating, because they are behaviour changes rather than cosmetics:
 *
 *  - Actions are FOCUS-SCOPED. With a service selected the verbs act on that service, which is why
 *    the old "Stop which? / Restart which?" submenus are gone — you are already standing on the
 *    target. Their `Everything` option survives as an explicit `Stop all` / `Restart all`, offered
 *    only when more than one service is running, because that is the one case where the submenu
 *    said something the selection cannot.
 *  - The list is one row per LOGICAL service, and what a row can DO follows from its state rather
 *    than from a branch here: a running service's verbs are restart / stop / open and there is no
 *    start among them, because the host offers `startOptions` only while nothing is up. That is the
 *    whole answer to "it offered to start a docker copy while one was already running" — the offer
 *    is unreachable, not refused after the fact. A stopped service keeps its row, dimmed, and its
 *    action row becomes exactly the starts this box can perform.
 *  - With the config pane focused the verbs are the config ones: connect / disconnect, change how
 *    history is preserved, switch language.
 *
 * Everything else is preserved to the letter — the archive gate before a foreground and a
 * background start (skipped for docker, never re-asked), the port-collision question, the
 * confirmed disconnect, the boot offer after a background start and after a central came up, and
 * the foreground handover through `onExit({ kind: 'foreground' })`. Nothing here decides what an
 * action DOES: every choice becomes one `host` call.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { truncate } from '../../components/Primitives'
import { COLORS } from '../../theme'
import { ActionRow, ConfigLine, CONFLICT_GLYPH, PaneStrip, ServiceLine, STATE_GLYPH, stateWord } from '../Chrome'
import { Question, questionRows, SectionHeader } from '../Surface'
// The same position label the log viewer wears, from the same pure helper: two screens showing a
// window into a longer list must not describe it differently.
import { windowLabel } from '../surface.ts'
import { Pane, paneBody, paneRows } from '../Pane'
import {
  actionAtColumn,
  cockpitHints,
  cockpitLayout,
  cockpitRects,
  configCells,
  detailContent,
  detailPlan,
  fitActionRow,
  fitDetailLines,
  fitValue,
  narrowTerminal,
  serviceCells,
  SERVICE_MARKER,
  stripScheme,
  type CockpitContent,
  type DetailContent,
  type DetailTone,
} from '../chrome.ts'
import { listRowAt, paneHit, paneOrigin, rectHit, type Rect } from '../hit'
import { isActivation, wheelDelta } from '../mouse'
import { usePointer } from '../pointer'
import {
  clampFocus,
  resolveListKey,
  resolveOutputKey,
  resolveServicesKey,
  scrollBy,
  scrollTailBy,
  windowOffset,
  type NavKey,
  type PaneId,
  type TailState,
} from '../nav'
import { Menu } from '../Menu'
import { OutputView } from '../Output'
import { ArchiveChoice } from '../ArchiveChoice'
import { archiveGateOnOpen } from '../archive-gate'
import { nextSessionPollMs } from '../session-poll'
import { ConfirmPrompt, TextPrompt } from '../Prompt'
import type { ControlStrings } from '../i18n'
import type { CliLang } from '../lang'
import type {
  ActionTarget,
  ArchiveMode,
  BootOption,
  ControlExit,
  ControlHost,
  ControlService,
  ControlStatus,
  RestartOption,
  RuntimeId,
  ServiceId,
  StartOption,
  TeamMode,
} from '../types'
import type { RunAction, TabChrome, TaskView } from '../ControlCenter'

/**
 * The words the Services and Setup screens need that `control/i18n.ts` does not carry.
 *
 * They belong to choices the TUI INVENTS rather than to anything the host reports — the three
 * connect questions — and the host hands the TUI a `ControlStatus`, not a string table, so they
 * have to live on this side of the boundary. The "how should it run?" menu that used to live here
 * went with the flat service list: the host composes and LABELS its own start options now, because it
 * is the only side that knows what this box can actually run.
 *
 * Exported because Setup asks the same three connect questions in the same order.
 */
export interface LauncherStrings {
  itemConnect: string
  itemConnectHint: string
  itemDisconnect: string
  itemDisconnectHint: string

  promptEndpoint: string
  promptToken: string
  promptOrg: string
  orgDefault: string
}

const LAUNCHER_EN: LauncherStrings = {
  itemConnect: 'Connect to a central',
  itemConnectHint: 'send my metrics (become a member)',
  itemDisconnect: 'Disconnect from the central',
  itemDisconnectHint: 'back to solo',

  promptEndpoint: 'Central endpoint URL (e.g. http://host:48080)',
  promptToken: "Member token (from the central's Team Manager)",
  promptOrg: 'Org',
  orgDefault: 'default',
}

const LAUNCHER_PT: LauncherStrings = {
  itemConnect: 'Conectar a uma central',
  itemConnectHint: 'enviar minhas métricas (virar member)',
  itemDisconnect: 'Desconectar da central',
  itemDisconnectHint: 'voltar para solo',

  promptEndpoint: 'URL da central (ex.: http://host:48080)',
  promptToken: 'Token do member (no Team Manager da central)',
  promptOrg: 'Org',
  orgDefault: 'default',
}

const LAUNCHER: Record<CliLang, LauncherStrings> = { en: LAUNCHER_EN, pt: LAUNCHER_PT }

export function launcherStrings(lang: CliLang): LauncherStrings {
  return LAUNCHER[lang] ?? LAUNCHER_EN
}

/** The connect questions, in the order `cli-start.ts` and `cli-setup.ts` both ask them. */
export type ConnectStep = 'endpoint' | 'token' | 'org'

/**
 * THE OVERLAY SEAM.
 *
 * `cockpit` is the three panes; every other variant is a question, and while one is up it OWNS the
 * detail region (or, when the layout has stacked, the whole body) and the keyboard. The cockpit
 * itself never renders a question inline: the flow is a state machine here, and the drawing of each
 * step is one `Menu` / `Prompt` / `ArchiveChoice` handed to `overlayFor` below.
 *
 * That function is the seam. It is the only place that maps a `View` to something drawn, it returns
 * `{ title, node }` and nothing else, and every step's outcome comes back through the callbacks
 * defined in this file — so the overlay components can be redesigned, reframed or replaced whole
 * without touching the layout, the focus model or a single host call.
 */
type View =
  | { kind: 'cockpit' }
  /** A server already holds the port — stop it and take over, or leave it alone. */
  | { kind: 'kill'; option: StartOption }
  /** `then` is why it was asked: the gate in front of a detached start still has a server to
   *  start afterwards, while the config row was only ever changing a setting. */
  /** `gate` marks the one nobody asked for: the question raised on OPEN, because a machine enabled
   *  at boot never crosses the start path that used to be the only place it was asked. Only that
   *  one may be skipped — see `archive-gate.ts`. */
  /** `thenBoot` is the wizard's tail: after the consent, member and central offer the boot unit. */
  | { kind: 'archive'; suggested: ArchiveMode; then: StartOption | null; gate?: boolean; thenBoot?: ServiceId }
  | { kind: 'connect'; step: ConnectStep; endpoint: string; token: string }
  | { kind: 'disconnect' }
  /** `runtime` is the one that just started, when this came from a fresh start's boot question —
   *  `enableBoot` needs it to write the matching unit. Absent for the manual "enable boot" action
   *  row (offered while the service is down, with nothing running yet to name). */
  | { kind: 'boot'; service: ServiceId; runtime?: RuntimeId }
  /**
   * A boot registration being turned ON or OFF from the action row, or the question raised right
   * after a stop that worked.
   *
   * It carries the host's own `BootOption` rather than a service and a direction, because the
   * SENTENCE is what makes this safe: it names the unit, and writing or removing a systemd user
   * unit is a change to the machine that outlives this session. A generic "are you sure?" over a
   * verb called "boot" would be the same prompt for two opposite acts.
   */
  | { kind: 'bootSwitch'; service: ServiceId; option: BootOption; afterStop?: boolean }
  /**
   * THE WIZARD — solo / central / member, the whole of what the Setup tab used to be.
   *
   * A question here rather than a screen of its own because it is a question ABOUT these services:
   * you cannot re-run `central.sh init` on a central that is up, and the only way to know that is to
   * be looking at whether it is up. The host says which modes are withheld and WHY
   * (`ControlStatus.setupBlocked`); this file draws the menu and routes each answer into the flow
   * that already existed here — the three connect prompts, the archive consent, the boot offer.
   */
  | { kind: 'setup' }

/**
 * What the detail region is showing instead of the facts: a question, or a task's output.
 *
 * One shape for both, because the seam treats them the same — a title for the frame, an optional
 * badge, and a node for the inside. The badge exists for the output pane, which has a scroll
 * position and a follow state to state; the questions leave it empty.
 */
interface Overlay {
  title: string
  badge?: string
  node: React.ReactNode
}

/** One verb on the detail pane's action row, or on a config row. */
interface Action {
  label: string
  run: () => void
}

/**
 * A config row: what it states, and what `enter` does to it.
 *
 * `short` is the value's other TRUE form — the mode token behind its sentence, the endpoint behind
 * its scheme — and it is what the column is budgeted against, because the long form is only ever
 * shown when it happens to fit whole (see `fitValue`).
 */
interface ConfigRow {
  key: string
  label: string
  value: string
  short: string
  action?: Action
}

/**
 * How often the clock ticks.
 *
 * Nothing is fetched on this interval — the uptime in the detail pane is computed from a stored
 * INSTANT, so without a tick it would sit frozen at whatever it read when the screen was drawn
 * while the clock beside it kept moving.
 */
const CLOCK_MS = 1000

export interface ServicesProps {
  host: ControlHost
  status: ControlStatus | null
  strings: ControlStrings
  lang: CliLang
  width: number
  height: number
  isActive: boolean
  /** The shell's funnel. The second argument is the VERB, which becomes the output pane's title. */
  run: RunAction
  /**
   * What the last action said, streamed in while it ran, or `null` once it has been dismissed.
   *
   * The cockpit draws it into the DETAIL region — the big pane under the band — because that is
   * where the eye already is: the region is a view OF what you acted on, and while a task is running
   * what it is saying IS that view. The services list and the config pane stay standing beside it,
   * so it is never a mystery which service the output belongs to.
   */
  task: TaskView | null
  onDismissTask: () => void
  onChrome: (chrome: TabChrome) => void
  onExit: (exit: ControlExit) => void
  onLang: (lang: CliLang) => void
  /** Whether the terminal is reporting the mouse — the config row states it. */
  mouseOn?: boolean
  /** Absent when there is no mouse at all, and then the config pane has no row for one. */
  onMouse?: () => void
  /** How often the cockpit re-reads the fleet, in milliseconds — the config row states it. */
  sessionPollMs: number
  /** Cycles to the next preset in `SESSION_POLL_PRESETS_MS` — see the config row's action. */
  onSessionPollMs: (ms: number) => void
  /**
   * Open with the wizard already asking — a machine that has never been configured.
   *
   * This is what "bare `agentop` opens on Setup" became when Setup stopped being a tab. It is read
   * ONCE, as the initial state, rather than watched: a prop that re-opened the question on every
   * render would put it back in front of someone who had just answered it.
   */
  initialSetup?: boolean
}

export function Services({
  host, status, strings: s, lang, width, height, isActive, run, task, onDismissTask,
  onChrome, onExit, onLang, mouseOn, onMouse, sessionPollMs, onSessionPollMs, initialSetup,
}: ServicesProps) {
  const l = launcherStrings(lang)

  const [view, setView] = useState<View>(initialSetup ? { kind: 'setup' } : { kind: 'cockpit' })
  const [wantFocus, setWantFocus] = useState<PaneId>('services')
  const [serviceIndex, setServiceIndex] = useState(0)
  const [configIndex, setConfigIndex] = useState(0)
  const [actionIndex, setActionIndex] = useState(0)

  /** Re-read on every tick so the uptime moves with the clock rather than with `refresh()`. */
  const [now, setNow] = useState(() => Date.now())

  /**
   * The output pane's viewport, in the same shape the Logs screen uses.
   *
   * `follow` pinned is the normal state and the reason the pane is worth watching: the newest line is
   * what a build is DOING. Any scroll unpins it — a reader who went back and is yanked to the tail a
   * second later has been shown that this pane cannot be read — and `f` pins it again.
   */
  const [outputView, setOutputView] = useState<TailState>({ index: 0, follow: true })

  /**
   * A task owns the detail region as soon as it has said something.
   *
   * On the FIRST LINE rather than on the action, so the pane belongs to the commands whose output is
   * the point: a stop says one sentence through the status line and never takes the region, while a
   * `docker compose up --build` fills it for as long as it runs. Once it is finished the pane stays,
   * with its outcome in the status line under it, until `esc` puts the facts back.
   */
  const taskLines = task?.lines ?? []
  const taskOpen = taskLines.length > 0

  // A new task starts at the tail — its own tail, not the previous one's.
  useEffect(() => { setOutputView({ index: 0, follow: true }) }, [task?.id])

  const services = status?.services ?? []
  const running = useMemo(() => services.filter(v => v.state === 'up'), [services])
  const selection = Math.min(serviceIndex, Math.max(0, services.length - 1))
  const selected: ControlService | undefined = services[selection]
  /**
   * The selection is running twice — the same program under two runtimes, on one port.
   *
   * It is what turns the plain `Stop` into the per-runtime stops, and it is also why `s` and `R`
   * stand down: "stop it" and "restart it" have no single meaning here, and restarting BOTH copies
   * would leave the conflict exactly where it was.
   */
  const conflicted = Boolean(selected?.conflict)

  const back = useCallback(() => setView({ kind: 'cockpit' }), [])

  /**
   * The history question, asked on OPEN when it has never been answered.
   *
   * `pendingArchiveMode()` is the host's record, so a machine whose owner already chose is never
   * asked again — including across restarts, which is the whole point. The ref is the second half of
   * `archiveGateOnOpen`: a skip has to hold for the rest of this run, or declining would re-open the
   * question on the next repaint and the skip would be a lie.
   *
   * It runs once, on mount, and only ever REPLACES the cockpit — never a question already up.
   */
  const archiveAsked = useRef(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      const pending = await host.pendingArchiveMode().catch(() => null)
      const gate = archiveGateOnOpen(pending, archiveAsked.current)
      if (!alive || !gate.ask) return
      archiveAsked.current = true
      setView(v => (v.kind === 'cockpit' ? { kind: 'archive', suggested: gate.suggested, then: null, gate: true } : v))
    })()
    return () => { alive = false }
  }, [host])

  // -------------------------------------------------------------------------
  // actions — every one of them a single host call, none of them decided here
  // -------------------------------------------------------------------------

  /**
   * Perform a start the host offered, and — when it worked — ask whether it should be permanent.
   *
   * The option is handed straight back to `host.start()`: it was composed there, so nothing on this
   * side decides what a start MEANS — including which starts are worth a boot unit, which is
   * `option.offersBoot`. This file used to answer that with `runtime !== 'machine'`, a rule about
   * how Docker restarts containers, held in the layer that draws boxes.
   */
  const startNow = useCallback((option: StartOption) => {
    // Back to the panes BEFORE the start runs, not after it resolves. A container start is a build:
    // it can take minutes, and leaving the question that led to it on screen for the duration would
    // both hide the output streaming into the detail region and leave a menu that answers keys.
    setView({ kind: 'cockpit' })
    void run(() => host.start(option), option.label).then(res => {
      setView(res.ok && option.offersBoot
        // The runtime travels with the question: `enableBoot` needs it to pick the matching
        // mechanism (a native systemd unit versus one that runs `docker compose … up -d`), and
        // this is the one place that actually knows which one just started.
        ? { kind: 'boot', service: option.runtime === 'central' ? 'central' : 'agentistics', runtime: option.runtime }
        : { kind: 'cockpit' })
    })
  }, [host, run])

  /**
   * The consent gate in front of a background start.
   *
   * `runStart()` has always asked it before starting a server, and a detached one is the path where
   * it matters most: nothing later in the session will ask, so a machine started this way would run
   * for weeks preserving nothing while the user believes they were never asked.
   */
  /**
   * The consent gate at the END of the wizard — `ensureArchiveModeChosen()`'s rule, enforced by the
   * host: `pendingArchiveMode()` answers `null` when there is nothing left to ask, and we move
   * straight on rather than putting the same question in front of someone who already answered it.
   *
   * `thenBoot` is what follows it, when there is one: the wizard's last step offers to bring the
   * machine back on boot. Carried through the view rather than held in a ref, so a question the user
   * escapes out of takes its tail with it.
   */
  const askArchive = useCallback(async (thenBoot?: ServiceId) => {
    const pending = await host.pendingArchiveMode().catch(() => null)
    if (pending === null) {
      return setView(thenBoot ? { kind: 'boot', service: thenBoot } : { kind: 'cockpit' })
    }
    setView({ kind: 'archive', suggested: pending, then: null, thenBoot })
  }, [host])

  const archiveThen = useCallback(async (option: StartOption) => {
    if (!option.asksArchive) return startNow(option)
    const pending = await host.pendingArchiveMode().catch(() => null)
    if (pending === null) return startNow(option)
    setView({ kind: 'archive', suggested: pending, then: option })
  }, [host, startNow])

  /**
   * One start option, taken.
   *
   * What has to happen first is read OFF the option — `blockedBy` names the runtime it would
   * collide with, `asksArchive` says the consent gate applies. Both used to be inferred here from
   * `option.runtime !== 'local'`, which is the host's model restated in the presentation layer and
   * would have been wrong the day a second runtime took a port.
   */
  const onStart = useCallback((option: StartOption) => {
    // Only `local` foreground needs to leave the app: it is about to become THIS process's own
    // foreground job, which can only happen once we have unmounted and left the alternate screen
    // — the same `'foreground'` sentinel `runStart()` has always returned, after which the host
    // starts the in-process server. A Docker (or native-central) foreground start is a plain CHILD
    // this process can still supervise: `host.start()` runs it under `suspend()`, which hands the
    // real tty to that child and returns control to the cockpit the moment it exits (Ctrl-C). It
    // never needs — and must never trigger — the exit that would otherwise start the wrong thing
    // (the native local server) in its place.
    if (option.how === 'fg' && option.runtime === 'local') {
      return onExit({ kind: 'foreground' })
    }
    const blocker = option.blockedBy
    if (!blocker) return void archiveThen(option)

    // A port collision is a question, not a refusal — the same one the foreground path asks, and
    // the same one the old launcher asked before every detached start. Answering no leaves the
    // running server exactly where it is.
    //
    // Detected HERE rather than read off the panel. A start is only offered for a service the panel
    // believes is DOWN, so the panel's own answer is always "no collision" by construction — which
    // is how this question became unreachable in the first place. The panel is as old as the last
    // `r`, and a server that came up since is precisely the case worth asking about.
    return void host.refresh()
      .then(fresh => fresh.services.some(v => v.running.includes(blocker)))
      .catch(() => services.some(v => v.running.includes(blocker)))
      .then(occupied => {
        if (occupied) setView({ kind: 'kill', option })
        else void archiveThen(option)
      })
  }, [host, onExit, archiveThen, services])

  const target = useCallback((id: ActionTarget, action: 'stop' | 'restart', label: string) => {
    void run(() => (action === 'stop' ? host.stop(id) : host.restart(id)), label).then(back)
  }, [host, run, back])

  /**
   * Stopping a WHOLE service — and, when it worked, asking about the boot registration.
   *
   * The moment of the stop is the only moment the person knows the answer. Someone stopping their
   * central because they are finished with it wants it to stay stopped; someone stopping it to
   * restart it does not — and nothing on this screen can tell those two apart, which is exactly why
   * it is a question rather than a rule. Asked ONLY when there is something to turn off: a service
   * with no registration, or on a box with no user systemd, has no such option and is never asked.
   *
   * The option is read from the snapshot taken BEFORE the stop, deliberately. A boot registration is
   * not affected by stopping anything, so the pre-stop answer is the post-stop answer, and reading
   * it back off a refresh would make the question depend on a poll landing in time.
   */
  const stopService = useCallback((service: ControlService, label: string) => {
    const off = service.bootOptions.find(o => !o.enable)
    void run(() => host.stop(service.id), label).then(res => {
      setView(res.ok && off
        ? { kind: 'bootSwitch', service: service.id, option: off, afterStop: true }
        : { kind: 'cockpit' })
    })
  }, [host, run])

  /**
   * One restart the host offered, taken.
   *
   * The option goes straight back to `host.restart()` — the target it names and its rebuild flag
   * were both composed there, so nothing on this side decides what a rebuild MEANS or whether one is
   * possible here. That is the same contract `startNow` has with `StartOption`, and it is why the
   * screen no longer has a `Restart` verb of its own to label.
   */
  const restartNow = useCallback((option: RestartOption) => {
    void run(() => host.restart(option.target, option.rebuild), option.label).then(back)
  }, [host, run, back])

  const open = useCallback((url: string) => {
    const openUrl = host.openUrl
    if (!openUrl) return
    void run(() => openUrl.call(host, url), s.actOpen).then(back)
  }, [host, run, back, s.actOpen])

  /**
   * What a DOUBLE click on a service row does.
   *
   * The obvious thing, and only the obvious thing: look at it when it is up, start it when it is
   * not. Deliberately never the FOREGROUND start — that one quits the control center and hands this
   * terminal to the server, which is not something a second click should be able to do by accident.
   * A service with nothing to offer does nothing, silently.
   */
  const runDefault = useCallback((service: ControlService) => {
    const url = service.active?.webUrl
    if (service.state === 'up') {
      if (host.openUrl && url) open(url)
      return
    }
    const option = service.startOptions.find(o => o.how !== 'fg')
    if (option) onStart(option)
  }, [host, open, onStart])

  /**
   * The verbs for the selected service — derived from its state, never branched on its id.
   *
   * Up: the restarts, stop, open. There is no start among them and no rule here saying so; the host
   * hands over an empty `startOptions` while anything is running, so the offer that produced the
   * complaint cannot be drawn at all. Down: exactly the starts this box can perform, each one
   * already labelled by the host, plus the boot unit for the machines that should come back by
   * themselves.
   *
   * The RESTARTS are a list for the same reason the starts are: a plain bounce and a rebuild are
   * different amounts of work, and whether a rebuild can happen here at all — a repo checkout for
   * the native binary, a compose file for the container — is a fact about this box that the host is
   * the only side able to state.
   *
   * In a CONFLICT the plain `Stop` is replaced by the per-runtime stops, because "stop it" has no
   * single meaning when the same program is running twice — naming one is the only stop that
   * resolves anything.
   */
  const actions = useMemo<Action[]>(() => {
    if (!selected) return []
    const out: Action[] = []

    if (selected.state === 'up') {
      for (const option of selected.restartOptions) {
        out.push({ label: option.label, run: () => restartNow(option) })
      }
      if (selected.stopOptions.length > 0) {
        for (const option of selected.stopOptions) {
          out.push({ label: option.label, run: () => target(option.runtime, 'stop', option.label) })
        }
      } else {
        out.push({ label: s.actStop, run: () => stopService(selected, s.actStop) })
      }
      // Extra copies holding no port: the sentence names them, this verb removes them — never a
      // `kill` the person has to type (2026-10-04).
      if (selected.idle && selected.idleStopLabel && host.stopIdle) {
        const stopIdle = host.stopIdle.bind(host)
        const label = selected.idleStopLabel
        const id = selected.id
        out.push({ label, run: () => { void run(() => stopIdle(id), label).then(back) } })
      }
      const url = selected.active?.webUrl
      if (host.openUrl && url) out.push({ label: s.actOpen, run: () => open(url) })
    } else {
      for (const option of selected.startOptions) {
        out.push({ label: option.label, run: () => onStart(option) })
      }
    }

    /**
     * The BOOT switch — both positions, and offered whatever the service's state.
     *
     * It used to be one verb (`Start at boot`) offered only beside a start, which made it a switch
     * with a single position: the unit it wrote could be turned off by nothing in this product. A
     * user who stopped their central because they were done with it got it back on the next boot —
     * and on the next login that starts the user's systemd manager — with nothing on screen naming
     * what had brought it back or offering to stop it. That is the whole complaint.
     *
     * The host composes these: which mechanisms exist is a fact about this box (`agentistics` has
     * two, the central has one), and a box with no user systemd gets an EMPTY list rather than a
     * verb that refuses on principle. Placed AFTER the state verbs because `fitActionRow` drops
     * from the right and stopping a service outranks scheduling one.
     */
    for (const option of selected.bootOptions) {
      out.push({ label: option.label, run: () => setView({ kind: 'bootSwitch', service: selected.id, option }) })
    }

    // The submenu's `Everything`, kept as an explicit verb. Only worth offering when there is more
    // than one thing to stop — with a single service up it is the same command under a bigger name.
    if (running.length > 1) {
      out.push({ label: s.actStopAll, run: () => target('all', 'stop', s.actStopAll) })
      out.push({ label: s.actRestartAll, run: () => target('all', 'restart', s.actRestartAll) })
    }

    // The update, where the update dot already is. The header has been able to say a newer version
    // EXISTS for a long time while the only way to take it was to quit, remember the command and
    // type it — so the notice pointed at work the user had to do by hand. `agentop upgrade`
    // already installs and then restarts the active systemd services, the central's containers and
    // a machine container; this is that same command, one keypress from the dot. Offered LAST
    // because it acts on the whole install rather than on the selected service, and only while
    // there is genuinely something to install.
    if (status?.latestVersion) {
      out.push({ label: s.actUpgrade(status.latestVersion), run: () => void run(() => host.upgrade(), s.actUpgrade(status.latestVersion!)) })
    }
    return out
  }, [selected, s, host, running.length, target, stopService, restartNow, open, onStart, status?.latestVersion, run])

  // -------------------------------------------------------------------------
  // the config pane
  // -------------------------------------------------------------------------

  const connectAction = useMemo<Action>(() => (
    status?.mode === 'member'
      ? { label: s.actDisconnect, run: () => setView({ kind: 'disconnect' }) }
      : { label: s.actConnect, run: () => setView({ kind: 'connect', step: 'endpoint', endpoint: '', token: '' }) }
  ), [status?.mode, s])

  const configRows = useMemo<ConfigRow[]>(() => {
    const rows: ConfigRow[] = [
      // The short token is the fallback and the sentence is the preference: `fitValue` shows
      // whichever the column can hold whole, because "member — sen…" answers nothing.
      {
        key: 'mode',
        label: s.modeLabel,
        value: status?.modeLabel ?? status?.mode ?? '—',
        // "member — sends metrics to a central" degrades to "member", never to "member — sen…".
        short: status?.mode ?? '—',
        // THE SETUP TAB'S DOOR. The mode row is what the wizard changes, so the wizard is what
        // `enter` on it opens — the three modes, with whichever the host has withheld greyed and
        // explained. `Connect` used to live here and is now what the `member` item does, which is
        // the same three prompts in the same order: one implementation, one entrance.
        action: { label: s.actSetup, run: () => setView({ kind: 'setup' }) },
      },
    ]
    if (status?.endpoint) {
      // The endpoint IS the connection, so `enter` on it opens the same question the mode row does.
      // A row the cursor can land on that then does nothing is worse than one that does the
      // obvious thing.
      rows.push({
        key: 'endpoint',
        label: s.endpointLabel,
        value: status.endpoint,
        short: stripScheme(status.endpoint),
        action: connectAction,
      })
    }
    rows.push({
      key: 'history',
      label: s.historyLabel,
      value: status?.archiveMode ?? s.archiveUnset,
      short: status?.archiveMode ?? s.archiveUnset,
      // Deliberately NOT `pendingArchiveMode()`: that answers `null` once the question has been
      // settled, which is the right rule for the automatic gate and the wrong one for a user who
      // has just asked to change the setting.
      action: {
        label: s.actHistory,
        // `then: null` — this row was only ever changing a setting; nothing is waiting to start.
        run: () => setView({ kind: 'archive', suggested: status?.archiveMode ?? 'consolidate', then: null }),
      },
    })
    rows.push({
      key: 'language',
      label: s.languageLabel,
      value: s.languageValue,
      short: s.languageValue,
      action: { label: s.actLanguage, run: () => onLang(lang === 'en' ? 'pt' : 'en') },
    })
    // Only when there IS a mouse. A row offering to switch off a device that cannot report is the
    // same lie as a footer hint for a key that does nothing — and the `m` key is gone with it.
    if (onMouse) {
      rows.push({
        key: 'mouse',
        label: s.mouseLabel,
        // A WORD, not a colour and not a glyph: the row has to answer "is the mouse on" for a
        // reader who is asking because their text selection stopped working.
        value: mouseOn ? s.mouseOn : s.mouseOff,
        short: mouseOn ? s.mouseOn : s.mouseOff,
        action: { label: s.actMouse, run: onMouse },
      })
    }
    rows.push({
      key: 'sessionPoll',
      label: s.sessionPollLabel,
      value: `${sessionPollMs / 1000}s`,
      short: `${sessionPollMs / 1000}s`,
      action: { label: s.actSessionPoll, run: () => onSessionPollMs(nextSessionPollMs(sessionPollMs)) },
    })
    return rows
  }, [s, status, connectAction, onLang, lang, mouseOn, onMouse, sessionPollMs, onSessionPollMs])

  const configSelection = Math.min(configIndex, Math.max(0, configRows.length - 1))

  // -------------------------------------------------------------------------
  // geometry — measured from the rows about to be drawn, never guessed
  // -------------------------------------------------------------------------

  /**
   * One drawable row per logical service.
   *
   * The RUNTIME cell names what the service is actually running under — both of them, joined, when
   * it is running twice. A stopped service names none, because there is nothing it is running as;
   * the cell is empty rather than guessing at the runtime it would use if it were started.
   */
  const serviceLabels = useMemo(() => services.map(v => ({
    label: v.label,
    runtime: v.runtimes.filter(r => v.running.includes(r.id)).map(r => r.kind).join('+'),
    state: v.conflict
      ? `${CONFLICT_GLYPH} ${s.stateConflict}`
      : `${STATE_GLYPH[v.state]} ${stateWord(v.state, s)}`,
  })), [services, s])

  /**
   * The facts the MACHINE contributes to whichever service is selected.
   *
   * Composed here rather than inside `detailContent` because they come off the `ControlStatus`
   * rather than off the service, and they are already localized by the host. Both are shown for
   * every service without branching on an id: how history is preserved and which central this box
   * pushes to are facts about the box, and the box is what every service on this screen runs on.
   */
  const machine = useMemo(() => ({
    rows: [
      { label: s.historyLabel, value: status?.archiveMode ?? s.archiveUnset },
      ...(status?.endpoint ? [{ label: s.endpointLabel, value: status.endpoint }] : []),
    ],
  }), [s, status?.archiveMode, status?.endpoint])

  const detail = useMemo(
    () => (selected ? detailContent(selected, s, now, machine) : null),
    [selected, s, now, machine],
  )

  const configLabelWidth = useMemo(
    () => configRows.reduce((n, r) => Math.max(n, r.label.length), 0),
    [configRows],
  )

  const content: CockpitContent = useMemo(() => {
    // The glyph, not the state word, and the SHORT config value: both of those are what the row
    // keeps when the column is tight, and budgeting the ideal against the bonus form is what used
    // to push the left column out to 40% of the terminal on every screen.
    const widest = (pick: (r: (typeof serviceLabels)[number]) => string) =>
      serviceLabels.reduce((n, r) => Math.max(n, pick(r).length), 0)
    // Per COLUMN, not per row: `serviceCells` aligns the runtime and state cells across the whole
    // list, so a budget taken from the widest single ROW is short by however much the longest name
    // and the longest runtime differ — which is exactly enough to drop the runtime cell off a list
    // whose two entries are `agentistics` and `agentistics central`.
    const servicesWidth =
      SERVICE_MARKER + widest(r => r.label) + 1 + widest(r => r.runtime) + 1 + widest(r => r.state)
    const configWidth = configRows.reduce(
      (n, r) => Math.max(n, SERVICE_MARKER + configLabelWidth + 1 + r.short.length),
      0,
    )
    return {
      services: servicesWidth,
      config: configWidth,
      serviceRows: Math.max(1, services.length),
      configRows: configRows.length,
      // Every fact line plus a blank and the action row, counted only where each exists — and never
      // fewer than one, or a service with nothing to say would ask for a two-row pane, which is one
      // row below what can be framed and would render as a frameless hole.
      detailRows: Math.max(1, (detail?.lines.length ?? 0) + (actions.length > 0 ? 2 : 0)),
    }
  }, [serviceLabels, configRows, configLabelWidth, actions.length, detail, services.length])

  // A question — or a task's output — owns the detail region, which is everything under the band, so
  // the band gives up rows to it only when the body is too short to hold both. It used to be handed
  // the whole body, which left the config pane a fourteen-row frame around three facts.
  /**
   * A NARROW terminal shows ONE pane at a time (D-TUI-10), and the pane shown IS the focused one:
   * `tab` walks services → config → detail, and the strip above names all three. Every pane exists
   * there — the detail included, even for a service with no verbs, since it is the only place the
   * runtimes and addresses are stated — so the pane list does not depend on the heights.
   */
  const narrow = narrowTerminal(width)
  const narrowPanes: PaneId[] = ['services', 'config', 'actions']
  const narrowFocus = clampFocus(wantFocus, narrowPanes)

  const layout = useMemo(
    () => cockpitLayout(width, height, content, {
      question: view.kind !== 'cockpit' || taskOpen,
      ...(narrow ? { single: narrowFocus === 'actions' ? 'detail' as const : narrowFocus } : {}),
    }),
    [width, height, content, view.kind, taskOpen, narrow, narrowFocus],
  )
  const { heights } = layout

  /**
   * Which panes are actually on screen — the input to every focus decision.
   *
   * Focus that lands on a pane the layout dropped is a cursor the user cannot find and keys that
   * appear to do nothing, so the reducers are told what exists rather than assuming the full set.
   */
  const panes = useMemo<PaneId[]>(() => {
    if (narrow) return narrowPanes
    const out: PaneId[] = ['services']
    if (heights.config > 0) out.push('config')
    if (heights.detail > 0 && actions.length > 0) out.push('actions')
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, heights.config, heights.detail, actions.length])

  // Derived rather than corrected in an effect: a resize that drops a pane must not leave one
  // render where focus points at nothing.
  const focus = clampFocus(wantFocus, panes)

  const servicesBody = paneRows(heights.services)
  const serviceOffset = windowOffset(selection, services.length, servicesBody)
  // The config pane scrolls for the same reason the services pane does, and it is the more
  // dangerous of the two to get wrong: on a short terminal the pane draws one or two of its four
  // rows, and a cursor allowed to sit below the fold is invisible while `enter` still runs whatever
  // it is standing on. It cost a language switch nobody asked for before this window existed.
  const configBody = paneRows(heights.config)
  const configOffset = windowOffset(configSelection, configRows.length, configBody)
  const cells = useMemo(
    () => serviceCells(serviceLabels, paneBody(layout.leftWidth)),
    [serviceLabels, layout.leftWidth],
  )
  const configCellWidths = useMemo(
    () => configCells(configRows.map(r => r.label), paneBody(layout.rightWidth)),
    [configRows, layout.rightWidth],
  )

  /**
   * Where the three panes ended up — read off the layout, never measured again.
   *
   * This is the whole of the mouse's geometry on this screen. `cockpitRects` knows that the band is
   * two columns of equal height and that a stacked cockpit draws services, DETAIL, config in that
   * order; a hit test that assumed anything else would hand every click on the config pane to the
   * detail pane on a narrow terminal, and nothing on screen would look wrong.
   */
  const rects = useMemo(() => cockpitRects(layout), [layout])
  /** Rows each pane actually DREW — a window into a longer list, which is what a click indexes. */
  const shownServices = Math.max(0, Math.min(servicesBody, services.length - serviceOffset))
  const shownConfig = Math.max(0, Math.min(configBody, configRows.length - configOffset))
  /** The action row's row: `detailPlan` pins it to the pane's floor, so it is the last one. */
  const actionRowY = paneRows(heights.detail) - 1

  /**
   * The detail region's width: FULL WIDTH under the band — see `cockpitLayout`. It is the pane whose
   * usefulness scales without bound in both directions, and the width is what stops it truncating
   * the URLs, the reasons and the build output it exists to state.
   */
  const detailWidthPx = layout.kind === 'columns' ? layout.leftWidth + layout.rightWidth : width

  /**
   * The output pane's window, from the region it owns — the detail pane, or the whole body when the
   * cockpit has stacked and there is no band to keep.
   *
   * The anchor is DERIVED rather than stored: while following, it has to track a list that is growing
   * under it, and a stored index would lag one burst of build output behind the newest line. The
   * offset then comes from `windowOffset`, which is what keeps the newest line ON SCREEN — slicing
   * from zero would leave a build's live edge below the fold, which is the whole reason to watch it.
   */
  const outputRows = paneRows(layout.kind === 'stacked' ? height : heights.detail)
  const outputLen = taskLines.length
  const outputAnchor = outputView.follow
    ? Math.max(0, outputLen - 1)
    : Math.min(outputView.index, Math.max(0, outputLen - 1))
  const outputOffset = windowOffset(outputAnchor, outputLen, outputRows)

  useEffect(() => {
    // The clock, and nothing else — this screen fetches nothing on an interval any more. It stops
    // while the screen is not on top, and it keeps ticking under a question, because a service
    // being started is exactly the uptime worth watching climb from zero.
    if (!isActive) return
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [isActive])

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  /**
   * Something other than the cockpit is answering keys.
   *
   * A question, or a task's output pane. Both are reported to the shell as `capture`, which stands
   * the global keys down — otherwise `q` would quit the app out from under a running build, and every
   * key meant for the pane would also act on the service list underneath it.
   */
  const capturing = view.kind !== 'cockpit' || taskOpen

  // Both refuse a conflicted selection, and the footer stops naming them for exactly as long as
  // that is true: `s` would stop both copies at once — the verb the action row deliberately does
  // not offer — and `R` would bounce both and leave the conflict standing. `enter` reaches the
  // per-runtime stops, which are the only stops that resolve anything.
  const stopSelected = useCallback(() => {
    if (selected && selected.state === 'up' && !conflicted) stopService(selected, s.actStop)
  }, [selected, conflicted, stopService, s.actStop])

  /** `R` is the PLAIN bounce — the option the host always offers, never a rebuild by accident. */
  const restartSelected = useCallback(() => {
    if (!selected || selected.state !== 'up' || conflicted) return
    const plain = selected.restartOptions.find(o => !o.rebuild)
    if (plain) restartNow(plain)
  }, [selected, conflicted, restartNow])

  const openSelected = useCallback(() => {
    const url = selected?.active?.webUrl
    if (url && selected.state === 'up') open(url)
  }, [selected, open])

  useInput((input, key) => {
    const nav: NavKey = {
      input,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
      escape: key.escape,
      tab: key.tab,
      shift: key.shift,
    }

    // WHICH key means WHAT is decided by the pure `resolveServicesKey` — the same function the help
    // overlay's key table is tested against — and only the index arithmetic is done here.
    const intent = resolveServicesKey({ ...nav, ctrl: key.ctrl }, {
      focus, panes, narrow, hasActions: actions.length > 0,
    })
    if (!intent) return
    switch (intent.kind) {
      case 'focus': return setWantFocus(intent.pane)
      case 'configRun': return configRows[configSelection]?.action?.run()
      case 'configMove': {
        const next = resolveListKey(nav, configSelection, configRows.length)
        if (next !== configSelection) setConfigIndex(next)
        return
      }
      case 'actionRun': return actions[Math.min(actionIndex, actions.length - 1)]?.run()
      case 'actionMove':
        return setActionIndex(i => (i + intent.step + actions.length) % actions.length)
      case 'openActions':
        setActionIndex(0)
        return setWantFocus('actions')
      case 'stop': return stopSelected()
      case 'restart': return restartSelected()
      case 'open': return openSelected()
      case 'move': {
        const next = resolveListKey(nav, selection, services.length)
        if (next !== selection) { setServiceIndex(next); setActionIndex(0) }
        return
      }
    }
  }, { isActive: isActive && !capturing })

  /**
   * The output pane's keys, and only these three.
   *
   * While a task owns the region the services underneath it are not selectable — the shell has been
   * told `capture`, so even `q` stands down — and that is deliberate: a keypress that acted on a
   * service while its own build was streaming would be acting on a screen the user cannot see. So
   * this reads the output (`↑↓`, page, `g`/`G`, `f` to re-follow) and dismisses it, which is exactly
   * what the footer says. Ctrl-C remains live in the shell, as it is in every capturing state.
   */
  useInput((input, key) => {
    const intent = resolveOutputKey(
      {
        input,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
        home: key.home,
        end: key.end,
        escape: key.escape,
        ctrl: key.ctrl,
      },
      { index: outputAnchor, follow: outputView.follow },
      outputLen,
      outputRows,
    )
    if (!intent) return
    if (intent.kind === 'close') return onDismissTask()
    setOutputView(intent.state)
  }, { isActive: isActive && taskOpen })

  /**
   * The cockpit's pointer, in BODY coordinates — the frame this screen lays itself out in.
   *
   * Two rules run through all of it, and they are the same two the keyboard already follows:
   *
   *  - A PANE IS A FOCUS. Clicking anywhere in one focuses it, because the panes relate: the detail
   *    pane is a view OF the selection, so pointing at either has to move the same cursor the
   *    keyboard does rather than opening a second one.
   *  - A LIST ROW IS A SELECTION, A VERB IS A VERB. One click on a service or a config row selects
   *    it; the DOUBLE is what acts, for the same reason a digit only moves the menu cursor — a row
   *    is something you point at to read it. A click on the action row runs that verb outright,
   *    because a verb is not something you select, and its label is what you aimed at.
   */
  usePointer(p => {
    // The output pane scrolls with the wheel, on the same reducer the keys use — including the rule
    // that any movement unpins the tail. Nothing else on the frame is live while it is up.
    if (taskOpen) {
      const notch = wheelDelta(p.button)
      if (notch === 0) return
      const next = scrollTailBy({ index: outputAnchor, follow: outputView.follow }, notch, outputLen)
      if (next) setOutputView(next)
      return
    }

    // A question owns the detail region and answers for itself (its `Menu` is listening too); the
    // panes behind it stand but are not live, exactly as they are to the keyboard.
    if (capturing) return

    const wheel = wheelDelta(p.button)

    const svc = rectHit(rects.services, p.x, p.y)
    if (svc) {
      if (wheel !== 0) {
        // Clamped, not wrapped: the keyboard's `j`/`k` ring is a deliberate choice on a short list,
        // while a wheel that jumped from the last row to the first would read as a broken screen.
        const moved = scrollBy(selection, wheel, services.length)
        if (moved !== selection) { setServiceIndex(moved); setActionIndex(0) }
        return
      }
      if (!isActivation(p)) return
      setWantFocus('services')
      const inner = paneHit(rects.services.width, rects.services.height, svc.x, svc.y)
      if (!inner) return
      const row = listRowAt(inner.y, serviceOffset, shownServices)
      if (row === null) return
      if (row !== selection) { setServiceIndex(row); setActionIndex(0); return }
      if (p.double) runDefault(services[row]!)
      return
    }

    const cfg = rects.config && rectHit(rects.config, p.x, p.y)
    if (cfg) {
      if (wheel !== 0) {
        setConfigIndex(scrollBy(configSelection, wheel, configRows.length))
        return
      }
      if (!isActivation(p)) return
      setWantFocus('config')
      const inner = paneHit(rects.config!.width, rects.config!.height, cfg.x, cfg.y)
      if (!inner) return
      const row = listRowAt(inner.y, configOffset, shownConfig)
      if (row === null) return
      if (row !== configSelection) { setConfigIndex(row); return }
      if (p.double) configRows[row]?.action?.run()
      return
    }

    const det = rects.detail && rectHit(rects.detail, p.x, p.y)
    if (det) {
      if (!isActivation(p) || actions.length === 0) return
      setWantFocus('actions')
      const inner = paneHit(rects.detail!.width, rects.detail!.height, det.x, det.y)
      if (!inner || inner.y !== actionRowY) return
      // The SAME window `ActionRow` will draw — same labels, same selection, same width — so the
      // verb under the pointer is the verb that was drawn there even when the row had to drop some.
      const fit = fitActionRow(
        actions.map(a => a.label),
        Math.min(actionIndex, actions.length - 1),
        paneBody(rects.detail!.width),
      )
      const at = actionAtColumn(fit, inner.x)
      if (at === null) return
      setActionIndex(at)
      actions[at]?.run()
    }
  }, { isActive })

  // -------------------------------------------------------------------------
  // what the footer says, and who owns the arrows
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isActive) return
    onChrome({
      capture: capturing,
      // The action row is a horizontal list, so it takes `←→` from the screen switcher — and the
      // footer stops saying `←→ screens` for exactly as long as that is true. A hint for a key that
      // does nothing in the current focus is the bug this pairing exists to prevent.
      claimArrows: !capturing && focus === 'actions',
      // A question's three keys are its own — it is a `Menu` or a `Prompt`, and the shell cannot see
      // which. Everything else, INCLUDING the output pane, goes through `cockpitHints`, which is the
      // one place that decides what the footer may claim works.
      hints: view.kind !== 'cockpit' && !taskOpen
        ? [s.keyBack, s.keyMove, s.keySelect]
        : cockpitHints(focus, s, {
            canAct: actions.length > 0,
            canStop: selected?.state === 'up' && !conflicted,
            canOpen: Boolean(host.openUrl && selected?.active?.webUrl && selected.state === 'up'),
            // A short terminal keeps the services pane alone, and `tab` there cycles a list of one.
            panes: panes.length,
            task: taskOpen,
            narrow,
          }),
    })
  }, [
    isActive, capturing, focus, s, selected, conflicted, host,
    actions.length, panes.length, onChrome, view.kind, taskOpen, narrow,
  ])

  // -------------------------------------------------------------------------
  // drawing
  // -------------------------------------------------------------------------

  /**
   * What occupies the detail region: a task's output, a question, or nothing (the facts).
   *
   * The OUTPUT WINS. A start goes through the archive gate and a kill question, and both of those
   * are still technically open for the tick it takes their `run` to settle — so a build streaming
   * into the region while the question that led to it is still drawn over it would hide the very
   * thing the user asked to watch. It is also why `capturing` is true either way and why the
   * questions are handed `isActive={questionsLive}`: exactly one thing on this frame answers keys.
   */
  const overlay = taskOverlay() ?? overlayFor()

  const servicesPane = (
    <Pane
      title={s.paneServices}
      focused={focus === 'services'}
      width={layout.leftWidth}
      height={heights.services}
    >
      {services.length === 0
        ? <Text dimColor>{truncate(s.noServices, paneBody(layout.leftWidth))}</Text>
        : services.slice(serviceOffset, serviceOffset + servicesBody).map((service, i) => (
            <ServiceLine
              key={service.id}
              label={service.label}
              runtime={serviceLabels[serviceOffset + i]?.runtime ?? ''}
              state={service.state}
              word={service.conflict ? s.stateConflict : stateWord(service.state, s)}
              conflict={Boolean(service.conflict)}
              selected={serviceOffset + i === selection}
              focused={focus === 'services'}
              cells={cells}
            />
          ))}
    </Pane>
  )

  const configPane = heights.config > 0 ? (
    <Pane
      title={s.paneConfig}
      focused={focus === 'config'}
      width={layout.rightWidth}
      height={heights.config}
    >
      {configRows.slice(configOffset, configOffset + configBody).map((row, i) => (
        <ConfigLine
          key={row.key}
          label={row.label}
          // The long form when the column can hold it whole, the short one when it cannot.
          value={fitValue(row.value, row.short, configCellWidths.value)}
          verb={row.action?.label}
          cells={configCellWidths}
          selected={configOffset + i === configSelection}
          focused={focus === 'config'}
        />
      ))}
    </Pane>
  ) : null

  const detailPane = heights.detail > 0 ? (
    <Pane
      title={selected?.label ?? s.paneDetail}
      // The runtimes it is running under, not the ones it could: a badge is a status. BOTH of them
      // in a conflict — naming the first one we found would be the badge quietly agreeing that
      // there is one copy running.
      badge={serviceLabels[selection]?.runtime ?? ''}
      focused={focus === 'actions'}
      width={detailWidthPx}
      height={heights.detail}
    >
      <DetailBody
        content={detail}
        actions={actions.map(a => a.label)}
        actionIndex={Math.min(actionIndex, Math.max(0, actions.length - 1))}
        focused={focus === 'actions'}
        width={paneBody(detailWidthPx)}
        rows={paneRows(heights.detail)}
      />
    </Pane>
  ) : null

  // NARROW: one pane over the whole body, under the strip that names all three. The overlay (a
  // question, or a task's output) owns the detail region, so while one is up it is what is drawn —
  // `cockpitLayout` has already made `detail` the shown pane for exactly that reason.
  if (layout.kind === 'single') {
    const shown = layout.shown ?? 'services'
    const order = ['services', 'config', 'detail'] as const
    return (
      <Box flexDirection="column" width={width} height={height} flexShrink={0}>
        {layout.strip ? (
          <PaneStrip labels={[s.paneServices, s.paneConfig, s.paneDetail]} active={order.indexOf(shown)} width={width} />
        ) : null}
        {overlay
          ? (
            <Pane title={overlay.title} badge={overlay.badge} focused width={width} height={heights.detail}>
              {overlay.node}
            </Pane>
          )
          : shown === 'services' ? servicesPane : shown === 'config' ? configPane : detailPane}
      </Box>
    )
  }

  // The overlay owns the detail region, so the services and config panes stay standing: choosing
  // "how should it run?" must never cost sight of what is already running. Stacked, there is no
  // band to keep, and the question takes the body — a prompt squeezed under a list it cannot fit
  // beside is unusable, and the list is one keypress away again.
  if (overlay && layout.kind === 'stacked') {
    return (
      <Box flexDirection="column" width={width} height={height} flexShrink={0}>
        <Pane title={overlay.title} badge={overlay.badge} focused width={width} height={height}>
          {overlay.node}
        </Pane>
      </Box>
    )
  }

  // Stacked, the panes are drawn in the order `cockpitLayout` allocated them rather than column by
  // column: the detail pane is what you act on, so it belongs directly under the selection that
  // drives it — putting config between the two would separate the cockpit's one relationship.
  if (layout.kind === 'stacked') {
    return (
      <Box flexDirection="column" width={width} height={height} flexShrink={0}>
        {servicesPane}
        {detailPane}
        {configPane}
      </Box>
    )
  }

  // The band — the selection beside the machine's settings — and then the detail pane across the
  // whole frame under it. The band's two panes are equal height by construction (`cockpitLayout`),
  // so neither ends in a hole, and a question is drawn into the detail region at `heights.detail`,
  // exactly like the pane it replaces, with the band still standing above it.
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0}>
      <Box flexDirection="row" width={width} flexShrink={0}>
        {servicesPane}
        {configPane}
      </Box>
      {overlay
        ? (
          <Pane title={overlay.title} badge={overlay.badge} focused width={width} height={heights.detail}>
            {overlay.node}
          </Pane>
        )
        : detailPane}
    </Box>
  )

  /**
   * The task's output, as the same shape a question takes.
   *
   * It goes through the overlay seam rather than beside it because it is the same THING: something
   * that owns the detail region for a while and hands it back. The pane wears the verb the user
   * pressed, and its badge is the window position plus — while the tail is unpinned — the word that
   * says so, because a pane showing history while a build runs must not look like a stalled one.
   */
  function taskOverlay(): Overlay | null {
    if (!task || !taskOpen) return null
    const position = windowLabel(outputOffset, Math.min(outputRows, outputLen), outputLen)
    return {
      title: task.title,
      badge: outputView.follow ? position : `${position}  ${s.logPaused}`,
      node: (
        <OutputView
          lines={taskLines}
          offset={outputOffset}
          rows={outputRows}
          width={paneBody(layout.kind === 'columns' ? detailWidthPx : width)}
        />
      ),
    }
  }

  /**
   * The seam, in one function: `View` in, something drawn out.
   *
   * Every branch returns a title for the pane frame and a node for its inside, and reports its
   * outcome through the callbacks above — no branch performs anything itself. Declared last, and
   * as a closure, because it needs the flow callbacks and nothing needs it.
   */
  function overlayFor(): Overlay | null {
    // While a task owns the region its output is drawn over the question, so the question must not
    // go on answering keys from behind it: `esc` there belongs to the pane the user can see.
    const questionsLive = isActive && !taskOpen
    const body = paneBody(width)
    const rows = paneRows(layout.kind === 'stacked' ? height : heights.detail)
    // Where the overlay's pane puts its first content cell, in body coordinates — the two places it
    // can be drawn (see the returns above) and the frame that pane spends on itself. Handed to the
    // question so it can resolve a click against its OWN rows and learn nothing about the frame.
    const frame: Rect = layout.kind !== 'stacked' && rects.detail
      ? rects.detail
      : { x: 0, y: 0, width, height }
    const pad = paneOrigin(frame.height)
    const origin = { x: frame.x + pad.x, y: frame.y + pad.y }

    switch (view.kind) {
      case 'cockpit':
        return null

      case 'kill':
        return {
          title: s.paneServices,
          node: (
            <ConfirmPrompt
              label={s.killQuestion}
              yesLabel={s.yes}
              noLabel={s.no}
              onAnswer={yes => onKill(yes, view.option)}
              onCancel={back}
              width={body}
              isActive={questionsLive}
              origin={origin}
            />
          ),
        }

      case 'archive':
        return {
          title: s.historyLabel,
          node: (
            <ArchiveChoice
              strings={s}
              suggested={view.suggested}
              onPick={mode => onArchive(mode, view.then, view.thenBoot)}
              onSkip={view.gate ? onArchiveSkip : undefined}
              onCancel={view.gate ? onArchiveSkip : back}
              width={body}
              height={rows}
              isActive={questionsLive}
              origin={origin}
            />
          ),
        }

      case 'disconnect':
        return {
          title: s.paneConfig,
          node: (
            <ConfirmPrompt
              label={`${l.itemDisconnect} — ${l.itemDisconnectHint}?`}
              yesLabel={s.yes}
              noLabel={s.no}
              onAnswer={yes => (yes ? void run(() => host.disconnect()).then(back) : back())}
              onCancel={back}
              width={body}
              isActive={questionsLive}
              origin={origin}
            />
          ),
        }

      case 'connect':
        return {
          title: l.itemConnect,
          node: (
            <TextPrompt
              // Remounting per step (rather than reusing one field) is what clears the previous
              // answer; a shared field would show the endpoint while asking for the token.
              key={view.step}
              label={view.step === 'endpoint' ? l.promptEndpoint : view.step === 'token' ? l.promptToken : l.promptOrg}
              secret={view.step === 'token'}
              defaultValue={view.step === 'org' ? l.orgDefault : undefined}
              onSubmit={value => onConnect(view.step, view.endpoint, view.token, value)}
              onCancel={() => {
                // One level at a time, so a mistyped token does not throw away the endpoint.
                if (view.step === 'org') return setView({ ...view, step: 'token' })
                if (view.step === 'token') return setView({ ...view, step: 'endpoint' })
                return back()
              }}
              width={body}
              isActive={questionsLive}
            />
          ),
        }

      case 'boot':
        return {
          title: s.paneConfig,
          node: (
            <ConfirmPrompt
              label={s.bootQuestion}
              yesLabel={s.yes}
              noLabel={s.no}
              onAnswer={yes => onBoot(view.service, view.runtime, yes)}
              onCancel={back}
              width={body}
              isActive={questionsLive}
              origin={origin}
            />
          ),
        }

      case 'bootSwitch':
        return {
          title: s.bootLabel,
          node: (
            <ConfirmPrompt
              // The HOST's sentence, which names the unit. Rule of this screen and of this pane:
              // an act that writes or removes a systemd user unit must say which one, because the
              // change outlives the session and "are you sure?" would read identically for the two
              // opposite directions of the same switch.
              label={(view.afterStop ? view.option.confirmAfterStop : undefined) ?? view.option.confirm}
              yesLabel={s.yes}
              noLabel={s.no}
              onAnswer={yes => onBootSwitch(view.service, view.option, yes)}
              onCancel={back}
              width={body}
              isActive={questionsLive}
              origin={origin}
            />
          ),
        }

      case 'setup': {
        // MEASURED, never assumed: the question wraps to three rows at forty columns, and a menu
        // budgeted for one would draw its last option on top of the pane's bottom border — Ink
        // composites an overflow rather than clipping it. The blank under the question is the `+ 1`.
        const asked = questionRows(s.setupQuestion, body) + 1
        return {
          title: s.setupLabel,
          node: (
            <>
              <Question text={s.setupQuestion} width={body} />
              <Text> </Text>
              <Menu
                items={SETUP_MODES.map(mode => ({
                  label: s.setupMode[mode],
                  value: mode,
                  // The BLOCKED reason replaces the ordinary hint rather than joining it: a row that
                  // cannot be picked has one thing worth saying, and it is why. The host decides —
                  // it is the only side that knows what is running.
                  hint: status?.setupBlocked?.[mode] ?? s.setupModeHint[mode],
                  disabled: Boolean(status?.setupBlocked?.[mode]),
                }))}
                onSelect={value => onSetupMode(value as TeamMode)}
                onCancel={back}
                width={body}
                height={Math.max(1, rows - asked)}
                isActive={questionsLive}
                origin={{ x: origin.x, y: origin.y + asked }}
              />
            </>
          ),
        }
      }
    }
  }

  function onKill(yes: boolean, option: StartOption) {
    if (!yes) return back()
    // The RUNTIME the option said it would collide with, never the logical service: stopping the
    // service would also take down a container that has nothing to do with the port.
    return void run(() => host.stop(option.blockedBy ?? option.runtime)).then(res => {
      if (res.ok) void archiveThen(option)
      else back()
    })
  }

  /**
   * The consent answered. What follows it is whatever raised it: a start that was waiting, the
   * wizard's boot offer, or nothing at all.
   */
  function onArchive(mode: ArchiveMode, then: StartOption | null, thenBoot?: ServiceId) {
    void run(() => host.setArchiveMode(mode)).then(() => {
      if (then) return startNow(then)
      if (thenBoot) return setView({ kind: 'boot', service: thenBoot })
      return back()
    })
  }

  /** Skipping the opening gate. It writes NOTHING — the setting stays unanswered on purpose — and
   *  says so, because a question that vanishes silently reads as one that was answered. */
  function onArchiveSkip() {
    back()
    void run(async () => ({ ok: true, message: s.archiveLaterMessage }))
  }

  function onConnect(step: ConnectStep, endpoint: string, token: string, value: string) {
    if (step === 'endpoint') return setView({ kind: 'connect', step: 'token', endpoint: value, token: '' })
    if (step === 'token') return setView({ kind: 'connect', step: 'org', endpoint, token: value })
    // The wizard's tail, and only after a connect that WORKED: a consent written for a machine that
    // never joined would be a preference recorded about nothing. `cli-setup.ts` asks in this order.
    return void run(() => host.connect({ endpoint, token, org: value })).then(res => {
      if (res.ok) void askArchive('agentistics')
      else back()
    })
  }

  function onBoot(service: ServiceId, runtime: RuntimeId | undefined, yes: boolean) {
    if (!yes) return back()
    return void run(() => host.enableBoot(service, runtime)).then(back)
  }

  /** Either direction of the switch, and the only place either is performed. */
  function onBootSwitch(service: ServiceId, option: BootOption, yes: boolean) {
    if (!yes) return back()
    return void run(
      () => (option.enable
        ? host.enableBoot(service, option.runtime)
        : host.disableBoot(service, option.runtime)),
      option.label,
    ).then(back)
  }

  /**
   * The wizard's answer, routed into the flow that already lived on this screen.
   *
   * Order preserved from `cli-setup.ts` exactly: solo persists the mode and then asks the archive
   * consent; central runs `central.sh init` and only offers boot when the init SUCCEEDED; member
   * gathers endpoint → token → org, connects, and only then asks the consent and the boot question.
   * Anything that ran before a successful connect would be a preference written for a machine that
   * never joined.
   *
   * `solo` on a machine that IS a member goes through the confirmed disconnect rather than straight
   * to `setMode`, because there it is a leave: it surrenders the member tokens, which are minted on
   * the central and stored nowhere else on this box.
   */
  function onSetupMode(mode: TeamMode) {
    if (mode === 'central') {
      return void run(() => host.initCentral(), s.setupMode.central).then(res => {
        setView(res.ok ? { kind: 'boot', service: 'central' } : { kind: 'cockpit' })
      })
    }
    if (mode === 'member') {
      return setView({ kind: 'connect', step: 'endpoint', endpoint: '', token: '' })
    }
    if (status?.mode === 'member') return setView({ kind: 'disconnect' })
    return void run(() => host.setMode('solo'), s.setupMode.solo).then(res => {
      if (res.ok) void askArchive()
      else back()
    })
  }
}

/**
 * The three modes, in the order `cli-setup.ts` asks them.
 *
 * A `readonly` tuple rather than a literal written at the call site: the menu, the string table and
 * `ControlStatus.setupBlocked` all key on these, and a hardcoded list is what CLAUDE.md forbids for
 * harnesses for exactly the reason it would fail here — a mode added to the product would compile
 * clean and be missing from the wizard.
 */
const SETUP_MODES: readonly TeamMode[] = ['solo', 'central', 'member'] as const

/** Tone → colour. The one place a `DetailTone` becomes a colour, so the mapping cannot drift. */
const TONE_COLOR: Record<DetailTone, string | undefined> = {
  plain: COLORS.text,
  muted: undefined,
  good: COLORS.success,
  bad: COLORS.danger,
  info: COLORS.info,
}

/**
 * The detail pane's rows, budgeted by `detailPlan` so the ACTION row is the last thing to go and
 * sits on the pane's floor.
 *
 * A pane that dropped its verbs and kept a URL would be a readout; the reason the actions live here
 * rather than in a menu of their own is that they belong to the thing described above them.
 *
 * The lines arrive already composed and already ordered by `detailContent`, in the order they must
 * survive a short pane — the ALERT leads, because a pane with one fact row must not spend it on
 * `native · pid 48213 · up 2h14m` while the same program is running twice. This component maps a
 * `kind` to a shape and a `tone` to a colour, and decides nothing.
 */
function DetailBody({ content, actions, actionIndex, focused, width, rows }: {
  content: DetailContent | null
  actions: string[]
  actionIndex: number
  focused: boolean
  width: number
  rows: number
}) {
  if (!content) return null

  const labelWidth = content.labelWidth
  // Cut to the rows this pane has BEFORE the plan is drawn up, so a slice that landed on a section
  // rule takes the rule with it — see `fitDetailLines`. The action row's own row is reserved here
  // because `detailPlan` will spend it either way.
  const shown = fitDetailLines(content.lines, Math.max(0, rows - (actions.length > 0 ? 1 : 0)))
  const facts = shown.map((line, i) => {
    const key = `${line.kind}${i}`
    if (line.kind === 'blank') return <Text key={key}> </Text>
    // The same titled rule the linear screens use, so a section reads the same everywhere in the
    // app — and it is what turns a dozen facts into four things you can find with your eye.
    if (line.kind === 'section') return <SectionHeader key={key} title={line.label} width={width} />
    if (line.kind === 'text') {
      return (
        <Text key={key} color={TONE_COLOR[line.tone]} dimColor={line.tone === 'muted'}>
          {truncate(line.value, width)}
        </Text>
      )
    }
    return (
      <Text key={key}>
        <Text dimColor>{truncate(line.label, labelWidth).padEnd(labelWidth)}</Text>
        <Text color={TONE_COLOR[line.tone]}>
          {' ' + truncate(line.value, Math.max(1, width - labelWidth - 1))}
        </Text>
      </Text>
    )
  })

  const plan = detailPlan(rows, facts.length, actions.length > 0)

  return (
    <>
      {facts.slice(0, plan.facts)}
      {/* Air between the facts and a row that stops a server — and it is the pane's slack, not a
          single separator row: this pane owns everything under the band, so on a tall terminal it
          has rows to spare. Under the verbs they read as a dead region; over them they read as air,
          and the verbs stop moving as the selection changes. */}
      {Array.from({ length: plan.pad }, (_, i) => <Text key={`pad${i}`}> </Text>)}
      {plan.actions
        ? <ActionRow labels={actions} selected={actionIndex} focused={focused} width={width} />
        : null}
    </>
  )
}
