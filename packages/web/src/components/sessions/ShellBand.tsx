/**
 * ShellBand — a real shell, in the selected session's own folder, docked as the LAST band of the
 * session panel.
 *
 * It is called **Shell**, not Terminal, and that is not fussiness: the session header already
 * carries a `Chat | Terminal` toggle, and that "Terminal" is the ASSISTANT'S own screen — the tmux
 * pane `claude` is drawing in, where a permission dialog is answered. Two controls named Terminal
 * on one panel, doing different things, is an ambiguity nobody untangles on their own.
 *
 * ## What is reused, and what is new
 *
 * Everything that renders and drives a tmux pane in this browser already exists and is already
 * hardened: `SessionTerminal` (the lazily-chunked xterm), `useTerminalStream` (SSE + the honesty
 * line), `useTerminalWrite` (the ordered WS write channel with its per-key acks). This component
 * points all three at the SHELL scope — `lib/terminalEndpoint.ts` owns which routes that means —
 * and adds the two things a shell needs that a session does not: the band geometry, and the mobile
 * key strip.
 *
 * ## The unwatch discipline
 *
 * The capture loop runs ONLY while the band is open, this session is the selected one, and the
 * document is visible. It is the only per-second cost this feature has, and it is `shellWatching`'s
 * one job; `useTerminalStream(null)` is what actually drops the subscription, after which the
 * server's hub stops capturing as its last reader leaves. Collapsing the band, switching session
 * (the component is keyed by session, so it unmounts) or backgrounding the tab all stop it.
 *
 * ## Consent
 *
 * There is no arm/disarm here, unlike the fleet terminal's composer. OPENING the shell is the
 * consent — a person pressed a button that spawned `$SHELL` in a directory they named — and the
 * server refused the whole route unless `CAPS.localShell` and the `shellEnabled` switch both stand.
 * A second gate on top of that would be ceremony, not safety.
 *
 * ## Refusals
 *
 * `/api/shell/open` answers a REFUSAL as a 200 carrying a sentence (`no-tmux`, `no-cwd`,
 * `cwd-missing`, `at-cap`) — shown verbatim, never re-worded here. The route-level errors upstream
 * of it (`shell_disabled`, `shell_central`) carry a CODE and no prose, and `shellErrorText` is the
 * one place that turns those into sentences. A blank band is never an answer.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import {
  ChevronLeft, Loader2,
  RotateCcw, TerminalSquare, Trash2, X,
} from 'lucide-react'
import { useDocumentVisible } from '../../hooks/useDocumentVisible'
import { useElementWidth } from '../../hooks/useElementWidth'
import { keyStripShown } from '../../lib/terminalSurface'
import { floatPanel } from '../../lib/floatingPanels'
import { dockedShowsTarget, usePanelSlots, type PanelDropTarget } from '../../lib/panelSlots'
import { usePaneId } from '../../lib/paneScope'
import {
  followBottomOccupant, resolveDockedTarget, shellTargetUnavailable, targetLabel, targetScope,
  targetStreamId, type TerminalTarget,
} from '../../lib/terminalTarget'
import { Watermark } from './Studio'
import {
  atCap, ceilingRows, ceilingTitle, type CeilingRow, type CeilingShell,
} from '../../lib/shellCeiling'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTerminalStream } from '../../hooks/useTerminalStream'
import { useTerminalWrite } from '../../hooks/useTerminalWrite'
import {
  BAND_MIN_PX, bandPanelFull, readBandPrefs, resolveBandDrag, resolveBandHeight, seedBandOpen,
  shellApiUrl, shellErrorText, shellWatching, bandGeometry, shellWhere, withBandPanelFull,
  writeBandGeometry, writeBandPrefs, sharedBand, type BandPrefs,
} from '../../lib/shellBand'
import {
  INITIAL_SHELL_BAND, shellBandReducer, shellResolveWanted, type OpenShell,
} from '../../lib/shellBandState'
import { ctrlKeyFor, keyBytes, stripCtrlGuard, stripEntries, stripKeyLabel } from '../../lib/keyStrip'
import { guardNoticeText, NOTICE_TONE, type NoticeKind } from '../../lib/terminalShortcuts'
import { clipboardPasteAvailable, pasteFromClipboard } from '../../lib/clipboardPaste'
import { terminalStatus } from '../../lib/terminalStream'
import { createPaneResizer } from '../../lib/paneResizeRequest'
import { bandSegmentEntries } from '../../lib/bandSegment'
import { bandBarCompact, type PanelBarEntry, type PanelBarId } from '../../lib/panelBar'
import { panelMenuEntries } from '../../lib/panelMenu'
import {
  BAND_CONTROL_H, BandResizeHandle, BandSegment, BandSegmentTab, PanelBar, PanelFixedControls, PanelPinButton,
  panelMenuIconFor, useBandDrag, useBandDropTarget, type BandOverflowEntry,
} from './bandControls'
import { closeEndsShell, publishLiveShell, requestShellClose, useShellClose } from '../../lib/shellClose'
import { ShellCloseStatus } from './ShellCloseStatus'

const SessionTerminal = lazy(() => import('../SessionTerminal'))
import type { TerminalNotice } from '../SessionTerminal'

interface T {
  title: string
  open: string
  opening: string
  close: string
  collapse: string
  expand: string
  toggleBar: string
  back: string
  ctrlHint: string
  ctrlRefused: (c: string) => string
  // I1: shown via `ctrlNote` when the strip's `paste` button hits a denied/blocked clipboard
  // permission — before this, that outcome and an empty clipboard were the same silence.
  pasteDenied: string
  resize: string
  retry: string
  endThis: string
  whichTerminal: string
  openOnRight: string
  floatingElsewhere: string
  /** The VISIBLE word beside the icon (fix-wave review, owner follow-up #5) — short, unlike the
   *  fuller `fullscreen`/`close`/`collapse`/`expand` sentences above, which stay the tooltip. */
  fullscreenLabel: string
  closeLabel: string
  collapseLabel: string
  expandLabel: string
  /** The disabled-shell empty state (design follow-up, owner report 2026-09-18) — it appears only
   *  when the SAVED arrangement still names the shell (see `resolveDockedTarget`'s own header), so
   *  its own sentence has to cover all three: the shell is off, WHERE that was decided, and what
   *  turning it on does. */
  shellOffTitle: string
  shellOffBody: string
  /** The CAPABILITY-off reading (the exposure profile itself, never the preference) — a plain
   *  sentence and no buttons, because neither button could ever succeed here. */
  shellOffCapability: string
  enableNow: string
  enableNowBusy: string
  enablePermanently: string
  enablePermanentlyBusy: string
}

const TXT: Record<'pt' | 'en', T> = {
  en: {
    title: 'Shell',
    open: 'Open a shell here',
    opening: 'Opening…',
    close: 'End this shell',
    collapse: 'Collapse the shell',
    expand: 'Expand the shell',
    toggleBar: 'Open or collapse the shell',
    back: 'Back to the session',
    ctrlHint: 'ctrl is armed — press a letter',
    ctrlRefused: c => `ctrl+${c} is not one of the keys this channel sends.`,
    pasteDenied: 'Could not read the clipboard — check the browser permission.',
    resize: 'Drag to resize the shell',
    retry: 'Try again',
    endThis: 'End this terminal',
    whichTerminal: 'Which terminal',
    openOnRight: 'This is open in the panel on the right. Pick it again to bring it back here.',
    floatingElsewhere: 'This is floating in its own window. Press the pin on that window to dock it back here.',
    fullscreenLabel: 'Full screen',
    closeLabel: 'End shell',
    collapseLabel: 'Collapse',
    expandLabel: 'Expand',
    shellOffTitle: 'The shell is off',
    shellOffBody: 'The utility shell for this session’s own folder is off — turned off in this '
      + 'machine’s Settings → Sessions. Turning it on opens a real shell here, in the folder this '
      + 'session runs in.',
    shellOffCapability: 'This machine’s exposure profile does not allow a shell here — no switch '
      + 'on this screen can change that.',
    enableNow: 'Enable now',
    enableNowBusy: 'Enabling…',
    enablePermanently: 'Enable permanently',
    enablePermanentlyBusy: 'Saving…',
  },
  pt: {
    title: 'Shell',
    open: 'Abrir um shell aqui',
    opening: 'Abrindo…',
    close: 'Encerrar este shell',
    collapse: 'Recolher o shell',
    expand: 'Expandir o shell',
    toggleBar: 'Abrir ou recolher o shell',
    back: 'Voltar para a sessão',
    ctrlHint: 'ctrl armado — pressione uma letra',
    ctrlRefused: c => `ctrl+${c} não é uma das teclas que este canal envia.`,
    pasteDenied: 'Não foi possível ler a área de transferência — verifique a permissão do navegador.',
    resize: 'Arraste para redimensionar o shell',
    retry: 'Tentar de novo',
    endThis: 'Encerrar este terminal',
    whichTerminal: 'Qual terminal',
    openOnRight: 'Isto está aberto no painel à direita. Selecione de novo para trazer de volta aqui.',
    floatingElsewhere: 'Isto está flutuando numa janela. Aperte o pin dela para encaixar de volta aqui.',
    fullscreenLabel: 'Tela cheia',
    closeLabel: 'Encerrar shell',
    collapseLabel: 'Recolher',
    expandLabel: 'Expandir',
    shellOffTitle: 'O shell está desligado',
    shellOffBody: 'O shell utilitário para a pasta desta sessão está desligado — foi desligado em '
      + 'Configurações → Sessões desta máquina. Ligar abre um shell de verdade aqui, na pasta onde '
      + 'esta sessão roda.',
    shellOffCapability: 'O perfil de exposição desta máquina não permite um shell aqui — nenhum '
      + 'interruptor nesta tela pode mudar isso.',
    enableNow: 'Habilitar agora',
    enableNowBusy: 'Habilitando…',
    enablePermanently: 'Habilitar permanentemente',
    enablePermanentlyBusy: 'Salvando…',
  },
}

