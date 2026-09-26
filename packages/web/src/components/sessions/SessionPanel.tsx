/**
 * SessionPanel — one selected session, as a terminal or as a conversation.
 *
 * The two views answer different questions and neither replaces the other. The TERMINAL is the
 * whole truth: everything the assistant draws, tool output included, and the only place a dialog
 * can be answered. The CHAT is the readable half: what was actually said, with the box drawing and
 * the status strip gone.
 *
 * So the toggle is per session and it defaults to CHAT where a chat can exist and to TERMINAL where
 * it cannot. Where it cannot, the Chat segment is ABSENT rather than disabled — a control that is
 * present and refuses teaches nothing, while its absence plus the sentence in the panel says which
 * harnesses can do this and why yours cannot.
 *
 * ON DESKTOP this panel draws NO header of its own any more — the title, the Chat/Terminal tabs and
 * the "···" actions moved UP into the shared sticky header in `App.tsx`, right below the fleet's
 * filter bar. Two bordered strips stacked on top of each other said the same thing twice; one strip
 * is the whole point of sharing a header with the filters at all. `view`/`onViewChange` being
 * PROVIDED is the signal that the caller is showing that shared header (desktop): this component
 * then reads the view instead of owning it and renders no header. On MOBILE, where the shared header
 * is hidden for lack of room, this panel is still fully self-contained — `SessionsPage`'s mobile
 * branch passes neither prop, and the header below returns.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { getCentralMachine } from '../../lib/centralMachinePick'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useElementWidth } from '../../hooks/useElementWidth'
import { useViewportWidth } from '../../hooks/useViewportWidth'
import {
  bottomPanels, resolveForViewport, useRailWidth, usePanelSlots, type PanelDropTarget, type PanelId,
} from '../../lib/panelSlots'
import { panelTitle } from '../../lib/panelMeta'
import { hasDragPayload } from '../../lib/dragReorder'
import { useLeftAsideEdge } from '../../lib/leftAsideEdge'
import { fullscreenInsetRight, useRightAsideEdge } from '../../lib/rightAsideEdge'
import {
  bandBarCompact, bottomBandFor, gatedBottomOccupant, panelBarEntries, resolvePanelBarPick,
  type PanelBarEntry, type PanelBarGates, type PanelBarId,
} from '../../lib/panelBar'
import type { TerminalTarget } from '../../lib/terminalTarget'
import { RelayedScreen } from './RelayedScreen'
import { RelayedComposer } from './RelayedComposer'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import type { FleetActionId, FleetRow } from '../../lib/fleet'
import { TerminalRegion } from '../RecentSessions'
import { SessionChat, type SessionChatProps } from './SessionChat'
import { SessionActions } from './SessionActions'
import { ShellBand } from './ShellBand'
import {
  BAND_MIN_PX, bandPanelFull, readBandPrefs, resolveBandDrag, resolveBandHeight, withBandPanelFull,
  writeBandPrefs,
} from '../../lib/shellBand'
import {
  BAND_CONTROL_H, BandResizeHandle, PanelBar, PanelFixedControls, useBandDrag, useBandDropTarget,
  type BandOverflowEntry,
} from './bandControls'

export type SessionView = 'chat' | 'terminal'

/**
 * THE ONE "cover the whole viewport in place" full-screen overlay z-index — below every modal
 * (`ConfirmModal` is 2000, `primitives.tsx`), ABOVE the sticky header it is deliberately covering.
 * Used by `StudioBand` and, as of 2026-09-19 (`fullscreenModeFor`'s own `'overlay'` mode), by the
 * new Contents/Hardware bottom bands here AND by `SessionsPage.tsx`'s own right-slot overlay — one
 * constant, so a panel reads the identical stacking whichever slot or band it is fullscreened from.
 *
 * MEASURED, not guessed: `TopBar.tsx`'s own header is `position: fixed` at `zIndex: 300` — a plain
 * `90` sat visually BEHIND it despite `getBoundingClientRect()` confirming the full-screen box
 * really did cover `{0, 0, 1440, 900}`; `document.elementFromPoint()` on the header's own row
 * answered with the header, not the band, which is what "full screen" covering everything except
 * the one bar it most needed to cover looks like. `320` clears the header with room to spare while
 * staying under the first ordinary dialog tier (`SessionDrilldownModal` and friends start at 350).
 */
export const PANEL_FULLSCREEN_Z = 320

export interface SessionPanelProps {
  session: ControlSession
  /** The shaped row, for the terminal's own composer and verb list. */
  row?: FleetRow
  lang: 'pt' | 'en'
  theme: 'dark' | 'light'
  act: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  authorName?: string
  /** Called after a verb that removes the row — the panel has nothing left to show. */
  onGone?: () => void
  /**
   * A verb REPLACED this session with another — go to it.
   *
   * Reopening mints a NEW managed id for the same conversation, retires the row it replaced, and
   * `collapseSupersededSessions` then drops the old row from the fleet entirely. Without this the
   * panel stays selecting an id that no longer resolves: it empties, and every button on it acts on
   * a row the server cannot find. Reported as "reabri uma sessão fechada e não me permitia stopar
   * ela". `SessionActions` has always answered with the new id; only this surface was not listening.
   */
  onOpened?: (id: string) => void
  /** Provided together — see the module header. Their presence means "a shared header up in
   *  App.tsx already shows the title/tabs/actions for this session; draw none of your own." */
  view?: SessionView
  onViewChange?: (v: SessionView) => void
  /** Passed straight to `SessionChat` — see its own `onArtifacts`. This panel reads none of it. */
  onArtifacts?: SessionChatProps['onArtifacts']
  /**
   * OPEN THE TERMINAL ON ITS OWN SCREEN.
   *
   * A callback and not a path, for the reason `onOpenFull` is one on the metrics card: this panel
   * does not know how the surface around it navigates. Absent where there is nowhere to go, and
   * then the enlarge control is ABSENT too rather than inert.
   */
  onOpenTerminal?: () => void
  /**
   * Take WHICHEVER PANE the docked band is showing — `cli` or `shell` — to its own screen. Absent
   * where there is no route to take it to. The band tells this callback which one it is on
   * (`ShellBand`'s own `onOpenFullscreen`), so a reader pressing "full screen" while reading the
   * Claude Code pane lands on the Claude Code pane, not the shell's.
   */
  onOpenShellFullscreen?: (target: TerminalTarget) => void
  /**
   * May this machine serve a per-session utility SHELL right now — `CAPS.localShell` AND the
   * user's own switch, as `/api/team/session` reports it.
   *
   * Absent reads as OFF. It no longer decides whether the bottom band exists at all — see
   * `lib/panelBar.ts`'s own `bottomBandFor` for why that was the bug — only whether `ShellBand`
   * offers the SHELL half of what it can show: with it off, the segment drops the Shell tab
   * (`panelBarEntries`' own `shell` gate) and `ShellBand` itself never shows or opens a shell pane
   * (its own `shellEnabled` prop), while the CLI pane — the session's own harness terminal, not the
   * shell — stays fully reachable. It is never inferred from `capabilities.localShell` alone — that
   * is the profile's answer, and the switch may only ever narrow it further.
   */
  shellEnabled?: boolean
  /** `CAPS.localShell` alone, never narrowed by the preference — see `ShellBand`'s own prop of the
   *  same name for why the disabled-shell empty state needs both this AND `shellEnabled`. */
  shellCapable?: boolean
  /** Straight through to `ShellBand`'s own prop of the same name — see there. */
  onShellEnabledChange?: () => void | Promise<void>
  /**
   * May this machine serve the repository explorer at all — the same already-resolved
   * `editorEnabled` `ArtifactsAside` used to read. Gates whether the BOTTOM band may ever show the
   * Studio: absent reads as OFF, exactly as `shellEnabled` does.
   */
  editorEnabled?: boolean
  /**
   * The DOM box the Studio's persistent host should physically move into while it occupies the
   * BOTTOM slot and the band is expanded — see `StudioHost.tsx`, mounted by the caller (this
   * component owns no Monaco of its own). `null` while the band is collapsed or the Studio sits
   * elsewhere, which is also what the caller reads as "park it".
   */
  onStudioBandRef?: (el: HTMLDivElement | null) => void
  /** Hardware reads THIS machine's own process list — offered on the panel bar unless this session
   *  is viewed through a central (`!isCentral`, the same fact the header's old switcher read). */
  hardwareOffered?: boolean
  /** The Studio entry's first-open dot — `App.tsx`'s own `studioSeen`, so every surface that can
   *  open the Studio clears the same one flag. */
  studioSeen?: boolean
  /**
   * IS THE STUDIO'S BOTTOM BAND IN TRUE FULL SCREEN — the whole viewport, not merely "fills the
   * centre column". Owned by `SessionsPage` (the caller), because it has to hand the SAME flag to
   * `Studio.tsx` itself, a sibling mount reached through `StudioHost`'s portal that this component
   * cannot see — a flag `StudioBand` invented locally could never agree with the gear menu's own
   * exit control on which state is current. Absent reads as `false`; see `StudioBand`'s own header.
   */
  studioFullscreen?: boolean
  onStudioFullscreenChange?: (next: boolean) => void
  /**
   * ANY PANEL OTHER THAN STUDIO/CLI/SHELL, DOCKED AT THE BOTTOM — one of the ten former Contents
   * tabs, or `hardware`. This component holds no Monaco-style buffer for any of them — a plain
   * remount is safe (`panelMenu.ts`'s own `panelMinimizeAction` already says so for the rail's
   * `close-right`) — so, unlike the Studio, there is no persistent host to re-parent: the CALLER's
   * own already-built element for WHICHEVER id is currently docked (`SessionsPage`'s `panelBody`,
   * the SAME function the right slot calls) is simply mounted here instead, through
   * `SimpleDockedBand`'s own `children`. ONE fullscreen flag serves all of them — only one such
   * panel is ever docked at a time (a panel sits in at most one placement), so there is nothing to
   * disambiguate.
   */
  bottomTabPane?: ReactNode
  bottomTabFullscreen?: boolean
  onBottomTabFullscreenChange?: (next: boolean) => void
}

