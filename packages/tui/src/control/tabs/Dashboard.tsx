/**
 * Dashboard.tsx — the metrics dashboard, as a screen of the control center.
 *
 * It renders nothing of its own: the six screens, their strip and their keys are `DashboardView`
 * and `useDashboardNav`. What lives HERE is only what is true of being a tab — where the data
 * comes from, when it may be read, and which keys are left after the shell has taken its own.
 *
 * WHERE THE DATA COMES FROM is the one deliberate difference from the standalone app that used to
 * draw these screens (`agentop tui`, an alias for this one now). That command started a server for
 * itself when none was listening; this screen is inside the application that STARTS AND
 * STOPS that server, so it starts nothing. It reads the address off `ControlStatus.services` — the
 * host has already probed it — and when there is no address it says so in a sentence naming the
 * screen that fixes it. Zeros drawn under a stopped server would be the confident-0 this codebase
 * refuses everywhere else.
 *
 * WHEN IT MAY BE READ: only while it is the visible tab. The shell keeps every screen mounted
 * (`display: none`) so state survives a glance elsewhere — which would otherwise mean an SSE
 * connection held open and the whole payload re-read every few seconds behind a screen nobody is
 * looking at.
 */

import React, { useEffect, useMemo } from 'react'
import type { ControlStatus } from '../types'
import type { CliLang } from '../lang'
import type { ControlStrings } from '../i18n'
import type { TabChrome } from '../ControlCenter'
import { useAppData } from '../../data/useAppData'
import { DashboardView } from '../../dashboard/DashboardView'
import { useDashboardNav } from '../../dashboard/useDashboardNav'
import { dashboardRows, dashboardSource, stripFit, DASHBOARD_SCREENS } from '../../dashboard/view'
import { sourceAtColumn } from '../surface.ts'
import { isActivation } from '../mouse'
import { usePointer } from '../pointer'
import { strings } from '../../i18n'

export function Dashboard({ status, strings: s, lang, width, height, isActive, nonce, onChrome }: {
  /** `null` until the first refresh lands — "not asked yet", never "nothing is running". */
  status: ControlStatus | null
  strings: ControlStrings
  lang: CliLang
  width: number
  height: number
  isActive: boolean
  /** Bumped by the shell's `r`, so one key means one thing on every screen: re-read what is shown. */
  nonce: number
  onChrome: (chrome: TabChrome) => void
}) {
  // The dashboard's OWN words (screen names, column headers, empty states) come from the TUI's
  // string table (`src/i18n.ts`); the chrome around them is the control center's.
  const t = strings(lang)

  const source = useMemo(() => dashboardSource(status?.services), [status?.services])
  const { data, connection } = useAppData(source.kind === 'api' ? source.apiBase : null, {
    enabled: isActive,
    nonce,
  })

  const nav = useDashboardNav({ isActive, harnesses: data?.harnesses, data, height })

  useEffect(() => {
    if (!isActive) return
    onChrome(nav.capture
      // While the harness picker is open it owns the keyboard: `q` would otherwise quit the whole
      // app out from under a list the user is choosing from, and the footer must name the keys that
      // actually work here rather than the ones that normally do.
      ? { capture: true, hints: [s.keyBack, s.keyMove, s.keySelect] }
      : { capture: false, hints: [s.keyQuit, s.keyTabs, s.dashView, s.dashFilter, s.dashPage, s.keyRefresh] })
  }, [isActive, nav.capture, onChrome, s])

  // Clicking a cell of the strip opens that screen — resolved against the SAME fit the row was drawn
  // from, so a click can never land on the screen beside the one under the pointer.
  const fit = stripFit(t, nav.screen, width)
  const rows = dashboardRows(height)
  usePointer(p => {
    if (nav.capture || !rows.strip || p.y !== 0 || !isActivation(p)) return
    const at = sourceAtColumn(fit, p.x)
    if (at !== null) nav.setScreen(DASHBOARD_SCREENS[at]!)
  }, { isActive })

  return (
    <DashboardView
      data={data}
      apiBase={source.kind === 'api' ? source.apiBase : null}
      s={t}
      width={width}
      height={height}
      nav={nav}
      connection={connection}
      notice={notice(source.kind, s)}
    />
  )
}

/**
 * What to say instead of the screens, when there is nothing to read.
 *
 * `loading` says nothing at all — the host answers in milliseconds, and a sentence that flashes once
 * per launch is noise. The other two are separate sentences on purpose: "it is not running" is
 * actionable and names the screen that starts it, while "its state could not be read" is the honest
 * form of an `unknown` service and must never be reported as the first.
 */
function notice(kind: ReturnType<typeof dashboardSource>['kind'], s: ControlStrings): string | undefined {
  switch (kind) {
    case 'api': return undefined
    case 'loading': return undefined
    case 'down': return s.dashDown
    case 'unknown': return s.dashUnknown
  }
}