export interface ShellBandProps {
  /** The fleet row this shell belongs to. Its `cwd` is the server's to read — never sent from here. */
  sessionId: string
  /** Shown in the band's title, so it is obvious WHERE the shell was opened. */
  cwd?: string
  lang: 'pt' | 'en'
  theme: 'dark' | 'light'
  /** The harness running in this session, so the CLI target is named after what is on its screen
   *  (`Claude Code`) rather than after a concept ("Assistente"). Absent, or one this build has no
   *  label for, falls back to words — never to a blank segment. */
  harness?: string
  /**
   * WHERE this shell is drawn. `docked` is the band under the composer — the placement whose whole
   * point is SIMULTANEITY, reading the conversation while a build runs beside it. `dedicated` is
   * the shell filling its own screen: no bar, no drag handle, no collapsed state, because you got
   * here by asking for it and the way back is the screen's own control. `aside` (design §1.5) is
   * the RIGHT SLOT's own placement — it fills its box exactly like `dedicated` (no bar, no drag
   * handle: the slot's own switcher and close are the way out), but it is embedded beside the
   * conversation rather than a screen of its own, so it carries no key strip route and no
   * fullscreen control of its own.
   *
   * The three share every rule that matters — one stream, one write channel, one emulator, the same
   * unwatch discipline — which is the entire reason this is a prop and not a second component.
   */
  placement?: 'docked' | 'dedicated' | 'aside'
  /**
   * PIN WHICH PANE this mount shows, for the placements that show exactly one: the right slot, a
   * floating window and the dedicated screen each ask for `cli` or `shell` by name. Without it the
   * pane came from the DOCKED band's stored preference, so a right-slot "Claude Code" could open
   * on the shell. This band is the ONE terminal of the Sessions workspace — the older
   * `TerminalRegion` with its line-input fallback is no longer used there (owner, 2026-09-27).
   */
  fixedTarget?: TerminalTarget
  /**
   * The session HAS a harness screen. Absent reads as true; `false` for a NATIVE Agentistics
   * session (UI.UNIFY) — the phone's segment then offers no CLI pane, never one streaming nothing.
   */
  cliAvailable?: boolean
  /**
   * Offered only when there is somewhere to go: the band's "take the whole screen" control.
   *
   * Takes the TARGET this band is showing right now (`cli`/`shell`) — never a bare callback. It
   * used to be one, wired unconditionally to the shell's own dedicated screen, so pressing "full
   * screen" while reading the Claude Code pane opened the shell instead: the caller has no way to
   * know which of the two panes this band's own local `target` is on without being told.
   */
  onOpenFullscreen?: (target: TerminalTarget) => void
  /**
   * THE ONE PANEL BAR (design item 1) — `Conteúdo · Studio · Claude Code · Shell · Hardware`,
   * computed by the caller (`SessionPanel`, which has `panelSlots`/`artifactsStore` in scope) through
   * `panelBarEntries`. It replaces the docked band's own former `Claude Code | Shell | Studio`
   * segment — that segment's whole job (switch what THIS band shows) is a subset of what this bar
   * now does. `docked`, desktop only — `aside`/`dedicated` show one stream and nothing else sits
   * beside them, and mobile keeps its own compact switcher (see the module header).
   */
  barEntries?: readonly PanelBarEntry[]
  /**
   * A tab was picked. `SessionPanel` builds ONE such handler shared by this band and `StudioBand`,
   * so the two can never disagree about what clicking Contents/Studio/Hardware does — this band adds
   * only the cli/shell-specific side effects (`chooseTarget`, opening if collapsed) around it, in
   * `handleBarPick` below, because those two targets are this band's own local preference and no
   * other caller of the shared handler needs to know that.
   */
  onBarPick?: (id: PanelBarId) => void
  /** Spec §3, drag — see `PanelBar`'s own `onDrop` prop. Optional so no caller is forced to wire it. */
  onBarDrop?: (dragPanel: PanelBarId, target: PanelDropTarget) => void
  /** The bar's own context-menu move verb (addendum, 2026-09-21) — see `PanelBar`'s own `onMove`. */
  onBarMove?: (id: PanelBarId) => void
  /** The first-open dot on the Studio entry — `App.tsx`'s own `studioSeen`, threaded down through
   *  `SessionPanel`. */
  studioSeen?: boolean
  /**
   * WHAT `panelSlots.ts` SAYS THE BOTTOM SLOT HOLDS, `'cli'`/`'shell'` only — seeds this band's own
   * `target` state on a FRESH MOUNT (a fresh mount happens whenever `StudioBand` swaps out for this
   * component: picking Claude Code or Shell from within `StudioBand`'s own bar displaces the Studio
   * and hands the bottom slot to whichever was picked, and without this the new `ShellBand` instance
   * would initialise `target` from its own stored preference, disagreeing with what was just
   * requested on the very first frame) — AND kept in sync for the life of the mount, below (the
   * effect next to `target`'s own declaration).
   *
   * That second half is not optional. `target` is this band's own LOCAL preference and nothing sets
   * it except `chooseTarget`, called only from THIS component's own click handlers
   * (`handleBarPick`, the mobile `targetSwitch`). `SessionPanel`'s "bring it to the bottom" gesture
   * (owner feedback, 2026-09-17) writes `panelSlots` from OUTSIDE this component — it has no access
   * to `chooseTarget` at all — so without the effect, `bottomOccupant` flips to the newly-moved
   * panel while `target` (and the stream on screen) stays whatever it was, which is what made
   * "Mover para baixo" read as "this just closes the right aside": the store moved the panel
   * correctly and this band kept showing the wrong thing, or nothing.
   */
  bottomOccupant?: 'cli' | 'shell' | null
  /**
   * MAY THIS BAND EVER SHOW OR OPEN A SHELL — `CAPS.localShell` AND the user's own switch,
   * threaded straight from `SessionPanel`'s own `shellEnabled` prop. It narrows this band's SHELL
   * half only; the CLI pane is the session's own harness terminal and is never gated by it, so this
   * component always renders once mounted — see `lib/panelBar.ts`'s `bottomBandFor` for why the
   * caller no longer decides PRESENCE on this prop.
   *
   * Off, `target` can still read `'shell'` — this is CHANGED from the first pass of this prop.
   * `resolveDockedTarget` (`lib/terminalTarget.ts`) only clamps a FRESH mount's own DEFAULT (no
   * `bottomOccupant`, no genuinely stored `'shell'` preference) down to `'cli'`; a GENUINE record —
   * `bottomOccupant` naming it, or a literally stored `'shell'` preference — survives, and is what
   * the disabled-shell EMPTY STATE (below) is drawn on instead of the silent CLI fallback the first
   * pass used. Reported (owner, 2026-09-18): with the switch off, the docked band went blank with a
   * RED refusal line and a retry button that could only ever repeat the same 403 — the empty state
   * this prop now drives replaces that with a neutral sentence plus a working way out. None of this
   * touches the STORED preference (`chooseTarget` is never called for it): re-enabling the switch
   * later must restore exactly what the person had chosen.
   *
   * Defaults to `true` — the `aside`/`dedicated` placements (`SessionsPage.tsx`) mount this
   * component only once the shell is already known to be available (`resolveForGates` never
   * resolves the right slot to `'shell'` while the switch is off, and the dedicated `?pane=shell`
   * route is itself gated on `shellEnabled` at that call site), so the default there is exactly
   * what those two call sites did before this prop existed. Those two placements never reach the
   * disabled-shell empty state by construction — see that state's own header.
   */
  shellEnabled?: boolean
  /**
   * MAY THIS MACHINE EVER SERVE A SHELL AT ALL — `CAPS.localShell` alone, the profile's answer,
   * never narrowed by the preference. Distinct from `shellEnabled` above (the COMBINED capable AND
   * preference reading) because the disabled-shell empty state has two different things to say:
   * "your own switch is off, here is how to turn it on" (buttons) when this is `true`, or "this
   * machine's profile denies it outright" (a sentence, no buttons — neither could ever succeed) when
   * it is `false`. Defaults to `true`, matching `shellEnabled`'s own default for the two placements
   * that never reach this branch.
   */
  shellCapable?: boolean
  /**
   * Called after "Enable now" or "Enable permanently" succeed, so the caller can re-read whatever
   * answers `shellEnabled` (`AppContext.refreshTeamSession`, which re-fetches `/api/team/session`) —
   * this band has no way to update that itself, and the Shell tab / the pane's own content must
   * catch up WITHOUT a reload the instant either button lands.
   */
  onShellEnabledChange?: () => void | Promise<void>
  /**
   * THE CENTRE COLUMN'S OWN MEASURED HEIGHT (design item 7) — what "full" resolves against, and
   * the ceiling `resolveBandHeight` reads. `docked` only: `dedicated`/`aside` already fill the
   * whole box they are given and have no drag handle to snap. Absent or `0` reads as "not measured
   * yet", which `resolveBandHeight` already treats as "never snap".
   */
  columnHeight?: number
  /**
   * THE BOTTOM SLOT'S OWN OPEN STATE, `slotLayout.bottomOpen` — `docked` only, and read ONCE, to
   * SEED this band's own `prefs.open` at mount. `StudioBand`/`SimpleDockedBand` take `open` as a
   * fully CONTROLLED prop (`SessionPanel.tsx` owns it outright); this band could not go that far
   * without also touching the shell-resolution reducer's own mount-time read of the same flag
   * (`useReducer`'s init function), so it stays a SEED rather than a controlled value — but a seed
   * is exactly what the bug needed. Found by the agent fixing the resize grip: with the band open
   * on the CLI, picking Shell left it open (this band stayed MOUNTED — `chooseTarget` alone, no
   * seed involved); but with the band open on STUDIO, picking Shell (or CLI) MINIMIZED it, needing
   * a second click. Studio and this band do not share a React instance, so the "open" the reader
   * was looking at was `StudioBand`'s own controlled `open` prop; the moment this band mounted in
   * its place, `useState(() => readBandPrefs(undefined, bandPane))` read the ONE shared `agentistics-shell-band`
   * record's `open` field cold, ignoring the `bottomOpen: true` `openPanel` had just written to the
   * slot the RENDER before — a stale `false` left over from whenever ANY panel in that band was
   * last collapsed (the field was never panel-scoped, unlike `full` — see `BandPrefs.full`'s own
   * header for the sibling bug this one is). `onOpenChange`, below, is the other half: it keeps
   * `slotLayout.bottomOpen` itself in step with whatever THIS band's own tab clicks or minimize
   * chevron do afterward, so the NEXT panel to take the slot reads a fresh answer in its turn.
   */
  open?: boolean
  /** Fired whenever this band's own open/collapsed state changes post-mount — see `open`'s own
   *  header. `SessionPanel.tsx` wires it straight to `setBottomOpen`. */
  onOpenChange?: (open: boolean) => void
}

