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

import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ChevronDown, ChevronUp, ChevronLeft, Loader2, Maximize2, RotateCcw, TerminalSquare, Trash2,
} from 'lucide-react'
import { useDocumentVisible } from '../../hooks/useDocumentVisible'
import { keyStripShown } from '../../lib/terminalSurface'
import {
  TERMINAL_TARGETS, readTarget, targetLabel, targetScope, targetStreamId, type TerminalTarget,
} from '../../lib/terminalTarget'
import {
  atCap, ceilingRows, ceilingTitle, type CeilingRow, type CeilingShell,
} from '../../lib/shellCeiling'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useTerminalStream } from '../../hooks/useTerminalStream'
import { useTerminalWrite } from '../../hooks/useTerminalWrite'
import {
  BAND_MIN_PX, clampBandHeight, readBandPrefs, shellApiUrl, shellErrorText, shellWatching,
  bandGeometry, shellWhere, writeBandGeometry, writeBandPrefs,
} from '../../lib/shellBand'
import {
  INITIAL_SHELL_BAND, shellBandReducer, shellResolveWanted, type OpenShell,
} from '../../lib/shellBandState'
import { KEY_STRIP, ctrlKeyFor, keyBytes, stripKeyLabel } from '../../lib/keyStrip'
import { terminalStatus } from '../../lib/terminalStream'
import { createPaneResizer } from '../../lib/paneResizeRequest'

const SessionTerminal = lazy(() => import('../SessionTerminal'))

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
  resize: string
  retry: string
  fullscreen: string
  endThis: string
  whichTerminal: string
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
    resize: 'Drag to resize the shell',
    retry: 'Try again',
    fullscreen: 'Open the shell full screen',
    endThis: 'End this terminal',
    whichTerminal: 'Which terminal',
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
    resize: 'Arraste para redimensionar o shell',
    retry: 'Tentar de novo',
    fullscreen: 'Abrir o shell em tela cheia',
    endThis: 'Encerrar este terminal',
    whichTerminal: 'Qual terminal',
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
   * here by asking for it and the way back is the screen's own control.
   *
   * The two share every rule that matters — one stream, one write channel, one emulator, the same
   * unwatch discipline — which is the entire reason this is a prop and not a second component.
   */
  placement?: 'docked' | 'dedicated'
  /** Offered only when there is somewhere to go: the band's "take the whole screen" control. */
  onOpenFullscreen?: () => void
}

