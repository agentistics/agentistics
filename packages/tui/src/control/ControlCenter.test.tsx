import React from 'react'
import { describe, test, expect } from 'bun:test'
import { render } from 'ink-testing-library'
import { ControlCenter } from './ControlCenter'
import type { ControlHost, ControlSessions, ControlStatus } from './types'

/**
 * What the cockpit draws in the second BEFORE `refresh()` answers.
 *
 * `refresh()` shells out to systemd and to docker, so it takes about a second on a real machine —
 * and every detach REMOUNTS this app, because attach and detach are two halves of one gesture and
 * the loop lives in `runStart`. Anything the screen cannot know during that second falls back to a
 * default, and for the sessions list that means the arrangement someone chose is replaced by the
 * shipped one and then swapped back in front of them: not an incomplete frame but a WRONG one,
 * about a choice the user made.
 *
 * The assertion is on the FIRST frame on purpose. It is the frame that was wrong, and it is the one
 * that needs nothing to have resolved — which also keeps this test standing in a full `bun test`
 * run, where `useData.scope.test.ts` has replaced React's hooks process-wide by the time this file
 * is reached.
 */

const FLEET: ControlSessions = { sessions: [], attention: 0, rang: [] }

const STORED: ControlStatus = {
  mode: 'solo',
  modeLabel: 'solo',
  services: [],
  version: '1.0.0',
  // What the user chose last time: by REPOSITORY, not the shipped default of by project.
  sessionView: {
    grouping: 'repo',
    showClosed: false,
    showExited: false,
    showUnfiled: true,
    showDone: false,
    onlyActive: true,
    layout: 'list',
  },
}

/**
 * A host mid-probe: it already knows what it read from disk, and has not finished looking at the
 * machine. That is the exact state every remount starts in.
 */
function probingHost(known: ControlStatus | null): ControlHost {
  const done = async () => ({ ok: true, message: '' })
  return {
    // Never answers — this is the one-second window the frame under test is drawn in.
    refresh: () => new Promise<ControlStatus>(() => {}),
    lastStatus: () => known,
    start: done,
    restart: done,
    stop: done,
    setMode: done,
    upgrade: done,
    pendingArchiveMode: async () => null,
    setArchiveMode: done,
    enableBoot: done,
    setLang: async () => {},
    setSessionView: async () => {},
    setMouse: async () => {},
    setSessionPollMs: async () => {},
    onOutput: () => () => {},
    readLog: async () => [],
    sessions: async () => FLEET,
  } as unknown as ControlHost
}

/**
 * Strip ANSI so assertions read against the visible text.
 *
 * The ESC byte is part of the pattern, and that is the whole point. This used to strip `[36m`
 * while LEAVING the `\x1b` in front of it, which was invisible for as long as no assertion
 * straddled a colour change: `GROUP repository` was drawn in one style, so the two words sat next
 * to each other and `toContain` matched. The moment the dimension VALUE got its own colour, a bare
 * `\x1b` landed between them and every one of these assertions failed against a frame that was
 * perfectly correct. A half-stripped frame is worse than an unstripped one — it reads as text right
 * up until it doesn't.
 *
 * Matches whole CSI sequences rather than only SGR (`…m`), so a cursor move or an erase cannot
 * reintroduce the same class of bug.
 */
function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')
}

const COLS = 100
const ROWS = 34

/** The first frame the cockpit draws, at a pinned size. */
function firstFrame(host: ControlHost): string {
  // `useTerminalSize` reads the REAL `process.stdout` while Ink lays out against the testing
  // library's own, so both are pinned — exactly as `scripts/preview.tsx` does it. Left to the
  // ambient size the frame is whatever the previous test file happened to leave behind, and a pane
  // too narrow to hold a heading proves nothing about which heading it is.
  const size = { columns: process.stdout.columns, rows: process.stdout.rows }
  Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true })
  const { lastFrame, unmount } = render(
    <ControlCenter host={host} lang="en" initial={{ tab: 'sessions' }} onExit={() => {}} />,
  )
  const frame = plain(lastFrame())
  unmount()
  Object.defineProperty(process.stdout, 'columns', { value: size.columns, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: size.rows, configurable: true })
  return frame
}

describe('ControlCenter — the frame drawn before the probe answers', () => {
  test('opens the sessions list on the arrangement the host already knows', () => {
    const frame = firstFrame(probingHost(STORED))
    expect(frame).toContain('GROUP repository')
    expect(frame).not.toContain('GROUP project')
    // The same seed carries the rest of what was already true — the header used to be blank for as
    // long as the probe ran.
    expect(frame).toContain('solo')
    expect(frame).toContain('v1.0.0')
  })

  test('falls back to the defaults on a first-ever launch, when nothing is known yet', () => {
    // `null` is not "slow", it is "never looked" — and then the shipped arrangement is the right
    // answer rather than a placeholder.
    const frame = firstFrame(probingHost(null))
    expect(frame).toContain('GROUP project')
  })
})

// ---------------------------------------------------------------------------
// GL-02 and GL-04, through the real shell
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A host whose fleet has two rows waiting on a person, and whose probe answers at once. */
function waitingHost(): ControlHost {
  const host = probingHost(STORED)
  return {
    ...host,
    refresh: async () => STORED,
    sessions: async () => ({ sessions: [], attention: 2, rang: [] }),
  } as unknown as ControlHost
}

async function mounted(host: ControlHost, tab: 'help' | 'logs') {
  const size = { columns: process.stdout.columns, rows: process.stdout.rows }
  Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true })
  const app = render(<ControlCenter host={host} lang="en" initial={{ tab }} onExit={() => {}} />)
  await sleep(60)
  const restore = () => {
    app.unmount()
    Object.defineProperty(process.stdout, 'columns', { value: size.columns, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: size.rows, configurable: true })
  }
  return { app, restore }
}

describe('ControlCenter — the attention counter and the key reference', () => {
  test('`● N need you` is in the header on a tab that is not the sessions screen (GL-02)', async () => {
    const { app, restore } = await mounted(waitingHost(), 'help')
    try {
      expect(plain(app.lastFrame())).toContain('● 2 need you')
    } finally {
      restore()
    }
  })

  test('`?` opens the key reference over the body, and `esc` puts the screen back (GL-04)', async () => {
    const { app, restore } = await mounted(waitingHost(), 'logs')
    try {
      app.stdin.write('?')
      await sleep(40)
      const open = plain(app.lastFrame())
      expect(open).toContain('help · every key')
      expect(open).toContain('EVERYWHERE')
      // The screen you were on is listed right after EVERYWHERE.
      expect(open.indexOf('LOGS')).toBeGreaterThan(open.indexOf('EVERYWHERE'))
      // While it is up the footer names only its own keys.
      expect(open).toContain('esc/? close')
      app.stdin.write('\u001b')
      await sleep(80)
      expect(plain(app.lastFrame())).not.toContain('help · every key')
    } finally {
      restore()
    }
  })
})