export function SessionPanel({
  session, row, lang, theme, act, authorName, onGone, onOpened, view: viewProp, onViewChange,
  onArtifacts, shellEnabled, shellCapable, onShellEnabledChange, editorEnabled, onOpenTerminal,
  onOpenShellFullscreen, onStudioBandRef, hardwareOffered, studioSeen = true,
  studioFullscreen, onStudioFullscreenChange,
  bottomTabPane, bottomTabFullscreen, onBottomTabFullscreenChange,
}: SessionPanelProps) {
  /**
   * Is this a session of ANOTHER machine, reached through the relay?
   *
   * Asked of the picker rather than of the row, because it is a fact about THIS page: a central
   * shows one machine's relayed fleet at a time, and every route this panel would otherwise call
   * (`/api/fleet/stream`, the chat read) is the machine's own and refused here. The row cannot
   * answer it — a relayed row is deliberately shaped like a local one so the list needs no branch.
   *
   * The CONVERSATION is unavailable too, and not by omission: on-demand chat retrieval was removed
   * from the reverse channel and `GET /api/team/session-chat` answers 410. So the toggle is not
   * offered, exactly as it is not offered for a harness that can never name its conversation — a
   * segmented control with one working segment is a label pretending to be a control.
   */
  const relayed = getCentralMachine() !== null
  const pt = lang === 'pt'

  /**
   * Can this session be read as a conversation at all?
   *
   * `conversationBlind` is the row's own sentence for a harness that can never report which
   * conversation it is writing. Reused rather than re-derived: the row, the chat view and this
   * toggle must give one answer, and this is the one place that could quietly disagree.
   */
  const chattable = session.conversationBlind === undefined && !relayed

  // Uncontrolled (mobile, self-contained) unless the caller hands in `onViewChange` — see the
  // module header. The local state is still declared unconditionally (hooks can't be), it is just
  // never read when a controlled view is in play.
  const [localView, setLocalView] = useState<SessionView>(chattable ? 'chat' : 'terminal')
  const controlled = onViewChange !== undefined
  const view = controlled ? (viewProp ?? 'chat') : localView
  const setView = controlled ? onViewChange! : setLocalView
  const active: SessionView = chattable ? view : 'terminal'

  /**
   * WHERE THE STUDIO SITS — `lib/panelSlots.ts`, design §1. Read through `resolveForViewport` with
   * this component's OWN `isMobile`, or a phone here and the desktop `SessionsPage` that mounts
   * `StudioHost` could disagree about whether the bottom slot exists at all — a phone has no docked
   * band (`dockedAllowed` in `terminalSurface.ts`), so a stored `bottom: 'studio'` must read as
   * absent here exactly as it reads as the right sheet there.
   */
  const isMobile = useIsMobile()
  const {
    layout: rawSlotLayout, openPanel: openSlotPanel, movePanel: moveSlotPanel, dropPanel: dropSlotPanel,
    setBottomOpen,
  } = usePanelSlots()
  const slotLayout = resolveForViewport(rawSlotLayout, isMobile)
  /**
   * WHICH PANEL GENUINELY OCCUPIES THE BOTTOM SLOT RIGHT NOW, EXCLUDING `cli`/`shell` — those two
   * are `ShellBand`'s own concern (it chooses between them internally via its own `target`); every
   * OTHER panel that can dock at the bottom (the ten former Contents tabs, `studio`, `hardware`)
   * renders through the generic path below, DESKTOP ONLY.
   *
   * `isMobile` IS RE-CHECKED HERE, EXPLICITLY — `resolveForViewport` clears a desktop-only bottom
   * occupant only when nothing is ALREADY on `right` (see that function's own header on why: it must
   * not keep re-folding `bottom` over a panel the mobile switcher just picked). That guard is correct
   * for `SessionsPage.tsx`'s own full-screen sheet, and wrong read from here: this component has no
   * such sheet, and a phone has no docked band for anything but the session's own terminal panes,
   * full stop — regardless of what `right` currently holds. Skipping this check let a genuine second
   * band (`Studio | Claude Code | Shell`) render UNDERNEATH the sheet on mobile the moment `right`
   * was no longer `null`, found live right after fixing the switcher's own stuck-panel bug.
   *
   * Named `bottomDesktopPanel`, NOT `bottomOccupant` — that name is `gatedBottomOccupant`'s own
   * result below, which answers a different question (what does the PANEL BAR light).
   */
  const bottomDesktopPanel: Exclude<PanelId, 'cli' | 'shell'> | null =
    isMobile || slotLayout.bottom === null || slotLayout.bottom === 'cli' || slotLayout.bottom === 'shell' ? null
    : slotLayout.bottom === 'studio' ? (editorEnabled === true ? 'studio' : null)
    : slotLayout.bottom


  /**
   * THE BOTTOM BAND'S OWN TAB STRIP (`lib/panelBar.ts`) — computed here, where `slotLayout`/
   * `relayed` are all already in scope, and handed down as data + one callback to whichever bottom
   * band actually renders it. AFTER THE RIGHT ICON RAIL it is scoped to the panels PLACED AT THE
   * BOTTOM (`bottomPanels(slotLayout)`) — every panel now goes through `panelSlots` directly; there
   * is no `contents` special case left to carve out.
   */
  const panelBarGates: PanelBarGates = {
    editorEnabled: editorEnabled === true,
    shellEnabled: shellEnabled === true,
    relayed,
    hardwareOffered: hardwareOffered === true,
  }
  const bottomIds = bottomPanels(slotLayout)
  // GATED — a stale `bottom: 'shell'` left over from before the switch turned off reads as `'cli'`
  // here too, or the bar would light no tab at all over a pane `ShellBand` draws anyway (its own
  // `target` is clamped the same way independently). See `gatedBottomOccupant`'s own doc comment.
  const bottomOccupant = gatedBottomOccupant(slotLayout.bottom, panelBarGates.shellEnabled)
  const barEntries = panelBarEntries(bottomIds, bottomOccupant, panelBarGates)

  /** WHICH BAND RENDERS AT THE FOOT OF THE PANEL — `lib/panelBar.ts`'s own `bottomBandFor`. Kept
   *  here as one small pure call rather than as a JSX ternary so the decision can be planted and
   *  tested without mounting anything; see that function's own doc comment for the rule itself.
   *  Computed AFTER `barEntries` on purpose: whether the band is EMPTY (nothing placed there) or
   *  merely COLLAPSED (panels placed, none open) is the count of those gated entries, and reading
   *  the open occupant instead is the mistake that function's header records. */
  const bottomBand = bottomBandFor({
    bottomOccupant: bottomDesktopPanel, relayed, isMobile, bottomHasPanels: barEntries.length > 0,
  })
  /**
   * A TAB CLICK SELECTS, IT NEVER TOGGLES — `lib/panelBar.ts`'s own `resolvePanelBarPick`. This bar
   * only ever lists bottom-placed panels now, so there is exactly one destination for a pick that is
   * not already the visible active tab: open it there.
   */
  const onPanelBarPick = useCallback((id: PanelBarId) => {
    const action = resolvePanelBarPick({ id, activeBottom: bottomOccupant, bottomOpen: slotLayout.bottomOpen })
    if (action.kind === 'noop') return
    if (action.kind === 'restore') { setBottomOpen(true); return }
    // action.kind === 'open'
    openSlotPanel(id)
  }, [bottomOccupant, slotLayout.bottomOpen, openSlotPanel, setBottomOpen])

  /**
   * THE CENTRE COLUMN'S OWN HEIGHT, MEASURED (design item 7) — what "full" means for the bottom
   * band. `window.innerHeight` was the wrong number even before this: it is the WHOLE viewport,
   * mobile status-bar insets and all, while the band must never cover more than the column it
   * actually docks inside (the mobile header above it, on the branch that has one; never the left
   * or right aside, which are beside this column, not above or below it). A `ResizeObserver` on
   * this component's own outer box is the same pattern `Studio.tsx`'s `measure` uses for the
   * tree/editor split, for the same reason: the box can change size for causes with no event of
   * their own (a sidebar drag, a window resize, an aside opening).
   */
  const [columnHeight, setColumnHeight] = useState(0)
  const columnObserver = useRef<ResizeObserver | null>(null)
  const measureColumn = useCallback((el: HTMLDivElement | null) => {
    columnObserver.current?.disconnect()
    columnObserver.current = null
    if (el === null) return
    setColumnHeight(el.getBoundingClientRect().height)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height
      if (h !== undefined) setColumnHeight(h)
    })
    ro.observe(el)
    columnObserver.current = ro
  }, [])
  useEffect(() => () => { columnObserver.current?.disconnect() }, [])

  return (
    // `flex: 1` + `minHeight: 0`, NOT `height: 100%`. In a column flex container a percentage
    // height on an item that is itself being flexed does not reliably resolve, and when it does not
    // the scroll container inside grows to its content instead of scrolling — which is the single
    // cause of two reported bugs: the conversation opening at the top (scrollTop on a non-scrolling
    // element does nothing) and the jump-to-latest arrow never appearing (`scrollHeight` equals
    // `clientHeight`, so the reader always measures as "at the tail").
    <div ref={measureColumn} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* MOBILE ONLY now — see the module header. PINNED exactly as before: `flexShrink: 0` plus
          `position: sticky` as the second, independent guarantee. */}
      {!controlled && (
      <header style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 20px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0, minWidth: 0, position: 'sticky', top: 0, zIndex: 2,
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={{
            margin: 0, fontSize: 15, fontWeight: 650, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {session.title}
          </h1>
          <p style={{
            margin: '2px 0 0', fontSize: 11.5, color: 'var(--text-tertiary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {session.stateLabel}
            {session.task ? ` · ${session.task}` : ''}
            {session.project ? ` · ${session.project}` : ''}
          </p>
        </div>

        {/* THE `Conversa | Terminal` TOGGLE IS GONE, and its absence is the design.
            A session opens on its CONVERSATION — that is what a session is — and the terminals are
            reached from the BAND at the foot of the panel, which names both of them. Two controls
            for one decision, in two places, with different words ("Terminal" here, "Assistente"
            there) was the ambiguity phase 1 set out to avoid and this header reintroduced. */}

        {/* The row's verbs. Every one of them, its label and whether it is enabled arrive already
            decided by `sessionActions` — the same answer the terminal cockpit resolves against. */}
        {row && (
          <SessionActions
            row={row}
            lang={lang}
            act={act}
            {...(onGone ? { onGone } : {})}
            {...(onOpened ? { onOpened } : {})}
          />
        )}
      </header>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* KEYED BY THE SESSION, and this is a correctness fix rather than a hint to React.
            Without it the same instance is reused when `session` changes, so every piece of state
            that is READ ONCE AT MOUNT belongs to whichever session was open first: the draft
            (`useState(() => readDraft(session.id))`), the attachments, and the in-flight `sending`
            / `stopping` flags.
            Reported, and it is the worst shape this could take: a message typed for one session
            was sent into ANOTHER after switching rows mid-request, with every button in the new
            session's composer stuck on a spinner that belonged to the old one. Per-session state
            must not outlive the session, and a `key` is how React is told that. */}
        {active === 'chat' ? (
          <SessionChat
            key={session.id}
            session={session} {...(row ? { row } : {})} lang={lang} act={act}
            {...(onArtifacts ? { onArtifacts } : {})}
            /* THE SAME callback the row's menu gets. There are two Reopen buttons on this
               screen — the menu's verb and the composer's — and they must land in one place. */
            {...(onOpened ? { onReopened: onOpened } : {})}
          />
        ) : relayed ? (
          /* ANOTHER MACHINE's session. The live stream is the machine's own SSE route, refused on a
             central and not relayed — so `TerminalRegion` would connect to nothing and say so,
             which is honest and useless. What the machine sends is its last captured frame, and
             `RelayedScreen` draws that while saying it is a snapshot. */
          <>
            <RelayedScreen {...(session.lastLines ? { lines: session.lastLines } : {})} lang={lang} />
            {/* The field that screen's own header points at — see `RelayedComposer`. */}
            <RelayedComposer row={row} act={act} lang={lang} {...(authorName ? { authorName } : {})} />
          </>
        ) : (
          <div style={{ flex: 1, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column' }}>
            {/* The very component the sessions list uses. Assembling a second one from the stream
                hook, the emulator and a composer would be three things that must agree about
                reconnects, stalls, zoom and the consent gate on typing into a live session. */}
            <TerminalRegion
              /* REPLACING the conversation, and inside the workspace — so focus is the consent and
                 a phone gets the key strip. See `lib/terminalSurface.ts`. */
              placement="replacing"
              {...(onOpenTerminal ? { onMaximize: onOpenTerminal } : {})}
              id={session.id}
              theme={theme}
              lang={lang}
              fill
              {...(row ? { row } : {})}
              act={act}
              {...(authorName ? { authorName } : {})}
            />
          </div>
        )}
      </div>

      {/* THE LAST BAND, below everything — the VS Code geometry, where the panel is always the
          bottom-most strip. It is deliberately OUTSIDE the view switch: a shell you opened to run
          `bun test` must not vanish because you moved from the conversation to the assistant's own
          screen. It is keyed by session, so switching rows unmounts it — which is also what drops
          its stream, the client half of the unwatch discipline.

          WHICH BAND renders is `bottomBand` (`lib/panelBar.ts`'s `bottomBandFor`, computed above).
          `shellEnabled` no longer decides PRESENCE — only `ShellBand`'s own shell half, through its
          own `shellEnabled` prop below. Absent on a RELAYED session for the same reason the live
          stream is: those routes are the machine's own and a central refuses them outright, so a
          band there could only ever draw a refusal (`bar-only`, or `none` on a phone — untouched by
          this fix, see `bottomBandFor`'s own doc comment).

          THE STUDIO CAN OCCUPY THIS SAME BAND (`lib/panelSlots.ts`'s `bottom` slot), and when it
          does this renders a SEPARATE small band rather than teaching `ShellBand` a third target:
          `ShellBand` bundles the session's own pane and the shell because both are terminal STREAMS
          answering the one consent/geometry machinery in `lib/terminalSurface.ts` — the Studio is
          neither, and its own persistent host (`StudioHost`, mounted once by `SessionsPage`) is what
          must never be torn down by an ordinary collapse. `key={session.id}` still resets the band's
          own open/collapsed feel per session; the Studio's own mount lives one level up. */}
      {bottomBand === 'studio' ? (
        <StudioBand
          key={session.id}
          lang={lang}
          open={slotLayout.bottomOpen}
          columnHeight={columnHeight}
          onToggleOpen={() => setBottomOpen(!slotLayout.bottomOpen)}
          barEntries={barEntries}
          onBarPick={onPanelBarPick}
          onBarDrop={dropSlotPanel}
          onBarMove={id => moveSlotPanel(id, 'rail')}
          studioSeen={studioSeen}
          fullscreen={studioFullscreen === true}
          onFullscreenChange={onStudioFullscreenChange ?? (() => {})}
          {...(session.harness ? { harness: session.harness } : {})}
          {...(onStudioBandRef ? { contentRef: onStudioBandRef } : {})}
        />
      ) : bottomBand === 'shell' ? (
        <ShellBand
          key={session.id}
          sessionId={session.id}
          {...(session.cwd ? { cwd: session.cwd } : {})}
          {...(onOpenShellFullscreen ? { onOpenFullscreen: onOpenShellFullscreen } : {})}
          {...(session.harness ? { harness: session.harness } : {})}
          lang={lang}
          theme={theme}
          columnHeight={columnHeight}
          barEntries={barEntries}
          onBarPick={onPanelBarPick}
          onBarDrop={dropSlotPanel}
          /*
           * `moveSlotPanel(id, 'rail')` — a genuine placement change, not merely an open. The docked
           * band's own `cli`/`shell` preference (`shellBand.ts`'s `target`) is never written through
           * `panelSlots` except on an explicit tab click, so on a fresh session `slotLayout.bottom`
           * may never have recorded what this band was already showing; `movePanel` no longer
           * refuses for that reason (it always sets placement AND opens, regardless of prior
           * visibility — see `panelSlots.ts`'s own header), so what the band shows right now is
           * always exactly what moves.
           */
          onBarMove={id => moveSlotPanel(id, 'rail')}
          studioSeen={studioSeen}
          // The security narrowing: WHICH of the two panes ShellBand may ever show/open, never
          // whether it renders at all — see this prop's own doc comment on `ShellBand`.
          shellEnabled={panelBarGates.shellEnabled}
          shellCapable={shellCapable !== false}
          {...(onShellEnabledChange ? { onShellEnabledChange } : {})}
          // RAW, ungated — deliberately NOT the `bottomOccupant` const above (which
          // `gatedBottomOccupant` already turned 'shell' into 'cli' for the BAR's own lit-tab
          // reading). `ShellBand` decides for ITSELF whether a genuine 'shell' record is usable —
          // see `resolveDockedTarget`'s own header — and needs the un-clamped slot value to do it,
          // or the very record that should draw the disabled-shell empty state would already read
          // as 'cli' by the time it got here.
          bottomOccupant={slotLayout.bottom === 'cli' || slotLayout.bottom === 'shell' ? slotLayout.bottom : null}
          // SEEDS this band's own open/collapsed state at mount and stays in sync afterward — the
          // SAME `slotLayout.bottomOpen` / `setBottomOpen` pair `StudioBand`/`SimpleDockedBand`
          // already take as a fully controlled `open`/`onToggleOpen`. See `ShellBand`'s own `open`
          // prop for why this one is a seed rather than a full control, and the bug it closes: with
          // the band open on Studio, picking Claude Code or Shell minimized it instead of switching,
          // needing a second click — this band mounting fresh and reading the shared band-prefs
          // record's stale `open` cold, ignoring the `bottomOpen: true` `openPanel` had just set.
          open={slotLayout.bottomOpen}
          onOpenChange={setBottomOpen}
        />
      ) : bottomBand !== 'bar-only' && bottomBand !== 'none' ? (
        /* ANY OTHER PANEL DOCKED AT THE BOTTOM — one of the ten former Contents tabs, or hardware.
           ONE generalized band for all of them (widened from the pre-rail `'contents'`/`'hardware'`
           pair) — none holds client-only state a remount could lose, so a single `SimpleDockedBand`
           keyed by the panel id itself covers every one of them. */
        <SimpleDockedBand
          key={session.id}
          panel={bottomBand}
          panelName={panelTitle(bottomBand, pt)}
          lang={lang}
          open={slotLayout.bottomOpen}
          columnHeight={columnHeight}
          onToggleOpen={() => setBottomOpen(!slotLayout.bottomOpen)}
          barEntries={barEntries}
          onBarPick={onPanelBarPick}
          onBarDrop={dropSlotPanel}
          onBarMove={id => moveSlotPanel(id, 'rail')}
          studioSeen={studioSeen}
          fullscreen={bottomTabFullscreen === true}
          onFullscreenChange={onBottomTabFullscreenChange ?? (() => {})}
          {...(session.harness ? { harness: session.harness } : {})}
        >
          {bottomTabPane}
        </SimpleDockedBand>
      ) : bottomBand === 'bar-only' && (
        /* THE ONLY CASE LEFT (design item 1: "It must also be present when no terminal is shown at
           the bottom") — a RELAYED session on desktop: no `cli`/`shell` stream of its own to dock,
           the one gap this fix leaves exactly as it found it (`bottomBandFor`'s own doc comment).
           Contents/Studio/Hardware must stay reachable regardless, or removing the header's own copy
           of this bar (item 2) would make them unreachable entirely. `PanelBarBand` is the same bar
           in the same slim shape `ShellBand`'s own collapsed bar takes, minus a stream it has
           nothing to show. */
        <PanelBarBand
          key={session.id}
          lang={lang}
          open={slotLayout.bottomOpen}
          onToggleOpen={() => setBottomOpen(!slotLayout.bottomOpen)}
          barEntries={barEntries}
          onBarPick={onPanelBarPick}
          studioSeen={studioSeen}
          reason="relayed"
        />
      )}
      {/* NOTHING DOCKED, ON A DESKTOP: no band at all (`bottomBandFor`'s own header). What that must
          not cost is the way back — a panel dragged off the rail needs somewhere to land. So a drop
          zone exists only while a panel drag is in flight, and is absent the rest of the time: an
          empty region that is always there is exactly the strip this replaced. The right-click
          "Mover X para baixo" is the route that does not need a drag at all. */}
      {bottomBand === 'none' && !isMobile && !relayed && (
        <EmptyBandDropZone lang={lang} onDrop={dropSlotPanel} />
      )}
    </div>
  )
}

/**
 * THE BOTTOM BAND'S LANDING STRIP WHILE THE BAND DOES NOT EXIST. Present only while a panel drag
 * carrying the shared payload is in flight (`hasDragPayload`), because the band itself renders
 * nothing when nothing is docked and there is otherwise no target for a rail icon to land on.
 * `dragstart`/`dragend`/`drop` are read on the WINDOW in the capture phase: the drag starts on the
 * rail, a different subtree, and this component has to know about it before the pointer arrives.
 */
function EmptyBandDropZone({ lang, onDrop }: {
  lang: 'pt' | 'en'
  onDrop: (dragPanel: PanelBarId, target: PanelDropTarget) => void
}) {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const start = (e: DragEvent) => { if (hasDragPayload(e)) setDragging(true) }
    const stop = () => setDragging(false)
    window.addEventListener('dragstart', start, true)
    window.addEventListener('dragend', stop, true)
    window.addEventListener('drop', stop, true)
    return () => {
      window.removeEventListener('dragstart', start, true)
      window.removeEventListener('dragend', stop, true)
      window.removeEventListener('drop', stop, true)
    }
  }, [])
  const drop = useBandDropTarget(onDrop)
  if (!dragging) return null
  return (
    <div
      ref={drop.ref}
      data-empty-band-drop
      style={{
        flexShrink: 0,
        height: 44,
        margin: '0 8px 8px',
        borderRadius: 8,
        border: `1px dashed ${drop.dropHighlight ? 'var(--anthropic-orange)' : 'var(--border)'}`,
        background: drop.dropHighlight ? 'var(--bg-elevated)' : 'transparent',
        color: 'var(--text-tertiary)',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {lang === 'pt' ? 'Solte aqui para mover para baixo' : 'Drop here to move it to the bottom'}
    </div>
  )
}

/**
 * StudioBand — the bottom band's OWN small bar while it holds the Studio, mirroring `ShellBand`'s
 * desktop bar (the whole strip toggles, the collapse chevron sits on the right) without any of its
 * terminal-target machinery. Collapsing NEVER drops the Studio: `contentRef`'s box is rendered only
 * while `open`, and the caller (`SessionsPage`) reads that same fact as "park it" rather than
 * "unmount it" — see `StudioHost.tsx`.
 *
 * FREE-RESIZING, WITH THE SAME SNAP-TO-FULL `ShellBand` HAS (design item 7) — the two bands share
 * ONE persisted height/full record (`shellBand.ts`'s `readBandPrefs`/`writeBandPrefs`, the same
 * `agentistics-shell-band` storage key), so a reader who has learned "drag this near the top to
 * fill the column" gets the identical feel switching between the Studio and the assistant's own
 * pane in the same band — two implementations of one gesture, sharing one memory, is the point.
 * `open` and `target` are untouched here: THIS band's open/closed state comes from `panelSlots.ts`
 * (`slotLayout.bottomOpen`, passed in as `open`), not from the shared record's own `open` field,
 * which is `ShellBand`'s alone — only `height`/`full` are read and written from here.
 */
function StudioBand({
  lang, open, columnHeight, onToggleOpen, barEntries, onBarPick, onBarDrop, onBarMove, studioSeen,
  contentRef, fullscreen, onFullscreenChange, harness,
}: {
  lang: 'pt' | 'en'
  open: boolean
  /** The centre column's own measured height — what "full" resolves against. `0` = not measured
   *  yet, and `resolveBandHeight` already reads that as "never snap". */
  columnHeight: number
  onToggleOpen: () => void
  /**
   * TRUE FULL SCREEN — the whole viewport, not merely "fills the centre column" (`heightPrefs.full`,
   * unaffected by this). Owned by `SessionsPage` (it also has to hand the SAME flag to `Studio.tsx`,
   * a sibling mount reached through `StudioHost`'s portal, which this component cannot see), so this
   * is a controlled pair of props rather than local state — see `resolveStudioBandDrag` in
   * `shellBand.ts` for the threshold a drag crosses to request it, and `Studio.tsx`'s own gear menu
   * for the deliberate (non-drag) way to ask for the same thing.
   */
  fullscreen: boolean
  onFullscreenChange: (next: boolean) => void
  /**
   * THE ONE PANEL BAR (design item 1) — the same `entries`/`onPick` `ShellBand`'s desktop bar
   * renders, computed once by `SessionPanel`. Picking Claude Code or Shell from it DISPLACES the
   * Studio (`openPanel('cli'|'shell')`, at whichever slot it last sat in), asking first only if the
   * Studio being displaced is dirty — the same segment `ShellBand`'s own bar shows, now offering
   * Studio back the other way.
   */
  barEntries: readonly PanelBarEntry[]
  onBarPick: (id: PanelBarId) => void
  /** Spec §3, drag — see `PanelBar`'s own `onDrop` prop. Optional so no caller is forced to wire it. */
  onBarDrop?: (dragPanel: PanelBarId, target: PanelDropTarget) => void
  /** The bar's own context-menu move verb (addendum, 2026-09-21) — see `PanelBar`'s own `onMove`. */
  onBarMove?: (id: PanelBarId) => void
  studioSeen: boolean
  contentRef?: (el: HTMLDivElement | null) => void
  /**
   * THE SESSION'S OWN HARNESS (owner, 2026-09-19: "quando eu to com o studio selecionado fica
   * 'sessão CLI' deveria ficar normalmente o nome do harness e a logo") — this band's own `PanelBar`
   * never received it, so its `cli` tab fell back to the generic "Sessão CLI"/"CLI session" label
   * every time the Studio (not `ShellBand`) was the bottom band's own occupant, which is exactly
   * when a reader is looking at this component. `ShellBand`'s own bar always passed it correctly;
   * this was the one bar that did not.
   */
  harness?: string
}) {
  const pt = lang === 'pt'
  /** The bar's OWN measured width (design item 7), never the window's — see `useElementWidth`'s
   *  own header on why. */
  const [barWidthRef, barWidth] = useElementWidth()
  const compact = bandBarCompact(barWidth)
  // WHERE THE ARTIFACTS ASIDE SITS RIGHT NOW — a SIBLING box `SessionsPage.tsx` owns, never a
  // descendant of this band, so full screen here must read it through the same shared bridge that
  // component reports it through (`rightAsideEdge.ts`) rather than assume it knows nothing about
  // one. `null` when there is no aside on screen — see `fullscreenInsetRight`'s own header.
  const rightAsideEdge = useRightAsideEdge()
  const leftAsideEdge = useLeftAsideEdge()
  const viewportWidth = useViewportWidth()
  // THE RAIL (spec §2) — full screen must also stop short of IT, even when the aside itself shows
  // nothing (`rightAsideEdge === null`; see `fullscreenInsetRight`'s own header on why that case
  // needs the width handed back explicitly). Desktop only — a phone has no rail at all. LIVE, not
  // the old fixed `RAIL_WIDTH_PX` — the rail resizes now (owner, 2026-09-21), and this must stop at
  // whatever width is actually on screen, or a rail dragged to its ceiling reads as covered.
  const railWidth = useRailWidth()
  const isMobile = useIsMobile()
  // FULL SCREEN IS A PROPERTY OF THE PANEL, NOT OF THE SLOT — `bandPanelFull` reads only THIS
  // panel's ('studio') own entry, so a DIFFERENT panel moved into this same bottom band afterward
  // never inherits it. See `BandPrefs.full`'s own header in `shellBand.ts`.
  const [heightPrefs, setHeightPrefs] = useState(() => {
    const p = readBandPrefs()
    return { height: p.height, full: bandPanelFull(p, 'studio') }
  })
  const applyHeight = useCallback((next: { height: number; full: boolean }) => {
    setHeightPrefs(next)
    writeBandPrefs(withBandPanelFull({ ...readBandPrefs(), height: next.height }, 'studio', next.full))
  }, [])
  const renderedHeight = heightPrefs.full && columnHeight > 0 ? columnHeight : heightPrefs.height
  // THE DRAG — `bandControls.tsx`'s shared `useBandDrag`, the one state machine `StudioBand`,
  // `SimpleDockedBand` and `ShellBand`'s own docked branch all drive their handle through now. See
  // its own header for why `onFullscreen` needs no `!fullscreen` re-entry guard: nulling the drag's
  // own ref on the first crossing already makes every later `move` in the same gesture a no-op.
  const grip = useBandDrag({
    renderedHeight, columnHeight, apply: applyHeight,
    onFullscreen: () => onFullscreenChange(true),
  })
  // THE WHOLE BAND IS A DROP TARGET NOW, not just its own tab strip — see `useBandDropTarget`'s own
  // header for the bug this fixes ("rail → bottom" silently doing nothing outside that narrow pill).
  const bandDrop = useBandDropTarget(onBarDrop)

  // COLLAPSING EXITS FULL SCREEN TOO — a band collapsed while fullscreen would otherwise leave the
  // flag standing with nothing on screen it still describes, so the NEXT expand would silently
  // reopen full screen from a plain "Expandir" press nobody asked to mean that.
  useEffect(() => {
    if (!open && fullscreen) onFullscreenChange(false)
  }, [open, fullscreen, onFullscreenChange])
  return (
    <div
      ref={bandDrop.ref}
      style={{
      // TRUE FULL SCREEN covers the WHOLE VIEWPORT — the sticky header, the fleet aside, everything
      // — not merely the centre column `heightPrefs.full` already fills; `PANEL_FULLSCREEN_Z` sits
      // comfortably below every modal (`ConfirmModal` is 2000) so a "close without saving" dialog
      // still draws over it.
      //
      // FULL (design item 7) is an EXPLICIT PIXEL HEIGHT, never `flex: '1 1 auto'` — see
      // `resolveBandDrag`'s own header in `shellBand.ts` for the whole story of the bug that shape
      // was. `renderedHeight` already resolves to the measured `columnHeight` while `heightPrefs.full`
      // is true, so this is the SAME number the content box below spends via its own `flex: '1 1
      // auto'` — the root states the total, the content box fills whatever the header/handle above it
      // leave over, and the two can never add up to more or less than the column. Gated on `open`:
      // a COLLAPSED band shows only its header row and must stay auto-sized to it, whatever `full`
      // says — the bar's own click is what set `full`, not what asks to render it this frame.
      //
      // FULL SCREEN STOPS SHORT OF THE ARTIFACTS ASIDE (`fullscreenInsetRight`) rather than
      // `inset: 0` — this band is docked at the BOTTOM, so a fixed `right: 0` would paint straight
      // over whatever the RIGHT slot is independently showing. `top`/`bottom` stay 0; `right`
      // follows the aside's own live edge, reactively, so minimizing it (its existing control)
      // frees the width without this band leaving and re-entering full screen. `left` follows the
      // LEFT sessions list's own live width the same way (owner, 2026-09-21: "a esquerda da
      // listagem de sessoes deveria continuar visivel" — full screen used to reach straight through
      // it via a bare `left: 0`) — `leftAsideEdge.ts` is the ONE bridge both this and `ShellBand`'s
      // own docked full screen read, so the two can never disagree about how much room the list
      // needs. NEVER collapsed on the reader's behalf: if they want the width, collapsing the list
      // themselves is the same lever the right side already defers to for the artifacts aside.
      ...(fullscreen
        ? {
          position: 'fixed', top: 0, left: leftAsideEdge, bottom: 0,
          right: fullscreenInsetRight(rightAsideEdge, viewportWidth, isMobile ? 0 : railWidth),
          zIndex: PANEL_FULLSCREEN_Z,
        }
        : open && heightPrefs.full
          ? { height: renderedHeight, flexShrink: 0 }
          : { flexShrink: 0 }),
      display: 'flex', flexDirection: 'column',
      borderTop: '1px solid var(--border)',
      // THE WHOLE BAND IS THE DROP TARGET (owner, 2026-09-21: "quero que eu so precise jogar ate a
      // barra inferior") — an INSET box-shadow rings the entire band while a drag is over it, never
      // only the thin top border, so what lights up is exactly what accepts the drop.
      ...(bandDrop.dropHighlight ? { boxShadow: 'inset 0 0 0 2px var(--anthropic-orange)' } : {}),
      background: 'var(--bg-surface)',
    }}>
      {/* THE GRIP — ALWAYS THE ROOT'S FIRST CHILD, ABOVE THE TAB ROW (owner report: "o item de
          reposicionamento muda de lugar, deveria estar SEMPRE no topo, na borda superior"). See
          `BandResizeHandle`'s own header in `bandControls.tsx` for why this used to sit AFTER the bar
          here (one row lower, level with the toolbar) while `ShellBand`'s own handle never did.
          FREE-RESIZING, no low ceiling, and it SNAPS to fill the centre column within
          `BAND_SNAP_THRESHOLD_PX` of its top (`resolveBandHeight`) — the height/full record is
          SHARED with `ShellBand`, so a reader who learned the gesture there gets the identical feel
          here. ABSENT in true full screen — there is nothing left to negotiate a HEIGHT for once the
          band covers the whole viewport, and a handle that visually does nothing is worse than none:
          the way back is the chevron below, the gear menu, or Esc, never this drag. ABSENT while
          collapsed too — nothing is on screen for it to resize. */}
      {open && !fullscreen && (
        <BandResizeHandle label={pt ? 'Redimensionar o Studio' : 'Resize the Studio'} {...grip} />
      )}
      {/* THE COMPACT BAR (design item 7) — the exact same shape `ShellBand`'s desktop bar takes:
          task control · panel segment (collapsing to icons below ~1100px) · spacer · ONE "⋯"
          overflow menu · the collapse chevron as a plain icon button. The leading "STUDIO" icon and
          label are gone with it — the segment's own lit tab already says "Studio", so the label was
          the same fact painted twice.

          THE TREE'S OWN SHOW/HIDE TOGGLE STAYS WHERE IT ALREADY IS, inside `Studio.tsx`'s own bar,
          and does NOT also appear in this menu — a previous pass removed a floating SECOND way to
          reach it (the collapsed-tree rail) on exactly the principle that there must be exactly ONE
          way back once the tree is minimized. Adding it here would reopen that. */}
      <div
        ref={barWidthRef}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', minHeight: 32,
        }}
      >
        {/* THE ONE PANEL BAR (design item 1) — `PanelBar` is the SAME component `ShellBand`'s
            desktop bar renders, given the SAME `barEntries`/`onBarPick` `SessionPanel` computed for
            both, so the two can never draw a different answer for the same session again — Studio
            simply reads `on` here, since this bar IS the Studio. `harness` (owner, 2026-09-19) is
            what makes its `cli` tab read "Claude Code" here too, instead of the generic fallback —
            see this component's own `harness` prop doc comment. */}
        <PanelBar
          entries={barEntries} lang={lang} studioSeen={studioSeen} onPick={onBarPick} compact={compact}
          {...(harness ? { harness } : {})}
          {...(onBarDrop ? { onDrop: onBarDrop } : {})}
          {...(onBarMove ? { onMove: onBarMove } : {})}
        />
        <span style={{ flex: 1 }} />
        {/* NO SECOND MENU HERE ANY MORE (owner, 2026-09-19: "no studio aparece os 3 pontinhos e a
            engrenagem"). This band's own "Mais ações" used to duplicate move/full-screen/close —
            already offered by `Studio.tsx`'s own ONE gear, rendered a few pixels below this bar in
            the content it portals into — so a reader saw both a "⋯" here and a gear there for the
            SAME panel. Full screen is ALSO no longer a menu row anywhere (§2): it is `Studio.tsx`'s
            own fixed button now, beside its gear. `onMoveToRight`/`onClose` are gone from this
            band's own props with it — `Studio.tsx` already gets `onMove`/`onExit` directly from
            `SessionsPage`, so this band never had anything left to say about either. */}
        {/* THE ONE MINIMIZE CONTROL FOR THIS BAND (owner, 2026-09-19: "botoes que ficaram fixos...
            minimizar... mas ela deve ser laranja") — a plain collapse/expand chevron, ALWAYS this
            band's own accent orange, never the neutral secondary-text colour every other icon here
            uses. It is the ONLY way to collapse or reopen the band; the bar's own click handler
            above is gone (see this file's own module header on the tab-click fix this pairs with —
            a tab SELECTS, a fixed control MINIMIZES, and conflating the two is what let a stray
            click on the tab area silently collapse a panel nobody asked to hide). */}
        <button
          className="ag-tap-icon"
          type="button"
          title={open ? (pt ? 'Recolher' : 'Collapse') : (pt ? 'Expandir' : 'Expand')}
          aria-label={open ? (pt ? 'Recolher o Studio' : 'Collapse the Studio') : (pt ? 'Expandir o Studio' : 'Expand the Studio')}
          onClick={e => { e.stopPropagation(); onToggleOpen() }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: BAND_CONTROL_H, height: BAND_CONTROL_H, padding: 0,
            border: 'none', borderRadius: 6, background: 'transparent',
            color: 'var(--anthropic-orange)', cursor: 'pointer',
          }}
        >{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
      </div>
      {open && (
        // A DIRECT CHILD OF THE ROOT — this is the freeze's root cause and the whole fix, kept exactly
        // as it was won. This box used to sit inside an extra `<div style={{display: 'flex',
        // flexDirection: 'column'}}>` wrapper (together with the handle, back when the two shared a
        // fragment), with no `flex`/`minHeight` of its own — so it took only the height its CONTENT
        // asked for (default `flex: 0 1 auto`) instead of growing to fill whatever the ROOT above it
        // (which DOES flex-stretch when `full`) actually had to give it. The content box's own
        // `flex: '1 1 auto'` then had nothing to grow INTO — a flex-grow child cannot exceed a
        // non-growing parent — so it collapsed to its minimum size and the root's remaining ~400px sat
        // empty below it: the drag reached the top, the band's OWN box did grow (confirmed by
        // measuring it directly), and everything inside it rendered into a sliver at the top, which is
        // what read as "the band went empty… and never became full screen." `ShellBand` never had this
        // bug — its own content box is a direct child of ITS root, with no such wrapper — and this box
        // being a direct sibling of the handle and the bar row (never wrapped with either of them)
        // makes `StudioBand` match that shape exactly rather than inventing a second one.
        <div style={{
          // NOT full/fullscreen: an explicit pixel height, because the ROOT above is auto-sized
          // (content decides it) and has no box of its own to hand this one a share of. FULL OR
          // FULLSCREEN: the ROOT is itself stretched (`flex: 1 1 auto` or `position: fixed;
          // inset: 0` — see its own style, above), so this box in turn just takes `flex: 1` of
          // THAT — the same two-step every other flexed box in this file uses.
          ...(heightPrefs.full || fullscreen
            ? { flex: '1 1 auto', minHeight: 0 }
            : { height: Math.max(BAND_MIN_PX, renderedHeight), flexShrink: 0 }),
          display: 'flex', flexDirection: 'column', padding: '0 12px 10px',
        }}>
          <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }} />
        </div>
      )}
    </div>
  )
}

/**
 * SimpleDockedBand — Contents and Hardware, docked at the bottom (owner, 2026-09-19: "o hardware
 * nao ta com a opcao de abrir no componente inferior e nem o Conteúdo, ambos também deveriam estar
 * aparecendo"). It mirrors `StudioBand`'s own outer chrome (the same free-resizing drag handle,
 * sharing the identical persisted height/full record — a reader who learned "drag near the top to
 * fill the column" gets the same feel here) but renders `children` directly instead of portaling
 * into a persistent host: neither Contents nor Hardware holds client-only state a remount could
 * lose (`panelMenu.ts`'s own `panelMinimizeAction` already says so for the right slot's `close-
 * right`, and the same fact is what makes a plain remount safe here too), so there is nothing here
 * that needs `StudioHost`'s re-parenting trick.
 *
 * UNLIKE `StudioBand`, this band carries the FULL fixed trio in ONE place
 * (`bandControls.tsx`'s `PanelFixedControls`: full screen, minimize, gear) — Contents/Hardware have
 * no toolbar of their own the way Studio does, so there is nowhere else for these three to live.
 */
function SimpleDockedBand({
  panel, panelName, lang, open, columnHeight, onToggleOpen, barEntries, onBarPick,
  onBarDrop, onBarMove, studioSeen, fullscreen, onFullscreenChange, harness, children,
}: {
  panel: Exclude<PanelId, 'cli' | 'shell' | 'studio'>
  panelName: string
  lang: 'pt' | 'en'
  open: boolean
  columnHeight: number
  onToggleOpen: () => void
  barEntries: readonly PanelBarEntry[]
  onBarPick: (id: PanelBarId) => void
  /** Spec §3, drag — see `PanelBar`'s own `onDrop` prop. Optional so no caller is forced to wire it. */
  onBarDrop?: (dragPanel: PanelBarId, target: PanelDropTarget) => void
  /** The bar's own context-menu move verb (addendum, 2026-09-21) — see `PanelBar`'s own `onMove`. */
  onBarMove?: (id: PanelBarId) => void
  studioSeen: boolean
  fullscreen: boolean
  onFullscreenChange: (next: boolean) => void
  harness?: string
  children: ReactNode
}) {
  const pt = lang === 'pt'
  const [barWidthRef, barWidth] = useElementWidth()
  const compact = bandBarCompact(barWidth)
  // Same reason `StudioBand` reads these — see that component's own header on `fullscreenInsetRight`.
  const rightAsideEdge = useRightAsideEdge()
  const leftAsideEdge = useLeftAsideEdge()
  const viewportWidth = useViewportWidth()
  const railWidth = useRailWidth()
  const isMobile = useIsMobile()
  // THE SAME persisted height record `StudioBand`/`ShellBand` already share (`shellBand.ts`'s
  // `agentistics-shell-band` key) — one memory for "drag near the top to fill the column", however
  // many kinds of panel a reader has parked there over time. `full` is the ONE field that does NOT
  // follow this — it is keyed by `panel` (`bandPanelFull`/`withBandPanelFull`), so `contents` moved
  // into this band never reads full because `hardware` left it that way, or the reverse. See
  // `BandPrefs.full`'s own header in `shellBand.ts`.
  const [heightPrefs, setHeightPrefs] = useState(() => {
    const p = readBandPrefs()
    return { height: p.height, full: bandPanelFull(p, panel) }
  })
  const applyHeight = useCallback((next: { height: number; full: boolean }) => {
    setHeightPrefs(next)
    writeBandPrefs(withBandPanelFull({ ...readBandPrefs(), height: next.height }, panel, next.full))
  }, [panel])
  const renderedHeight = heightPrefs.full && columnHeight > 0 ? columnHeight : heightPrefs.height
  // THE DRAG — the SAME shared `useBandDrag` `StudioBand` drives its own handle through; see that
  // component's own comment for why `onFullscreen` needs no `!fullscreen` re-entry guard.
  const grip = useBandDrag({
    renderedHeight, columnHeight, apply: applyHeight,
    onFullscreen: () => onFullscreenChange(true),
  })
  useEffect(() => {
    if (!open && fullscreen) onFullscreenChange(false)
  }, [open, fullscreen, onFullscreenChange])
  // NO GEAR (addendum, 2026-09-21): `panel` here is never the Studio (`Exclude<..., 'studio'>`), so
  // its only-ever gear row was move — now the tab's OWN right-click menu (`onBarMove`, wired at the
  // call site). A panel this generic band hosts has nothing else to say in a gear.
  const gearEntries: readonly BandOverflowEntry[] = []
  // THE WHOLE BAND IS A DROP TARGET NOW, not just its own tab strip — see `useBandDropTarget`'s own
  // header for the bug this fixes.
  const bandDrop = useBandDropTarget(onBarDrop)
  /**
   * AN EMPTY BAND RENDERS NOTHING — the same rule `PanelBarBand` already carries for the relayed
   * case (that component's own comment: "quando removo todos os itens ele simplesmente deixa essa
   * porra desse iconezinho feio ai"), missing here. `bottomBandFor` selects THIS band for `panel`
   * whatever its own gate says — its own doc comment: "whatever panel it is, gated or not" — because
   * `resolveForGates` only clears a stored `bottom` occupant for the three machine-level `PanelGates`
   * (`editorEnabled`/`shellEnabled`/`relayed`); `hardware`'s own gate is per-SESSION
   * (`hardwareOffered`, read at the render layer, never by `resolveForGates` — see that function's
   * own header) and is therefore never cleared from a stored preference. A browser that once docked
   * Hardware at the bottom on an ordinary machine and is now looking at a CENTRAL (`hardwareOffered`
   * always false there) keeps `bottomOccupant === 'hardware'`, `bottomBandFor` still returns this
   * band, and `panelBarEntries` filters the one entry this band would have shown — leaving the grip,
   * an empty `PanelBar` and `PanelFixedControls`' own literal `−` (that component's own header:
   * "ALWAYS THE SAME LITERAL `−`") on screen with nothing docked behind any of them: the exact "lone
   * orange −" report this closes. Contents' own ten tabs carry no such per-session gate
   * (`panelBarGateOpen` returns `true` for anything but `studio`/`cli`/`shell`/`hardware`), so this
   * is reachable only through `hardware` today — kept general, like `PanelBarBand`'s own guard,
   * because the next per-session-gated panel this band ever hosts would leak the identical way.
   */
  if (barEntries.length === 0) return null
  return (
    <div
      ref={bandDrop.ref}
      style={{
      // FULL SCREEN STOPS SHORT OF THE ARTIFACTS ASIDE AND THE LEFT SESSIONS LIST — see `StudioBand`'s
      // own comment on `fullscreenInsetRight`/`leftAsideEdge`; the same reasoning applies unchanged.
      ...(fullscreen
        ? {
          position: 'fixed', top: 0, left: leftAsideEdge, bottom: 0,
          right: fullscreenInsetRight(rightAsideEdge, viewportWidth, isMobile ? 0 : railWidth),
          zIndex: PANEL_FULLSCREEN_Z,
        }
        : open && heightPrefs.full
          ? { height: renderedHeight, flexShrink: 0 }
          : { flexShrink: 0 }),
      display: 'flex', flexDirection: 'column',
      borderTop: '1px solid var(--border)',
      ...(bandDrop.dropHighlight ? { boxShadow: 'inset 0 0 0 2px var(--anthropic-orange)' } : {}),
      background: 'var(--bg-surface)',
    }}>
      {/* THE GRIP — ALWAYS THE ROOT'S FIRST CHILD, ABOVE THE TAB ROW — see `StudioBand`'s own
          identical comment, and `BandResizeHandle`'s header in `bandControls.tsx`, for why this used
          to sit AFTER the bar here instead (Contents/Hardware read one row lower than Claude
          Code/Shell, the bug this fix closes). */}
      {open && !fullscreen && (
        <BandResizeHandle label={pt ? `Redimensionar ${panelName}` : `Resize ${panelName}`} {...grip} />
      )}
      <div
        ref={barWidthRef}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', minHeight: 32,
        }}
      >
        <PanelBar
          entries={barEntries} lang={lang} studioSeen={studioSeen} onPick={onBarPick} compact={compact}
          {...(harness ? { harness } : {})}
          {...(onBarDrop ? { onDrop: onBarDrop } : {})}
          {...(onBarMove ? { onMove: onBarMove } : {})}
        />
        <span style={{ flex: 1 }} />
        <PanelFixedControls
          lang={lang}
          panelName={panelName}
          fullscreen={{ active: fullscreen, onToggle: () => onFullscreenChange(!fullscreen) }}
          collapsed={!open}
          onMinimize={onToggleOpen}
          minimizeLabel={open ? (pt ? `Recolher ${panelName}` : `Collapse ${panelName}`)
            : (pt ? `Expandir ${panelName}` : `Expand ${panelName}`)}
          gearLabel={pt ? `Opções — ${panelName}` : `${panelName} options`}
          gearEntries={gearEntries}
        />
      </div>
      {open && (
        <div style={{
          ...(heightPrefs.full || fullscreen
            ? { flex: '1 1 auto', minHeight: 0 }
            : { height: Math.max(BAND_MIN_PX, renderedHeight), flexShrink: 0 }),
          display: 'flex', flexDirection: 'column', padding: '0 12px 10px', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' }}>
            {children}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * PanelBarBand — the panel bar with nothing docked behind it (design item 1: "It must also be
 * present when no terminal is shown at the bottom"). Renders on a RELAYED session — no `cli`/`shell`
 * stream of its own to show — the one case left with genuinely nothing to dock, so
 * Contents/Studio/Hardware stay reachable rather than vanishing along with the terminal streams.
 *
 * `reason` used to also carry `'shell-off'`: before `bottomBandFor` (`lib/panelBar.ts`) existed, a
 * LOCAL session with the shell switched off fell through to this same band, because `ShellBand` was
 * gated on `shellEnabled` at the call site instead of on its own `shellEnabled` prop. That was the
 * bug this pass fixes — a local session always gets `ShellBand` now (its own CLI pane is the
 * session's harness terminal, never gated by the shell switch), so this band is relayed-only and the
 * reason is no longer a choice.
 *
 * A SLIM BAR ONLY — the same header row `ShellBand`'s own collapsed bar takes (same height, same
 * toggle), minus a stream it has nothing to show. Expanding it reveals one sentence naming WHY there
 * is nothing to dock here, so "Expandir" is never a control whose one outcome is emptiness with no
 * explanation.
 */
function PanelBarBand({
  lang, open, onToggleOpen, barEntries, onBarPick, studioSeen, reason,
}: {
  lang: 'pt' | 'en'
  open: boolean
  onToggleOpen: () => void
  barEntries: readonly PanelBarEntry[]
  onBarPick: (id: PanelBarId) => void
  studioSeen: boolean
  reason: 'relayed'
}) {
  const pt = lang === 'pt'
  const REASON_TEXT: Record<'relayed', { en: string; pt: string }> = {
    relayed: {
      en: 'This session belongs to another machine — no terminal to show here.',
      pt: 'Esta sessão pertence a outra máquina — não há terminal para mostrar aqui.',
    },
  }
  const [barWidthRef, barWidth] = useElementWidth()
  const compact = bandBarCompact(barWidth)
  // AN EMPTY BAND RENDERS NOTHING (owner, 2026-09-21: "quando removo todos os itens ele
  // simplesmente deixa essa porra desse iconezinho feio ai") — with the fixed task control gone
  // (see below) and every dockable panel moved to the rail, this band's own row held nothing but a
  // lone collapse/expand chevron: a control whose only destination is a sentence explaining that
  // there is nothing here. `ShellBand` never reaches this — a LOCAL session's own CLI/Shell toggle
  // is the documented FLOOR this band deliberately is not (`bottomBandFor`'s own header), so this
  // is the one case in the whole panel system where "nothing placed here" really does mean nothing
  // to show. Getting a panel back is still one right-click away on the rail — see that context
  // menu's own "Mover para baixo"/"Move to the bottom" verb.
  if (barEntries.length === 0) return null
  return (
    <div style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderTop: '1px solid var(--border)', background: 'var(--bg-surface)',
    }}>
      <div
        ref={barWidthRef}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={pt ? 'Abrir ou recolher' : 'Open or collapse'}
        onClick={onToggleOpen}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleOpen() } }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', minHeight: 32,
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <PanelBar entries={barEntries} lang={lang} studioSeen={studioSeen} onPick={onBarPick} compact={compact} />
        <span style={{ flex: 1 }} />
        {/* NO OVERFLOW MENU HERE — this band belongs to no panel of its own (a relayed session has
            no `cli`/`shell` stream to dock), and there is nothing left to say about a panel sitting
            elsewhere: see `SessionPanel`'s own module comment on why a menu never names a panel
            other than the one it belongs to. */}
        <button
          className="ag-tap-icon"
          type="button"
          title={open ? (pt ? 'Recolher' : 'Collapse') : (pt ? 'Expandir' : 'Expand')}
          aria-label={open ? (pt ? 'Recolher' : 'Collapse') : (pt ? 'Expandir' : 'Expand')}
          onClick={e => { e.stopPropagation(); onToggleOpen() }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: BAND_CONTROL_H, height: BAND_CONTROL_H, padding: 0,
            border: 'none', borderRadius: 6, background: 'transparent',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}
        >{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>
      </div>
      {open && (
        <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)', padding: '0 12px 10px' }}>
          {pt ? REASON_TEXT[reason].pt : REASON_TEXT[reason].en}
        </div>
      )}
    </div>
  )
}

// The band's own controls (the move/close/collapse trio, the "which terminal" segment) now render
// through `bandControls.tsx` — see its own header for why the two near-duplicate implementations
// that used to live here (`studioBandIconBtn`/`studioBandLabeledBtn`, and a `Segment` component
// exported for exactly this purpose and never actually imported anywhere) were the drift design
// item 3 exists to close, not a second one to keep beside it.