export function ShellBand({ sessionId, cwd, lang, theme, harness, placement = 'docked', onOpenFullscreen }: ShellBandProps) {
  const t = TXT[lang]
  const isMobile = useIsMobile()
  const documentVisible = useDocumentVisible()

  const dedicated = placement === 'dedicated'
  const [prefs, setPrefs] = useState(() => readBandPrefs())
  /**
   * WHICH terminal this band is showing. It is the band's own state and not the session's, because
   * the band is now the door to BOTH panes: the header's `Conversa | Terminal` toggle is gone, a
   * session opens on its conversation, and choosing a terminal is choosing which one.
   */
  const [target, setTarget] = useState<TerminalTarget>(() => readTarget(readBandPrefs().target))
  const scope = targetScope(target)
  // A DEDICATED shell is open by definition — you navigated to a screen that is nothing else. The
  // stored `open` is the DOCKED band's state and must not decide it, or arriving here with the band
  // collapsed would show an empty screen with no way to fill it.
  const bandOpen = dedicated || prefs.open
  // THE MACHINE, not a pile of flags. See `shellBandState.ts` for the rule it enforces.
  const [band, dispatch] = useReducer(shellBandReducer, INITIAL_SHELL_BAND, init =>
    dedicated || readBandPrefs().open ? shellBandReducer(init, { type: 'openBand' }) : init)
  const shell = band.shell
  const [ctrlArmed, setCtrlArmed] = useState(false)
  /** The open shells, fetched ONLY when the ceiling refuses — see `shellCeiling.ts`. */
  const [ceiling, setCeiling] = useState<{ rows: CeilingRow[]; cap: number } | null>(null)
  const [ctrlNote, setCtrlNote] = useState<string | null>(null)

  /** Choosing a terminal is remembered, so the band comes back on the one you were using. */
  const chooseTarget = useCallback((next: TerminalTarget) => {
    setTarget(next)
    try { writeBandPrefs({ ...readBandPrefs(), target: next }) } catch { /* storage blocked */ }
  }, [])

  const setBand = useCallback((next: Partial<{ open: boolean; height: number }>) => {
    setPrefs(p => {
      const merged = { ...p, ...next }
      writeBandPrefs(merged)
      return merged
    })
    if (next.open === true) dispatch({ type: 'openBand' })
    if (next.open === false) dispatch({ type: 'closeBand' })
  }, [])

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
  const wanted = shellResolveWanted(band) && target === 'shell'
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

  const watching = shellWatching({
    bandOpen,
    sessionSelected: Boolean(sessionId),
    documentVisible,
  })
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
      write.send(keyBytes(key))
      return
    }
    write.send(data)
  }, [ctrlArmed, write, t])

  const pressStrip = useCallback((id: string) => {
    const entry = KEY_STRIP.find(e => e.id === id)
    if (!entry) return
    if (entry.kind === 'modifier') { setCtrlNote(null); setCtrlArmed(a => !a); return }
    setCtrlArmed(false)
    write.send(keyBytes(entry.key))
  }, [write])

  const close = useCallback(async () => {
    if (!shell) return
    const id = shell.id
    dispatch({ type: 'ended' })
    setBand({ open: false })
    await fetch(shellApiUrl('/api/shell/close', lang), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => {})
  }, [shell, setBand, lang])

  // ---- the drag handle -----------------------------------------------------------------------
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const onDragStart = (clientY: number) => { dragRef.current = { startY: clientY, startH: prefs.height } }
  useEffect(() => {
    if (isMobile) return
    const move = (clientY: number) => {
      const d = dragRef.current
      if (!d) return
      // The band grows UPWARD: it is docked at the bottom, so dragging up must make it taller.
      setBand({ height: clampBandHeight(d.startH + (d.startY - clientY), window.innerHeight) })
    }
    const onMouse = (e: MouseEvent) => move(e.clientY)
    const onTouch = (e: TouchEvent) => { const p = e.touches[0]; if (p) move(p.clientY) }
    const end = () => { dragRef.current = null }
    window.addEventListener('mousemove', onMouse)
    window.addEventListener('mouseup', end)
    window.addEventListener('touchmove', onTouch)
    window.addEventListener('touchend', end)
    return () => {
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchmove', onTouch)
      window.removeEventListener('touchend', end)
    }
  }, [isMobile, setBand])

  /**
   * THE ONE CONTROL THAT PICKS A TERMINAL. It replaced the header's `Conversa | Terminal` toggle —
   * a session opens on its conversation, and this band is the door to both panes. The CLI segment
   * is named after the HARNESS, so it names what is on the screen instead of a concept.
   */
  const targetSwitch = (
    <div role="tablist" aria-label={t.whichTerminal} style={{
      display: 'flex', gap: 3, padding: 3, borderRadius: 8, flexShrink: 0,
      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
    }}>
      {TERMINAL_TARGETS.map(id => {
        const on = target === id
        return (
          <button
            key={id}
            role="tab"
            aria-selected={on}
            // Collapsed, picking a target is also the gesture that OPENS the band — the segment is
            // the door, so it must not need a second click on the bar behind it.
            onClick={e => { e.stopPropagation(); chooseTarget(id); if (!bandOpen) setBand({ open: true }) }}
            style={{
              // 44px is the MOBILE figure; on a pointer it would turn a segmented control into a
              // row of buttons.
              minHeight: isMobile ? 44 : 22, padding: isMobile ? '0 14px' : '0 9px',
              borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 11, fontWeight: 650, border: 'none', whiteSpace: 'nowrap',
              background: on ? 'var(--bg-surface)' : 'transparent',
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
            }}
          >
            {targetLabel(id, harness, lang)}
          </button>
        )
      })}
    </div>
  )

  const where = shellWhere(cwd)

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
          onGeometry={streamId ? onGeometry : undefined}
        />
      </Suspense>
    </div>
  )

  /** The one sentence the band always has: a refusal, a delivery failure, or what is on screen. */
  const line = band.message ?? (write.reason ? write.reason : band.phase === 'opening' ? t.opening : status.detail)
  const lineIsBad = Boolean(band.message || write.reason)
  const busy = band.phase === 'opening'

  const notice = (
    <div
      role={lineIsBad ? 'status' : undefined}
      style={{
        fontSize: 11, lineHeight: 1.5, flexShrink: 0,
        color: lineIsBad ? 'var(--accent-red)' : 'var(--text-tertiary)',
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
      {KEY_STRIP.map(entry => {
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

  // ---- dedicated: the shell IS the screen ------------------------------------------------------
  // No bar, no drag handle, no collapsed state: you navigated here, and the way back belongs to the
  // screen around it. The key strip follows `keyStripShown` — a phone has no ctrl key, and this is
  // the placement a phone always gets.
  if (dedicated) {
    return (
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {streamId ? screen : <div style={{ flex: 1 }} />}
        {notice}
        {ceilingList}
        {keyStripShown('dedicated', isMobile) && strip}
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
          </div>
          {shell && target === 'shell' && (
            <button
              onClick={() => { void close() }}
              aria-label={t.close}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 44, height: 44, flexShrink: 0,
                border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
              }}
            >
              <Trash2 size={18} />
            </button>
          )}
        </div>
        <div style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
        }}>
          {/* RIGHT, like every other placement's. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>{targetSwitch}</div>
          {streamId ? screen : <div style={{ flex: 1 }} />}
          {notice}
          {ceilingList}
          {strip}
        </div>
      </div>
    )
  }

  // ---- desktop: the last band of the panel, under the composer ---------------------------------
  return (
    <div style={{
      flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderTop: '1px solid var(--border)', background: 'var(--bg-surface)',
    }}>
      {/* The drag handle sits on the band's TOP edge — the VS Code geometry, where the panel is
          always the bottom-most strip. It is `role="separator"` and takes the arrow keys, so the
          band is resizable without a pointer. */}
      {prefs.open && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t.resize}
          tabIndex={0}
          onMouseDown={e => { e.preventDefault(); onDragStart(e.clientY) }}
          onKeyDown={e => {
            if (e.key === 'ArrowUp') { e.preventDefault(); setBand({ height: clampBandHeight(prefs.height + 24, window.innerHeight) }) }
            if (e.key === 'ArrowDown') { e.preventDefault(); setBand({ height: clampBandHeight(prefs.height - 24, window.innerHeight) }) }
          }}
          style={{ height: 6, cursor: 'ns-resize', background: 'transparent' }}
        />
      )}
      {/* THE WHOLE BAR IS THE TOGGLE. A 26px chevron at the far right of a full-width strip is a
          target you have to aim at, and the strip beside it did nothing at all — so the bar takes
          the click and the chevron stays as the thing that NAMES the gesture. `role="button"`
          rather than a real one: it contains buttons, and nesting them is invalid HTML. The
          controls inside it stop propagation, or ending a shell would also collapse the band. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={prefs.open}
        aria-label={t.toggleBar}
        onClick={() => setBand({ open: !prefs.open })}
        onKeyDown={e => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setBand({ open: !prefs.open })
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', minHeight: 32,
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ color: 'var(--anthropic-orange)', display: 'inline-flex' }}><TerminalSquare size={14} /></span>
        {/* ONE CONTROL, ONE SHAPE, ONE PLACE. It used to be two buttons on the LEFT when collapsed
            and a segmented control on the RIGHT when open — so choosing a terminal meant finding a
            control that had moved and changed form between two states of the same bar, and moved
            back again on maximize. It is the segmented control, on the right, always. */}
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-secondary)' }}>
          {targetLabel(target, harness, lang).toUpperCase()}
        </span>
        {where && <span style={{
          minWidth: 0, flex: 1, fontSize: 11, color: 'var(--text-tertiary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{where}</span>}
        {!where && <span style={{ flex: 1 }} />}
        {targetSwitch}
        {busy && <Loader2 size={13} className="ag-spin" style={{ color: 'var(--text-tertiary)' }} />}
        {/* TAKE THE WHOLE SCREEN. Offered only with a shell open and somewhere to go, so the bar of
            a band nobody has opened carries nothing that cannot act. It is the only way to the
            shell's own screen — the route has accepted `?pane=shell` since phase 3b and nothing
            linked there. */}
        {prefs.open && streamId && onOpenFullscreen && (
          <button className="ag-tap-icon"
            onClick={e => { e.stopPropagation(); onOpenFullscreen() }}
            title={t.fullscreen}
            aria-label={t.fullscreen}
            style={iconBtn}
          >
            <Maximize2 size={13} />
          </button>
        )}
        {/* A shell is something the person OPENED and can end; the CLI pane is the session itself
            and ending it here would be a kill button wearing a wastebasket. */}
        {prefs.open && shell && target === 'shell' && (
          <button className="ag-tap-icon"
            /* A TRASH CAN, not an ✕. The ✕ read as "close this panel" next to a chevron that
               actually closes the panel, and this one KILLS the shell — a different, irreversible
               act. The icon is the only thing saying which of the two you are about to do. */
            onClick={e => { e.stopPropagation(); void close() }}
            title={t.close}
            aria-label={t.close}
            style={iconBtn}
          >
            <Trash2 size={13} />
          </button>
        )}
        <button className="ag-tap-icon"
          onClick={e => { e.stopPropagation(); setBand({ open: !prefs.open }) }}
          title={prefs.open ? t.collapse : t.expand}
          aria-label={prefs.open ? t.collapse : t.expand}
          style={iconBtn}
        >
          {prefs.open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>
      {prefs.open && (
        <div style={{
          height: Math.max(BAND_MIN_PX, prefs.height),
          display: 'flex', flexDirection: 'column', gap: 6, padding: '0 12px 10px',
        }}>
          {streamId ? screen : <div style={{ flex: 1 }} />}
          {notice}
          {ceilingList}
        </div>
      )}
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 22, flexShrink: 0, borderRadius: 6, padding: 0,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)', cursor: 'pointer',
}