export function ShellBand({
  sessionId, cwd, lang, theme, harness, placement = 'docked', onOpenFullscreen, fixedTarget, cliAvailable,
  barEntries, onBarPick, onBarDrop, onBarMove, studioSeen = true, bottomOccupant = null, shellEnabled = true,
  shellCapable = true, onShellEnabledChange,
  columnHeight = 0, open: openSeed, onOpenChange,
}: ShellBandProps) {
  /** The side of a split view this band belongs to — its prefs are kept per pane. */
  const bandPane = usePaneId()
  const t = TXT[lang]
  const isMobile = useIsMobile()
  const documentVisible = useDocumentVisible()

  // `dedicated` AND `aside` both fill whatever box they are given, with no bar of their own — see
  // the `placement` doc comment above. Kept as one boolean because every rule that follows from
  // "this is the whole box, not a collapsible band" is the same for both.
  const dedicated = placement === 'dedicated' || placement === 'aside'
  // SEEDED FROM `openSeed` WHEN GIVEN (docked placement) — see `seedBandOpen`'s own header. Read
  // ONCE, like `target` below is seeded from `bottomOccupant`: a fresh mount must show what the
  // slot was JUST told to do, never a stale flag the LAST panel in this band happened to leave
  // behind.
  const [prefs, setPrefs] = useState(() => seedBandOpen(readBandPrefs(undefined, bandPane), openSeed))
  /**
   * WHICH terminal this band is showing. It is the band's own state and not the session's, because
   * the band is now the door to BOTH panes: the header's `Conversa | Terminal` toggle is gone, a
   * session opens on its conversation, and choosing a terminal is choosing which one.
   *
   * SEEDED FROM `bottomOccupant` WHEN IT NAMES ONE, the stored preference otherwise — see that
   * prop's own doc comment for why: a fresh mount (this component swapping in for `StudioBand`)
   * must show what was just requested, not whatever this band happened to show last time it was up.
   * `resolveDockedTarget` (`lib/terminalTarget.ts`) applies on the way IN, never written back to
   * storage — a GENUINE record of `'shell'` survives even while disabled (so the disabled-shell
   * empty state below can explain it), and only a fresh mount's own invented DEFAULT is clamped to
   * `'cli'` — see that function's own header.
   */
  const [storedTarget, setTarget] = useState<TerminalTarget>(
    () => fixedTarget ?? resolveDockedTarget(bottomOccupant, readBandPrefs(undefined, bandPane).target, shellEnabled),
  )
  // The choice is server-side and lands after mount (or arrives from another device): follow it.
  useEffect(() => {
    if (fixedTarget) return
    return sharedBand().subscribe(() => {
      setTarget(resolveDockedTarget(bottomOccupant, readBandPrefs(undefined, bandPane).target, shellEnabled))
    })
  }, [fixedTarget, bottomOccupant, shellEnabled, bandPane])
  const target: TerminalTarget = fixedTarget ?? storedTarget
  const scope = targetScope(target)
  /**
   * EXCLUSIVITY WITH THE RIGHT SLOT (C3) — only the DOCKED placement needs this. This band's own
   * `target` (above) is a LOCAL preference, chosen through its own segmented control and never
   * written through `panelSlots.openPanel` except on an explicit click — so nothing stopped it going
   * on streaming (and capturing) the very pane the right slot had already taken, and nothing told it
   * to stop once that happened on its own, before any click. `dockedShowsTarget` is the one pure rule
   * (`panelSlots.ts`) both this band and the right slot's own render are ultimately judged against;
   * `dedicated`/`aside` never need it — `aside` IS the right slot's own placement, so there is
   * nothing else to exclude it FROM, and `dedicated` has no slot to conflict with.
   */
  const slotLayout = usePanelSlots().layout
  const excludedFromDocked = placement === 'docked' && !dockedShowsTarget(slotLayout, target)
  // A DEDICATED shell is open by definition — you navigated to a screen that is nothing else. The
  // stored `open` is the DOCKED band's state and must not decide it, or arriving here with the band
  // collapsed would show an empty screen with no way to fill it.
  const bandOpen = dedicated || prefs.open
  // THE MACHINE, not a pile of flags. See `shellBandState.ts` for the rule it enforces.
  // Reads the ALREADY-SEEDED `prefs.open` (computed just above, same render) rather than a second,
  // independent `readBandPrefs(undefined, bandPane)` call — two reads of the same flag at mount is two chances for
  // them to disagree about whether `openSeed` applies.
  const [band, dispatch] = useReducer(shellBandReducer, INITIAL_SHELL_BAND, init =>
    dedicated || prefs.open ? shellBandReducer(init, { type: 'openBand' }) : init)
  const shell = band.shell
  /**
   * RELEASE A LIVE SHELL'S LOCAL STATE the moment the switch narrows underneath a band that is
   * already showing one — `target` itself is deliberately left at `'shell'` (see its own doc
   * comment above), so this is not the narrowing `usableTarget` used to do; it is housekeeping.
   * Without it `band.shell` stays set, `streamId` keeps naming it, and `watching` keeps the stream
   * subscription open for a pane the render below no longer draws — a resource nobody can see kept
   * alive, the same class of leak `shellWatching`'s own unwatch discipline exists to close. `'ended'`
   * is the same local-only transition `close()` dispatches below; it does NOT call
   * `/api/shell/close` — a shell disabled here keeps running exactly as one does when the band is
   * merely collapsed (`closeBand`'s own rule), and reappears the moment the switch (or the "Enable
   * now" override) comes back.
   */
  useEffect(() => {
    if (!shellEnabled && target === 'shell' && shell) dispatch({ type: 'ended' })
  }, [shellEnabled, target, shell])
  const [ctrlArmed, setCtrlArmed] = useState(false)
  /** The terminal's last confirmation (a key sent, refused, a copy, a paste) — shown in the band's
   *  own sentence line, the one place every message this terminal gives appears, for 5 seconds. */
  const [keyNotice, setKeyNotice] = useState<TerminalNotice | null>(null)
  /** When the strip's first `ctrl`+`d` was pressed — the confirming second press must follow soon. */
  const stripEofAt = useRef<number | null>(null)
  useEffect(() => {
    if (!keyNotice) return
    const t = setTimeout(() => setKeyNotice(n => (n && n.at === keyNotice.at ? null : n)), 5000)
    return () => clearTimeout(t)
  }, [keyNotice])
  /** The open shells, fetched ONLY when the ceiling refuses — see `shellCeiling.ts`. */
  const [ceiling, setCeiling] = useState<{ rows: CeilingRow[]; cap: number } | null>(null)
  const [ctrlNote, setCtrlNote] = useState<string | null>(null)

  /** Choosing a terminal is remembered, so the band comes back on the one you were using. */
  const chooseTarget = useCallback((next: TerminalTarget) => {
    // A mount pinned to one pane never switches, and never rewrites the docked band's choice.
    if (fixedTarget) return
    setTarget(next)
    try { writeBandPrefs({ ...readBandPrefs(undefined, bandPane), target: next }, undefined, bandPane) } catch { /* storage blocked */ }
  }, [fixedTarget])

  /**
   * FOLLOW `bottomOccupant` FOR THE LIFE OF THE MOUNT, not only at the first frame — see that prop's
   * own doc comment. A move triggered from outside this band's own bar (`SessionPanel`'s "bring it
   * to the bottom" overflow entry) writes `panelSlots` directly and has no way to call `chooseTarget`
   * itself; without this effect `target` stayed on whatever it was, `dockedShowsTarget` kept judging
   * the OLD target against the (now cleared) right slot, and the band showed the wrong stream — or,
   * once the right slot cleared, `terminalStream.ts`'s generic "pick a live session" placeholder —
   * while the panel bar's own tab read correctly lit. Guarded so a `bottomOccupant` of `null` (the
   * panel moved AWAY from the bottom, or nothing has ever named an occupant) never overwrites a
   * choice the person made by clicking inside this band itself.
   *
   * TAKEN RAW, never through `usableTarget`/`resolveDockedTarget` — unlike a fresh mount's own
   * DEFAULT, `bottomOccupant` is never a guess: it is an explicit slot placement, so `'shell'` here
   * is always a GENUINE record and is exactly what the disabled-shell empty state is drawn on when
   * the switch is off. See `resolveDockedTarget`'s own header for the distinction.
   *
   * COMPARED AGAINST ITS OWN PREVIOUS VALUE, NEVER AGAINST `target` — that was the bug (owner
   * report: the mobile "Which terminal" segment could not be switched). `chooseTarget` (the
   * segment's own click handler, below) is entirely local — it never writes `panelSlots` — so
   * `bottomOccupant` sits exactly where it was on every ordinary tap, and judging it against
   * `target` read that as a fact to catch up to: the tap landed for one render and this same
   * effect, seeing the two disagree, called `chooseTarget(bottomOccupant)` right back. A person's
   * pick is authoritative until `bottomOccupant` ITSELF changes for another reason — see
   * `followBottomOccupant`'s own header (`lib/terminalTarget.ts`) for the rule, kept there and
   * unit-tested because this component mounts no DOM in this repo's test runner.
   * `prevBottomOccupantRef` is the one thing that tells "genuinely moved" apart from "still here,
   * a local pick just diverged from it".
   */
  const prevBottomOccupantRef = useRef(bottomOccupant)
  useEffect(() => {
    const prevBottomOccupant = prevBottomOccupantRef.current
    prevBottomOccupantRef.current = bottomOccupant
    const follow = followBottomOccupant(bottomOccupant, prevBottomOccupant, target)
    if (follow) chooseTarget(follow)
  }, [bottomOccupant, target, chooseTarget])

  /**
   * THE PANE ON SCREEN WAS FLOATED (`lib/floatingPanels.ts`) — it left for its own window, so the
   * band collapses rather than stand open over an empty screen. Deliberately NOT switched to the
   * other pane: switching to `shell` would open a shell nobody asked for. Docking back reopens it
   * here through `bottomOccupant`, like any other open of this slot.
   */
  const targetFloats = placement === 'docked' && (slotLayout.floating?.includes(target) ?? false)
  const setBandRef = useRef<((next: { open: boolean }) => void) | null>(null)
  useEffect(() => {
    if (targetFloats) setBandRef.current?.({ open: false })
  }, [targetFloats])

  const setBand = useCallback((next: Partial<{ open: boolean; height: number; full: boolean }>) => {
    setPrefs(p => {
      let merged: BandPrefs = { ...p }
      if (next.open !== undefined) merged.open = next.open
      if (next.height !== undefined) merged.height = next.height
      // FULL SCREEN IS A PROPERTY OF THE PANEL THIS BAND IS CURRENTLY SHOWING (`target`, 'cli' or
      // 'shell'), NOT OF THIS SLOT — `withBandPanelFull` touches only that one entry, leaving
      // whatever the Studio or Contents/Hardware left behind untouched, and vice versa. See
      // `BandPrefs.full`'s own header in `shellBand.ts`.
      if (next.full !== undefined) merged = withBandPanelFull(merged, target, next.full)
      writeBandPrefs(merged, undefined, bandPane)
      return merged
    })
    if (next.open === true) dispatch({ type: 'openBand' })
    if (next.open === false) dispatch({ type: 'closeBand' })
    // KEEP `slotLayout.bottomOpen` IN STEP — see `open`'s own header on `ShellBandProps`. Without
    // this, collapsing or restoring THIS band through its own chevron or tab only ever touched the
    // shared `agentistics-shell-band` record, leaving the NEXT panel to take the bottom slot (should
    // this one move or close) to seed itself from whatever `slotLayout.bottomOpen` was last told —
    // which, unsynced, is a second stale flag exactly like the one this fix already closed at mount.
    if (next.open !== undefined) onOpenChange?.(next.open)
  }, [target, onOpenChange])
  setBandRef.current = setBand

  /**
   * Resolve THIS session's shell: reuse the one already running for it, else open one.
   *
   * A shell lives until it is closed — it survives switching session, reloading the page and closing
   * the browser — so the list is asked first. Opening blind would mint a second shell per reload and
   * walk into the ceiling with seven copies of one directory.
   *
   * The effect is driven by ONE fact, `shellResolveWanted(band)`, and every exit dispatches: an
   * abandoned attempt goes back to `wanted` rather than leaving the band spinning on work nobody is
   * doing. That is the whole reason the machine exists — see `shellBandState.ts`.
   */
  // DEPENDS ON `band.attempt` AND NOT ON `band`. The effect dispatches, and an effect that depends
  // on what it dispatches cancels its own request on the very next render — the loop that made this
  // band spin on "Abrindo…". `attempt` moves only when a PERSON opens or retries.
  // Only the SHELL has to be resolved: the CLI pane IS the session and is already there. Asking
  // for one while the band is showing the other would mint a shell nobody opened.
  // EXCLUDED (C3): the right slot already resolves/streams this exact target, so the docked band
  // must not also open or reuse it — that is the second live reader `dockedShowsTarget` exists to
  // prevent.
  // `&& shellEnabled`: belt and suspenders alongside the two effects above that already keep
  // `target` off `'shell'` while the switch is off — a shell must never be opened or reused for a
  // request this band should not have been able to make in the first place.
  const wanted = shellResolveWanted(band) && target === 'shell' && shellEnabled && !excludedFromDocked
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  useEffect(() => {
    if (!wantedRef.current) return
    let cancelled = false
    dispatch({ type: 'resolving' })
    void (async () => {
      try {
        const listed = await fetch(shellApiUrl('/api/shell/list', lang))
        if (listed.ok) {
          const body = await listed.json() as { shells?: (OpenShell & { sessionId?: string })[] }
          const mine = (body.shells ?? []).find(sh => sh.sessionId === sessionId)
          if (mine) { if (!cancelled) dispatch({ type: 'resolved', shell: { id: mine.id, cwd: mine.cwd } }); return }
        } else {
          const body = await listed.json().catch(() => ({})) as { error?: string }
          if (body.error) { if (!cancelled) dispatch({ type: 'refused', message: shellErrorText(body.error, lang) }); return }
        }
        const res = await fetch(shellApiUrl('/api/shell/open', lang), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const body = await res.json().catch(() => ({})) as {
          ok?: boolean; shell?: OpenShell; message?: string; error?: string; reason?: string
        }
        if (cancelled) return
        // A REFUSAL arrives as a sentence the server composed; it is shown verbatim. A route-level
        // error carries only a code, and `shellErrorText` is the one place that words those.
        if (body.ok && body.shell) dispatch({ type: 'resolved', shell: body.shell })
        // The CODE travels with the sentence: only `at-cap` has anything to offer, and matching on
        // a localized sentence would stop working the day somebody rewords it.
        else if (body.message) dispatch({ type: 'refused', message: body.message, ...(body.reason ? { reason: body.reason } : {}) })
        else dispatch({ type: 'refused', message: shellErrorText(body.error ?? 'network', lang) })
      } catch {
        if (!cancelled) dispatch({ type: 'refused', message: shellErrorText('network', lang) })
      }
    })()
    // An abandoned attempt is NOT a failure and NOT a silence: it returns to `wanted`, so the next
    // render asks again instead of leaving a spinner over nothing.
    return () => { cancelled = true; dispatch({ type: 'cancelled' }) }
    // `target` IS a dependency, and leaving it out was a measured bug: a band opened on the CLI
    // pane skips the resolve, and switching to the shell moved nothing the effect watches — so the
    // request that had been skipped was never made and the shell never appeared. It is safe to
    // depend on because a PERSON moves it, unlike the dispatches this effect makes itself.
  }, [band.attempt, sessionId, lang, target])

  /**
   * THE CEILING IS THE ONE REFUSAL A PERSON CAN ACT ON, and until now it was the one with no
   * action: nothing in this product listed or closed a shell, so "close one to open another" sent
   * you looking through eight other sessions. The list is fetched only on that refusal — `?titles=1`
   * costs a fleet walk, and the names are what make the rows distinguishable when every shell of a
   * repository sits in the same directory.
   */
  useEffect(() => {
    if (!atCap(band.reason)) { setCeiling(null); return }
    let gone = false
    void (async () => {
      const body = await fetch(shellApiUrl('/api/shell/list', lang) + '&titles=1')
        .then(r => r.ok ? r.json() as Promise<{ shells?: CeilingShell[]; cap?: number }> : null)
        .catch(() => null)
      if (gone || !body) return
      setCeiling({ rows: ceilingRows(body.shells ?? []), cap: body.cap ?? 0 })
    })()
    return () => { gone = true }
  }, [band.reason, band.attempt, lang])

  /** End one of the OTHER shells, then ask again — the retry is the whole point of the list. */
  const closeOther = useCallback(async (id: string) => {
    setCeiling(c => (c ? { ...c, rows: c.rows.filter(r => r.id !== id) } : c))
    await fetch(shellApiUrl('/api/shell/close', lang), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {})
    dispatch({ type: 'retry' })
  }, [lang])

  // EXCLUDED (C3): never watch — never capture — a pane the right slot already shows. Without this
  // a move to the right left the docked band's own stream running: two live readers of one pane,
  // confirmed live as a second `GET /api/shell/stream?id=…` for the exact same shell.
  const watching = shellWatching({
    bandOpen,
    sessionSelected: Boolean(sessionId),
    documentVisible,
  }) && !excludedFromDocked
  /** The pane this band is watching: the session itself, or the shell it opened. `null` while a
   *  shell has not been resolved yet, which is what keeps the stream from asking for a blank. */
  const streamId = targetStreamId(target, { sessionId, shellId: shell?.id ?? null })
  // `null` is what DROPS the subscription — the client half of the unwatch discipline.
  // The remembered geometry rides the OPEN, so the pane is already this box's size on the first
  // frame instead of arriving at whatever width the last viewer left it — see `shellBand.ts`.
  const { state } = useTerminalStream(watching ? streamId : null, scope, bandGeometry(placement))
  const write = useTerminalWrite(streamId ?? '', watching && Boolean(streamId), lang, scope)
  // The honesty line must say WHOSE screen this is: "the agent's current screen" over a shell the
  // person opened themselves is simply false, and the reverse is just as wrong.
  const status = terminalStatus(state, lang, target === 'shell' ? 'shell' : 'session')
  /** A shell follows its box in BOTH directions — nothing in this product reads its screen. */
  const resizer = useMemo(
    () => createPaneResizer({ scope, id: streamId ?? '' }),
    [scope, streamId],
  )
  useEffect(() => () => resizer.cancel(), [resizer])
  /**
   * One measurement, two consumers: the pane is resized NOW (debounced) and the number is kept for
   * the NEXT open. Written straight to storage rather than through React state — the emulator
   * reports on every layout change, and a re-render of the whole panel for a number nothing on
   * screen shows would be a cost with no reader.
   */
  const onGeometry = useCallback((g: { cols: number; rows: number }) => {
    writeBandGeometry(placement, g)
    resizer.request(g)
  }, [resizer, placement])

  /**
   * One send path for everything.
   *
   * A strip press produces the same bytes a real keypress would (`keyBytes`) and goes through the
   * same `send`, so `splitInput`'s allowlist judges both identically — a key it would refuse cannot
   * reach the wire by a side door. `ctrl` is a STICKY modifier because a soft keyboard has no chord
   * to hold: it arms, and the next single character becomes the control key instead.
   */
  const send = useCallback((data: string) => {
    if (ctrlArmed) {
      setCtrlArmed(false)
      const key = ctrlKeyFor(data)
      if (!key) { setCtrlNote(t.ctrlRefused(data)); return }
      setCtrlNote(null)
      // The phone's session-ending guard — see `stripCtrlGuard`.
      const now = Date.now()
      const verdict = stripCtrlGuard(key, target === 'cli', stripEofAt.current, now)
      const tell = (kind: NoticeKind) => setKeyNotice({ text: guardNoticeText(kind, lang), tone: NOTICE_TONE[kind], at: now })
      if (verdict === 'blocked-interrupt') { tell('blocked-interrupt-strip'); return }
      if (verdict === 'arm-eof') { stripEofAt.current = now; tell('eof-arm-strip'); return }
      stripEofAt.current = null
      if (verdict === 'confirmed-eof') tell('confirmed-eof')
      write.send(keyBytes(key))
      return
    }
    write.send(data)
  }, [ctrlArmed, write, t, target, lang])

  /** A paste — from the native paste event OR the strip's own `paste` button — is one atomic
   *  message, never a keystroke, and cancels an armed ctrl the same way any other strip press
   *  would leave it hanging otherwise. */
  const sendPasteText = useCallback((text: string) => { setCtrlArmed(false); write.sendPaste(text) }, [write])
  const clipboardReadable = useMemo(() => clipboardPasteAvailable(), [])

  const pressStrip = useCallback((id: string) => {
    const entry = stripEntries(clipboardReadable).find(e => e.id === id)
    if (!entry) return
    if (entry.kind === 'modifier') { setCtrlNote(null); setCtrlArmed(a => !a); return }
    setCtrlArmed(false)
    if (entry.kind === 'paste') {
      // I1: a denied/blocked clipboard permission must not be the same silence as an empty
      // clipboard — `pasteFromClipboard`'s result says which one happened.
      void pasteFromClipboard(sendPasteText).then(result => {
        setCtrlNote(result === 'denied' ? t.pasteDenied : null)
      })
      return
    }
    write.send(keyBytes(entry.key))
  }, [write, clipboardReadable, sendPasteText, t])

  /**
   * THE X — ends this session's shell through `lib/shellClose.ts`, which says each step in words
   * (`ShellCloseStatus`) and reports whether it really ended. The band drops the shell only once the
   * server says it is gone (the effect below), never optimistically: a close that failed must leave
   * the shell on screen, still running, beside a sentence saying so.
   */
  const closeEntry = useShellClose(sessionId)
  const closing = closeEntry.flow.phase === 'closing'
  const close = useCallback(async () => {
    if (!shell) return
    await requestShellClose(sessionId, shellApiUrl('/api/shell/close', lang), shell.id)
  }, [shell, sessionId, lang])
  // Publish the shell this band holds, so a FLOATING window's header (drawn outside this component)
  // can offer the same X for it.
  useEffect(() => { publishLiveShell(sessionId, shell?.id ?? null) }, [sessionId, shell?.id])
  // The close landed (from this band's X or a floating header's): drop the shell it named. The docked
  // band also collapses, as the old gear row did — the result sentence stays readable in the bar.
  const endedSeen = useRef(closeEntry.ended)
  useEffect(() => {
    if (closeEntry.ended === endedSeen.current) return
    endedSeen.current = closeEntry.ended
    const f = closeEntry.flow
    if (f.phase !== 'done' || !closeEndsShell(f.outcome) || f.id !== shell?.id) return
    dispatch({ type: 'ended' })
    if (!dedicated) setBand({ open: false })
  }, [closeEntry, shell?.id, dedicated, setBand])

  /**
   * THE DISABLED-SHELL EMPTY STATE'S TWO BUTTONS.
   *
   * `enabling` is which one is in flight (`null` = neither) — a plain string rather than two
   * booleans, since only one request can be in flight at a time and a string says which button's
   * own label to swap for its busy word.
   *
   * Neither button changes `target` or calls `chooseTarget`: the STORED preference the person made
   * by picking "Shell" is already `'shell'` (that is what got them here), and `onShellEnabledChange`
   * is what makes `shellEnabled` catch up. That alone is NOT enough to open the shell, though — the
   * resolve effect below deliberately depends on `band.attempt` and NOT on `shellEnabled`, so a prop
   * flipping true while `band.phase` is already `'wanted'` (as it always is here: the empty state
   * only renders while `bandOpen`, and opening is what put the reducer in `'wanted'` in the first
   * place) changes nothing the effect is watching — MEASURED live: the tab relit, the empty state
   * unmounted, and the pane sat on "Abra um shell para ver a tela dele" forever, because `wanted`
   * had flipped true in `wantedRef` with no render left to notice it. So each button explicitly
   * dispatches `retry` on success — the same transition a refused band's own retry button uses,
   * `attempt + 1` and all — which is what actually asks again. That is what makes the shell open in
   * this same slot "without a page reload".
   */
  const [enabling, setEnabling] = useState<'now' | 'always' | null>(null)
  const enableNow = useCallback(async () => {
    if (enabling) return
    setEnabling('now')
    try {
      const res = await fetch(shellApiUrl('/api/shell/enable-now', lang), { method: 'POST' })
      if (res.ok) { await onShellEnabledChange?.(); dispatch({ type: 'retry' }) }
    } catch { /* the button stays put; nothing changed */ }
    finally { setEnabling(null) }
  }, [enabling, lang, onShellEnabledChange])
  const enablePermanently = useCallback(async () => {
    if (enabling) return
    setEnabling('always')
    try {
      // THE SAME DOOR Settings → Sessions uses (`PUT /api/preferences`) — never a second write path
      // for one preference, and never the "Enable now" override route, which deliberately does NOT
      // touch `preferences.json`.
      const res = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shellEnabled: true }),
      })
      if (res.ok) { await onShellEnabledChange?.(); dispatch({ type: 'retry' }) }
    } catch { /* the button stays put; nothing changed */ }
    finally { setEnabling(null) }
  }, [enabling, onShellEnabledChange])

  // ---- the drag handle (design item 7: free-resizing, snapping to full) -----------------------
  /** What is ACTUALLY on screen right now — `columnHeight` while `full`, `prefs.height` otherwise.
   *  A drag's start point has to be THIS, never the stored `prefs.height` alone: while full, that
   *  field is stale (see `BandPrefs.full`'s own doc comment), and starting the drag from it would
   *  have the band jump the instant the pointer moved at all. */
  const renderedHeight = bandPanelFull(prefs, target) && columnHeight > 0 ? columnHeight : prefs.height
  // THE SAME SHARED `useBandDrag` (`bandControls.tsx`) `StudioBand`/`SimpleDockedBand` drive their
  // own handle through. `enabled: !isMobile` reproduces this band's own former `if (isMobile) return`
  // guard — the mobile sheet renders no handle at all (see the `dedicated`/mobile branches below), so
  // there is nothing for the listeners to serve there. `onFullscreen` is OMITTED, never a bare
  // callback, when this placement offers no dedicated screen to escalate to (`onOpenFullscreen`
  // absent) — past the overshoot this band has no overlay of its own to switch into (unlike the
  // Studio's `position: fixed` full screen), so the SAME gesture escalates to this pane's DEDICATED
  // screen instead, when the caller offers one — the identical "past here, nothing short of the whole
  // thing will do" reading, aimed at whichever full screen this band actually has.
  const grip = useBandDrag({
    renderedHeight, columnHeight, enabled: !isMobile,
    apply: next => setBand({ height: next.height, full: next.full }),
    ...(onOpenFullscreen ? { onFullscreen: () => onOpenFullscreen(target) } : {}),
  })
  // THE WHOLE BAND IS A DROP TARGET NOW, not just its own tab strip — see `useBandDropTarget`'s own
  // header for the bug this fixes.
  const bandDrop = useBandDropTarget(onBarDrop)

  /**
   * THE ONE CONTROL THAT PICKS A TERMINAL. It replaced the header's `Conversa | Terminal` toggle —
   * a session opens on its conversation, and this band is the door to both panes. The CLI segment
   * is named after the HARNESS, so it names what is on the screen instead of a concept.
   *
   * `shell: shellEnabled` — the mobile segment's own gate, mirroring `panelBarEntries`' `shell`
   * entry on the docked bar: with the switch off, the Shell tab is simply absent here too, never
   * present and refusing.
   */
  const targetSwitch = (
    <BandSegment label={t.whichTerminal} isMobile={isMobile}>
      {bandSegmentEntries(target, { cli: cliAvailable !== false, shell: shellEnabled, studio: false }).map(({ id, on }) => (
        <BandSegmentTab
          key={id}
          on={on}
          isMobile={isMobile}
          // Collapsed, picking a target is also the gesture that OPENS the band — the segment is
          // the door, so it must not need a second click on the bar behind it.
          onClick={e => {
            e.stopPropagation()
            chooseTarget(id as TerminalTarget)
            if (!bandOpen) setBand({ open: true })
          }}
          label={targetLabel(id as TerminalTarget, harness, lang)}
        />
      ))}
    </BandSegment>
  )

  /**
   * THE ONE PANEL BAR (design item 1) — replaces the docked band's former "Claude Code | Shell |
   * Studio" segment (`dockedTargetSwitch`, before this pass). `barEntries`/`onBarPick` come from
   * `SessionPanel`, which is what lets `StudioBand` render the exact same bar and the two never
   * disagree about what is lit or what clicking it does.
   *
   * The only thing THIS band adds around the shared handler is what makes cli/shell its OWN local
   * concern rather than something `panelSlots.ts` can decide alone: `target` is chosen through this
   * segment and never written back except on an explicit pick (see `target`'s own doc comment), so
   * picking the tab that is not currently showing must ALSO flip this band's local state and open it
   * if collapsed — the exact two things the old `dockedTargetSwitch` did by hand. A tab that IS
   * already lit is left to the shared handler alone: if it is lit because it sits on the RIGHT
   * instead, the handler closes it there, which needs no local state change.
   *
   * RESTORING FROM A COLLAPSED BAND IS THIS SAME TAB'S OWN CLICK, never a second control — clicking
   * the already-lit tab of THIS band's own occupant, while collapsed, re-expands it, the exact
   * inverse of the collapse chevron and consistent with the Studio's own restore-from-minimized
   * reading in `SessionPanel.tsx`'s `onPanelBarPick`.
   */
  const handleBarPick = useCallback((id: PanelBarId) => {
    // A MINIMIZED WINDOW's tab restores that window and touches nothing in this band.
    if (barEntries?.find(e => e.id === id)?.minimized) { onBarPick?.(id); return }
    if ((id === 'cli' || id === 'shell') && !barEntries?.find(e => e.id === id)?.on) {
      chooseTarget(id)
      if (!bandOpen) setBand({ open: true })
      onBarPick?.(id)
      return
    }
    if (id === target && bottomOccupant === id && !bandOpen) {
      setBand({ open: true })
      return
    }
    // THE OPEN TAB, CLICKED AGAIN: minimize, like the right rail (`resolvePanelBarPick`'s
    // `'minimize'`). This band keeps its own open state, so it collapses itself here — the same
    // `setBand({ open: false })` its own chevron runs — rather than leaving it to the shared handler.
    if ((id === 'cli' || id === 'shell') && id === target && bandOpen && !dedicated) {
      setBand({ open: false })
      return
    }
    onBarPick?.(id)
  }, [barEntries, onBarPick, chooseTarget, bandOpen, setBand, target, bottomOccupant, dedicated])
  /** The bar's OWN measured width (design item 7), never the window's — see `useElementWidth`'s
   *  own header on why. */
  const [barWidthRef, barWidth] = useElementWidth()
  const compact = bandBarCompact(barWidth)
  const panelBar = barEntries !== undefined && (
    <PanelBar
      entries={barEntries} lang={lang} studioSeen={studioSeen} harness={harness} onPick={handleBarPick}
      compact={compact}
      {...(onBarDrop ? { onDrop: onBarDrop } : {})}
      {...(onBarMove ? { onMove: onBarMove } : {})}
    />
  )
  /**
   * THE GEAR — Move/End shell, each keeping its full label inside the menu (only the TRIGGER is
   * compact). Full screen moved OUT of this menu (2026-09-19) into `PanelFixedControls`' own fixed
   * button, below — see that component's header for why.
   *
   * "MOVE" GOES THROUGH THE ONE SHARED BUILDER (`lib/panelMenu.ts`) — the same function
   * `Studio.tsx`'s own gear uses, so "Mover Claude Code para a direita" / "Mover Shell para a
   * direita" can never disagree with what that menu says for the SAME gesture elsewhere. "End
   * shell" stays THIS component's own concern — a destructive action about the actual process,
   * unrelated to placement, which is why it was never part of that builder's vocabulary (see
   * `panelMenu.ts`'s own header on why `close` is the Studio's one exception).
   *
   * ALL OF THIS IS GATED ON `prefs.open` — collapsed, there is nothing visible for any of these
   * three to act on, so the gear itself goes ABSENT (`BandOverflowMenu`'s own empty-entries rule)
   * rather than opening onto rows about a pane the reader cannot currently see.
   */
  // MOVE IS GONE FROM THIS GEAR ON DESKTOP ONLY (addendum, 2026-09-21) — it now lives on the BAR
  // TAB's own right-click menu (`PanelBar`'s `onMove`, wired below), reachable for exactly the same
  // panel this gear is about. ON MOBILE it STAYS: there is no rail to right-click and no reliable
  // `contextmenu` gesture on a touch device, and spec §8 already states the rule this follows ("the
  // gear menu covers those verbs there") — the same fix `Studio.tsx`'s own gear needed for the exact
  // same reason (reproduced live: stripping this unconditionally left NO way to move Claude Code's
  // pane on a phone at all). `onBarMove` already IS "move to rail" for any panel id, so it is reused
  // rather than re-deriving the same action a second way.
  const moveEntry = isMobile && prefs.open && onBarMove ? panelMenuEntries({
    panel: target, placement: 'bottom', lang, panelName: targetLabel(target, harness, lang),
  }).find(e => e.id === 'move-right') : undefined
  const gearEntries: BandOverflowEntry[] = [
    ...(moveEntry ? [{
      id: moveEntry.id, label: moveEntry.label, icon: panelMenuIconFor(moveEntry.iconId),
      onSelect: () => onBarMove!(target),
    }] : []),
    // "END THIS SHELL" LEFT THIS GEAR (owner, 2026-09-29) — it is the X beside minimize now,
    // drawn only while there is a shell to end (`closeControl`, below).
  ]
  const closeControl = shell && target === 'shell'
    ? { onClose: () => { void close() }, busy: closing }
    : undefined
  /**
   * THE FIXED FULL-SCREEN BUTTON — "navigate to the dedicated screen" (`onOpenFullscreen`), a
   * different question from the Studio's in-place overlay (`fullscreenModeFor(target) ===
   * 'navigate'`, `lib/panelMenu.ts`). The LABEL names whichever pane THIS band is actually showing
   * (`target`) — never a fixed "shell" sentence, which is what sent a reader pressing this while
   * reading the Claude Code pane to the shell's own screen instead. See `paneForTarget`'s own
   * header. Absent while collapsed, same reasoning as the gear above.
   */
  const fullscreenControl = prefs.open && streamId && onOpenFullscreen
    ? { active: false, onToggle: () => onOpenFullscreen(target) }
    : undefined

  const where = shellWhere(cwd)

  /**
   * THE DISABLED-SHELL EMPTY STATE (design follow-up, owner report 2026-09-18) — drawn INSTEAD of
   * `screen` whenever `target === 'shell'` genuinely, but `shellEnabled` says it cannot be shown.
   * `resolveDockedTarget` is what keeps this UNREACHABLE on a fresh session that never asked for
   * the shell (see that function's own header) — this branch fires only for the case design item 2
   * describes: "the person had the shell open, then turned it off."
   *
   * NEUTRAL, never the refusal red `notice` uses for a real 403 — this is not an error, it is a
   * standing fact about this machine's settings, and it is offering a way out rather than reporting
   * a failure. `shellCapable` picks between the two sub-states: the ordinary preference-off reading
   * (a sentence plus both buttons) and the profile-denies-it-outright reading (a sentence alone,
   * because neither button could ever succeed against `CAPS.localShell`).
   */
  const shellUnavailable = shellTargetUnavailable(target, shellEnabled)
  // EXCLUDED (C3) still wins: a pane genuinely showing on the right is a different fact from one
  // that cannot be shown at all, and `t.openOnRight`'s own sentence already covers it.
  const showShellDisabled = shellUnavailable && !excludedFromDocked
  const shellDisabledPane = (
    <div style={{
      position: 'relative', flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden',
      border: '1px solid var(--border-subtle)',
      background: theme === 'light' ? '#ffffff' : '#0e1116',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      {/* THE BRAND MARK, behind the sentence — reused verbatim from `Studio.tsx`'s own empty tree:
          one asset, painted through a mask in `currentColor` so it never needs a light/dark twin,
          `aria-hidden` and low opacity so it never competes with the text sitting on it. */}
      <Watermark />
      <div style={{
        position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', textAlign: 'center', gap: 12, maxWidth: 380,
      }}>
        <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>
          {t.shellOffTitle}
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          {shellCapable ? t.shellOffBody : t.shellOffCapability}
        </div>
        {/* NO BUTTONS when the CAPABILITY itself is off — neither could ever succeed, and a button
            whose one outcome is a refusal is worse than none. */}
        {shellCapable && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              type="button"
              onClick={() => { void enableNow() }}
              disabled={enabling !== null}
              style={{
                minHeight: 32, padding: '0 14px', borderRadius: 7, cursor: enabling ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 12, fontWeight: 650, border: '1px solid var(--anthropic-orange)',
                background: 'var(--anthropic-orange)', color: '#fff',
                opacity: enabling && enabling !== 'now' ? 0.6 : 1,
              }}
            >
              {enabling === 'now' ? t.enableNowBusy : t.enableNow}
            </button>
            <button
              type="button"
              onClick={() => { void enablePermanently() }}
              disabled={enabling !== null}
              style={{
                minHeight: 32, padding: '0 14px', borderRadius: 7, cursor: enabling ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 12, fontWeight: 650,
                border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                color: 'var(--text-secondary)',
                opacity: enabling && enabling !== 'always' ? 0.6 : 1,
              }}
            >
              {enabling === 'always' ? t.enablePermanentlyBusy : t.enablePermanently}
            </button>
          </div>
        )}
      </div>
    </div>
  )

  const screen = (
    <div style={{
      flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden',
      border: '1px solid var(--border-subtle)',
      background: theme === 'light' ? '#ffffff' : '#0e1116',
    }}>
      <Suspense fallback={<div style={{ padding: 12, fontSize: 12, fontFamily: 'monospace', color: 'var(--text-tertiary)' }}>
        {lang === 'pt' ? 'Carregando o emulador…' : 'Loading the emulator…'}
      </div>}>
        {/* key={shell.id}: a new shell gets a brand-new emulator, so no content leaks across. */}
        <SessionTerminal
          key={streamId ?? 'none'}
          frame={state.frame}
          theme={theme}
          showCursor={status.showCursor}
          interactive={write.ready}
          onInput={send}
          onPaste={sendPasteText}
          onGeometry={streamId ? onGeometry : undefined}
          lang={lang}
          // Ctrl+C ends an ASSISTANT's session; in the utility shell it only stops a command.
          guardInterrupt={target === 'cli'}
          onNotice={setKeyNotice}
        />
      </Suspense>
    </div>
  )

  /** The one sentence the band always has: a refusal, a delivery failure, or what is on screen.
   *  EXCLUDED (C3) overrides all of it — the pane is not connecting or idle, it is simply showing
   *  somewhere else, and `status.detail` (built from an `idle`, un-watched stream) would otherwise
   *  say "No session"/"No shell" about a pane that is very much open, just not here. */
  const keyTone = keyNotice && !excludedFromDocked ? keyNotice.tone : null
  const line = excludedFromDocked
    ? (slotLayout.floating?.includes(target) ? t.floatingElsewhere : t.openOnRight)
    : keyNotice ? keyNotice.text
    : band.message ?? (write.reason ? write.reason : band.phase === 'opening' ? t.opening : status.detail)
  const lineIsBad = Boolean(band.message || write.reason)
  const busy = band.phase === 'opening'

  const notice = (
    <div
      role={lineIsBad ? 'status' : undefined}
      style={{
        fontSize: 11, lineHeight: 1.5, flexShrink: 0,
        // A terminal confirmation (`keyNotice`) outranks the band's standing sentence while it lasts,
        // and reads in its own tone: plain, a refusal in orange, a session-ending key sent in red.
        color: keyTone === 'danger' ? 'var(--accent-red)'
          : keyTone === 'warn' ? 'var(--anthropic-orange)'
          : keyTone === 'info' ? 'var(--text-secondary)'
          : lineIsBad ? 'var(--accent-red)' : 'var(--text-tertiary)',
      }}
    >
      {ctrlArmed ? t.ctrlHint : ctrlNote ?? line}
      {/* A refusal is a DEAD STOP by design — the band never retries a "no" on its own — so the way
          forward has to be on screen. Without it a refused band is a sentence and nothing else. */}
      {band.phase === 'refused' && !atCap(band.reason) && (
        <button
          onClick={() => dispatch({ type: 'retry' })}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8,
            minHeight: isMobile ? 44 : 22, padding: isMobile ? '0 12px' : '0 8px',
            borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
            border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
          }}
        >
          <RotateCcw size={11} />
          {t.retry}
        </button>
      )}
    </div>
  )

  /**
   * THE WAY OUT OF THE CEILING. `at-cap` used to be a sentence and nothing else; this is the list
   * the sentence was telling you to go and find. Each row NAMES its session (the directory alone
   * does not separate them — a repository's shells all sit in the same one) and carries the handle,
   * so two rows that still read alike are told apart by something.
   */
  const ceilingList = ceiling && atCap(band.reason) && target === 'shell' ? (
    <div style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
      maxHeight: isMobile ? 260 : 180, overflowY: 'auto',
      padding: 8, borderRadius: 8,
      border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>
        {ceilingTitle(ceiling.cap, lang)}
      </div>
      {ceiling.rows.map(row => (
        <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{row.title}</div>
            <div style={{
              fontSize: 10.5, color: 'var(--text-tertiary)', fontFamily: 'monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{row.short}{row.where ? ` · ${row.where}` : ''}</div>
          </div>
          <button className="ag-tap-icon"
            onClick={() => { void closeOther(row.id) }}
            title={t.endThis}
            aria-label={`${t.endThis} — ${row.title}`}
            style={{
              // PAINTED small, TARGETED at 44px by `.ag-tap-icon` — the repo's rule, and the one
              // this list must not break: a row of 44px squares turns a compact list into a column
              // of boxes, while the finger still needs the 44.
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              width: 26, height: 26,
              borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'transparent',
              color: 'var(--text-tertiary)',
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  ) : null

  const strip = (
    <div style={{
      display: 'flex', gap: 6, flexShrink: 0, overflowX: 'auto',
      paddingBottom: 'var(--safe-bottom)',
    }}>
      {stripEntries(clipboardReadable).map(entry => {
        const armed = entry.kind === 'modifier' && ctrlArmed
        return (
          <button
            key={entry.id}
            onClick={() => pressStrip(entry.id)}
            aria-pressed={entry.kind === 'modifier' ? ctrlArmed : undefined}
            style={{
              // 44px is the MOBILE figure, and this strip exists only on mobile.
              minWidth: 44, minHeight: 44, flexShrink: 0,
              borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 14, fontWeight: 600,
              border: `1px solid ${armed ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
              background: armed ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
              color: armed ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {stripKeyLabel(entry.id)}
          </button>
        )
      })}
    </div>
  )

  // ---- dedicated / aside: the shell fills the whole box it is given -----------------------------
  // No bar, no drag handle, no collapsed state: `dedicated` because you navigated to a screen that
  // is nothing else, `aside` because the right slot's own switcher and close are the way out. The
  // key strip follows `keyStripShown` — a phone has no ctrl key, and `dedicated` is the placement a
  // phone always gets (`aside` is desktop-only — see §1.6, the right slot opens as `dedicated` on a
  // phone instead).
  if (dedicated) {
    return (
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {showShellDisabled ? shellDisabledPane : (
          <>
            {streamId ? screen : target === 'shell' && band.phase === 'closed' ? (
              // ENDED HERE (the X, or `exit`): say so and offer a new one — a blank box after a close
              // reads as a pane that failed to load.
              <div style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 10, fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', padding: 16,
              }}>
                <span>{lang === 'pt' ? 'Este shell foi encerrado.' : 'This shell has ended.'}</span>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'retry' })}
                  style={{
                    minHeight: isMobile ? 44 : 28, padding: '0 12px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)',
                    fontFamily: 'inherit', fontSize: 12,
                  }}
                >{lang === 'pt' ? 'Abrir um novo shell' : 'Open a new shell'}</button>
              </div>
            ) : <div style={{ flex: 1 }} />}
            {notice}
            {ceilingList}
          </>
        )}
        {!showShellDisabled && keyStripShown('dedicated', isMobile) && strip}
      </div>
    )
  }

  // ---- mobile: a full-screen sheet over the session --------------------------------------------
  if (isMobile) {
    if (!prefs.open) {
      // The door to BOTH terminals, and the SAME control the open band carries — the segmented
      // tablist, on the right. A phone has no header toggle to fall back on, so this bar is the
      // only way to a terminal; it may not be a control that changes shape between states.
      return (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          minHeight: 44, padding: '0 12px', flexShrink: 0,
          borderTop: '1px solid var(--border)', background: 'var(--bg-surface)',
        }}>
          <span style={{ color: 'var(--anthropic-orange)', display: 'inline-flex', flexShrink: 0 }}>
            <TerminalSquare size={16} />
          </span>
          {where && <span style={{
            minWidth: 0, flex: 1, fontSize: 11, color: 'var(--text-tertiary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{where}</span>}
          {!where && <span style={{ flex: 1 }} />}
          <ShellCloseStatus sessionId={sessionId} lang={lang} />
          {targetSwitch}
        </div>
      )
    }
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg-base)',
        paddingTop: 'var(--safe-top)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 10px',
          borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0,
        }}>
          <button
            onClick={() => setBand({ open: false })}
            aria-label={t.back}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 44, height: 44, flexShrink: 0, marginLeft: -6,
              border: 'none', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >
            <ChevronLeft size={20} />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>
              {targetLabel(target, harness, lang)}
            </div>
            {where && <div style={{
              fontSize: 10.5, color: 'var(--text-tertiary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{where}</div>}
            <ShellCloseStatus sessionId={sessionId} lang={lang} />
          </div>
          {shell && target === 'shell' && (
            <button
              type="button"
              onClick={() => { void close() }}
              disabled={closing}
              aria-busy={closing}
              aria-label={t.close}
              title={t.close}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 44, height: 44, flexShrink: 0,
                border: 'none', background: 'transparent', color: 'var(--text-tertiary)',
                cursor: closing ? 'progress' : 'pointer', ...(closing ? { opacity: 0.5 } : {}),
              }}
            >
              <X size={18} />
            </button>
          )}
        </div>
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
        }}>
          {/* RIGHT, like every other placement's. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>{targetSwitch}</div>
          {showShellDisabled ? shellDisabledPane : (
            <>
              {/* EXCLUDED (C3): never render the screen for a target the right slot already shows —
                  see `excludedFromDocked` above. */}
              {streamId && !excludedFromDocked ? screen : <div style={{ flex: 1 }} />}
              {notice}
              {ceilingList}
              {strip}
            </>
          )}
        </div>
      </div>
    )
  }

  // ---- desktop: its own panel, below the conversation ---------------------------------------
  return (
    <>
      {/* THE GAP IS THE HANDLE (`sdd/brief.md`) — a SIBLING BEFORE the band's own bordered box,
          never its first child: this band is its own floating panel now, not docked inside the
          conversation's card. See `BandResizeHandle`'s own header in `bandControls.tsx` and
          `StudioBand`'s identical fragment split. `role="separator"`, takes the arrow keys, so the
          band is resizable without a pointer. Present whenever the panel exists; the drag itself
          only applies while `prefs.open` (a no-op otherwise, matching the old ABSENT-while-collapsed
          reading — nothing on screen to resize). */}
      <BandResizeHandle
        label={t.resize}
        {...(prefs.open ? grip : { onMouseDown: () => {}, onTouchStart: () => {}, onKeyDown: () => {} })}
      />
      <div
        ref={bandDrop.ref}
        style={{
        // FULL (design item 7) is an EXPLICIT PIXEL HEIGHT, never `flex: '1 1 auto'` — see
        // `resolveBandDrag`'s own header in `shellBand.ts` for the bug that shape was: two
        // `flex-grow: 1` siblings (this root and the conversation's own `flex: 1` above it) split the
        // column by CONTENT size rather than handing the whole thing to the one that asked to fill it,
        // so the band silently rendered at roughly half the column instead of all of it. `renderedHeight`
        // already resolves to the measured `columnHeight` while THIS panel's own `full` entry is
        // true, and the content box below spends it via its own `flex: '1 1 auto'` — never both on
        // the same box. Gated on `prefs.open`: collapsed, this must stay auto-sized to its header
        // row alone.
        ...(prefs.open && bandPanelFull(prefs, target) ? { height: renderedHeight, flexShrink: 0 } : { flexShrink: 0 }),
        display: 'flex', flexDirection: 'column',
        // FLOATING-PANELS DESIGN — its own border+radius+clip. ShellBand's own "full screen" is a
        // NAVIGATION to the dedicated terminal route (`onOpenFullscreen`), never an inline
        // `position: fixed` overlay of this box, so unlike `StudioBand`/`SimpleDockedBand` there is
        // no fullscreen state to skip this for here.
        border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
        ...(bandDrop.dropHighlight ? { boxShadow: 'inset 0 0 0 2px var(--anthropic-orange)' } : {}),
        background: 'var(--bg-surface)',
      }}>
      {/* THE COMPACT BAR (design item 7): panel segment (icon+label, collapsing to icons below
          ~1100px) · spacer · the FIXED trio (full screen, minimize, gear). Everything that used to
          widen this row on its own — the leading terminal icon, the uppercase target name, the
          `where` path, and Move/Full screen/End shell as their own labelled buttons — is gone or
          moved into the fixed controls: the target name and the `where` path are redundant with the
          segment's own lit tab (which already names Claude Code/Shell), and the actions the gear
          still carries keep their labels inside it instead of spending width on the row. THE FIXED
          TASK CONTROL THAT USED TO LEAD THIS ROW IS GONE (owner, 2026-09-21: "pode remover o icone
          fixo de tarefas tbm... pq agora temos na barra da direita") — `tasks` is a rail-capable
          panel now, so a second, always-on shortcut to it was the one control left standing once a
          reader emptied this band by moving everything to the rail.

          THE BAR NO LONGER TOGGLES ON ITS OWN CLICK (owner, 2026-09-19: "remove o clique na barra
          pra minimizar e reabrir... vamos manter no botão"). It used to be `role="button"` over the
          whole strip — a wide, easy target, but also a click a reader could land on by accident
          while reaching for the segment. The dedicated chevron inside `PanelFixedControls` is now
          the ONLY way to collapse or reopen this band. */}
      <div
        ref={barWidthRef}
        {...(where ? { title: where } : {})}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', minHeight: 32,
        }}
      >
        {/* PIN = FLOAT (`lib/floatingPanels.ts`), LEADING THE ROW (owner, 2026-09-29: "antes da
            primeira aba") — the pane on screen (Claude Code or Shell) becomes a window; desktop
            only, since nothing floats on a phone. */}
        {!isMobile && placement === 'docked' && !targetFloats && (
          <PanelPinButton
            lang={lang}
            panelName={targetLabel(target, harness, lang)}
            pinned={{ active: false, onToggle: () => floatPanel(target) }}
          />
        )}
        {panelBar}
        {busy && <Loader2 size={13} className="ag-spin" style={{ color: 'var(--text-tertiary)' }} />}
        <span style={{ flex: 1 }} />
        <ShellCloseStatus sessionId={sessionId} lang={lang} />
        <PanelFixedControls
          lang={lang}
          panelName={targetLabel(target, harness, lang)}
          {...(fullscreenControl ? { fullscreen: fullscreenControl } : {})}
          collapsed={!prefs.open}
          onMinimize={() => setBand({ open: !prefs.open })}
          minimizeLabel={prefs.open ? t.collapse : t.expand}
          {...(closeControl ? { close: closeControl } : {})}
          gearLabel={lang === 'pt' ? 'Mais ações' : 'More actions'}
          gearEntries={gearEntries}
        />
      </div>
      {prefs.open && (
        <div style={{
          ...(bandPanelFull(prefs, target)
            ? { flex: '1 1 auto', minHeight: 0 }
            : { height: Math.max(BAND_MIN_PX, renderedHeight), flexShrink: 0 }),
          display: 'flex', flexDirection: 'column', gap: 6, padding: '0 12px 10px',
        }}>
          {showShellDisabled ? shellDisabledPane : (
            <>
              {/* EXCLUDED (C3): the right slot already shows this exact target — see
                  `excludedFromDocked` above. Never render the screen for it here too. */}
              {streamId && !excludedFromDocked ? screen : <div style={{ flex: 1 }} />}
              {notice}
              {ceilingList}
            </>
          )}
        </div>
      )}
      </div>
    </>
  )
}
