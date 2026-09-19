import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  aggregateState,
  bootModeFor,
  bootOptionsFor,
  buildService,
  logRuntime,
  needsProcessLinkRetry,
  parseBootState,
  parseContainerFacts,
  parseElapsedSeconds,
  pidsToKill,
  centralStartNotes,
  sessionsPollerOptions,
  startOptionsFor,
  targetRuntimes,
} from './cli-start'
import { cliStrings } from './cli-i18n'
import type { BootMechanism } from './cli-start'
import type { RuntimeId, ServiceRuntimeState } from '@agentistics/tui/control'
import type { SessionBackend } from './sessions/types'
import { readProcessConversation, resolveProcessLog } from './sessions/process-conversation'
import { stripComments } from './strip-comments'

// Regression for the "kill and restart" self-termination bug: the CLI health check
// (`isServerRunning` → fetch to PORT) leaves a keep-alive client socket open, so
// `lsof -ti tcp:PORT` returns BOTH the server pid AND the CLI's own pid. Killing the
// full list SIGTERM'd the CLI itself ("Terminated") before it could restart the server.
// pidsToKill must never include the caller's own pid.

test('pidsToKill excludes the caller own pid', () => {
  // server pid 172382 + CLI own pid 175302 (as observed via lsof)
  expect(pidsToKill('172382\n175302', 175302)).toEqual(['172382'])
})

test('pidsToKill keeps all other pids and trims blanks', () => {
  expect(pidsToKill('  100 \n 200 \n\n300 ', 999)).toEqual(['100', '200', '300'])
})

test('pidsToKill returns empty when only own pid is present', () => {
  expect(pidsToKill('4242', 4242)).toEqual([])
})

test('pidsToKill handles empty lsof output', () => {
  expect(pidsToKill('', 123)).toEqual([])
})

// The control center states a service's uptime, and an uptime it cannot establish must read as
// absent. Both parsers below therefore answer `undefined` for anything they do not fully recognise
// — never a zero, which on screen is indistinguishable from "started just now".

test('parseElapsedSeconds reads the GNU `etimes` spelling (whole seconds)', () => {
  expect(parseElapsedSeconds('8054\n')).toBe(8054)
})

test('parseElapsedSeconds reads the BSD `etime` spelling', () => {
  expect(parseElapsedSeconds('  02:14  ')).toBe(134)
  expect(parseElapsedSeconds('01:02:03')).toBe(3723)
  expect(parseElapsedSeconds('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
})

test('parseElapsedSeconds refuses anything it does not recognise', () => {
  expect(parseElapsedSeconds('')).toBeUndefined()
  expect(parseElapsedSeconds('ps: no such process')).toBeUndefined()
  expect(parseElapsedSeconds('ELAPSED')).toBeUndefined()
})

test('parseContainerFacts reads pid, start time and the published host port', () => {
  const facts = parseContainerFacts(
    '48213|2026-07-28T18:44:02.113905Z|47291/tcp=48080 27017/tcp=27017 ',
  )
  expect(facts.pid).toBe(48213)
  expect(facts.startedAt).toBe(Date.parse('2026-07-28T18:44:02.113905Z'))
  expect(facts.hostPort).toBe(48080)
})

// A stopped container really does inspect as pid 0 at docker's zero time; neither is a fact.
test('parseContainerFacts drops the zero pid and the zero time of a stopped container', () => {
  const facts = parseContainerFacts('0|0001-01-01T00:00:00Z|')
  expect(facts.pid).toBeUndefined()
  expect(facts.startedAt).toBeUndefined()
  expect(facts.hostPort).toBeUndefined()
})

// The machine container runs on host networking, so it publishes nothing — and losing the port
// must not cost us the pid and the start time that came back on the same line.
test('parseContainerFacts keeps pid and start time when no port is published', () => {
  const facts = parseContainerFacts('9001|2026-07-28T10:00:00Z|')
  expect(facts.pid).toBe(9001)
  expect(facts.startedAt).toBe(Date.parse('2026-07-28T10:00:00Z'))
  expect(facts.hostPort).toBeUndefined()
})

test('parseContainerFacts survives an empty or malformed inspect answer', () => {
  expect(parseContainerFacts('')).toEqual({ pid: undefined, startedAt: undefined, hostPort: undefined })
  expect(parseContainerFacts('<no value>|<no value>|')).toEqual({
    pid: undefined, startedAt: undefined, hostPort: undefined,
  })
})

// ---------------------------------------------------------------------------
// the logical service model
// ---------------------------------------------------------------------------
//
// `agentistics` is ONE service with two runtimes (`local` natively, `machine` in a container) that
// CLAUDE.md says must never both run — they read the same files and fight over the same port.
// Everything below is the arithmetic that turns three detected runtimes into the two rows the user
// thinks about, and the reason the screen can no longer offer to start a container copy of a server
// that is already running.

const EN = cliStrings('en')
const PT = cliStrings('pt')

const runtime = (over: Partial<ServiceRuntimeState> & Pick<ServiceRuntimeState, 'id'>): ServiceRuntimeState => ({
  kind: over.id === 'local' ? 'native' : 'docker',
  state: 'down',
  available: true,
  ...over,
})

const NATIVE_UP = runtime({ id: 'local', state: 'up', pid: 48213, webUrl: 'http://localhost:47292' })
const NATIVE_DOWN = runtime({ id: 'local' })
const MACHINE_UP = runtime({ id: 'machine', state: 'up', pid: 71120 })
const MACHINE_DOWN = runtime({ id: 'machine' })
const MACHINE_NO_DOCKER = runtime({ id: 'machine', state: 'unknown', available: false, reason: EN.dockerMissing })
const MACHINE_BLIND = runtime({ id: 'machine', state: 'unknown', reason: EN.dockerUnreachable })

// -- target resolution -------------------------------------------------------
// A logical target acts on whichever runtime is ACTUALLY up. Getting this wrong is not cosmetic:
// `stop('agentistics')` resolving to the wrong half leaves the thing the user asked to stop running.

test('a logical target resolves to the runtime that is actually up', () => {
  expect(targetRuntimes('agentistics', ['local'])).toEqual(['local'])
  expect(targetRuntimes('agentistics', ['machine'])).toEqual(['machine'])
})

test('a logical target names BOTH runtimes when both are up — the conflict is acted on whole', () => {
  expect(targetRuntimes('agentistics', ['local', 'machine'])).toEqual(['local', 'machine'])
})

test('a logical target names nothing when the service is down, so the caller can say so', () => {
  expect(targetRuntimes('agentistics', [])).toEqual([])
  expect(targetRuntimes('agentistics', ['central'])).toEqual([])
})

test('a runtime target acts on exactly that runtime — how a conflict gets broken', () => {
  expect(targetRuntimes('local', ['local', 'machine'])).toEqual(['local'])
  expect(targetRuntimes('machine', ['local', 'machine'])).toEqual(['machine'])
})

test('a runtime target that is not running resolves to nothing', () => {
  expect(targetRuntimes('machine', ['local'])).toEqual([])
})

test("'all' is every running runtime, in canonical order, and never a stopped one", () => {
  expect(targetRuntimes('all', ['central', 'machine', 'local'])).toEqual(['local', 'machine', 'central'])
  expect(targetRuntimes('all', [])).toEqual([])
})

test("the central's service and runtime names mean the same thing", () => {
  expect(targetRuntimes('central', ['central'])).toEqual(['central'])
})

// -- log resolution ----------------------------------------------------------

test('a logical log source reads whichever runtime is up', () => {
  expect(logRuntime('agentistics', ['machine'])).toBe('machine')
  expect(logRuntime('agentistics', ['local'])).toBe('local')
})

test('with both up the log follows the declared preference rather than a coin toss', () => {
  expect(logRuntime('agentistics', ['local', 'machine'])).toBe('local')
})

// The most useful log of a server that is NOT running is the file the last one left behind.
test('a logical log source with nothing up falls back to the primary runtime', () => {
  expect(logRuntime('agentistics', [])).toBe('local')
  expect(logRuntime('central', [])).toBe('central')
})

test('a runtime log source reads that runtime whatever is up — the Logs screen selector', () => {
  expect(logRuntime('machine', ['local'])).toBe('machine')
  expect(logRuntime('local', ['machine'])).toBe('local')
})

// -- state aggregation -------------------------------------------------------

test('a service is up when any runtime is up', () => {
  expect(aggregateState([NATIVE_DOWN, MACHINE_UP])).toEqual({ state: 'up' })
})

test('a service is down only when every runtime is confidently down', () => {
  expect(aggregateState([NATIVE_DOWN, MACHINE_DOWN])).toEqual({ state: 'down' })
})

test('an undetectable runtime makes the service unknown, and carries its reason', () => {
  expect(aggregateState([NATIVE_DOWN, MACHINE_BLIND])).toEqual({
    state: 'unknown',
    reason: EN.dockerUnreachable,
  })
})

// Without docker there is no container to be uncertain about, so the honest `unknown` must not
// spread: otherwise every box without docker would read `agentistics ? unknown` forever.
test('a runtime this box cannot run at all does not make the service unknown', () => {
  expect(aggregateState([NATIVE_DOWN, MACHINE_NO_DOCKER])).toEqual({ state: 'down' })
})

test('a running runtime outranks an undetectable one — up is a fact, unknown is not', () => {
  expect(aggregateState([NATIVE_UP, MACHINE_BLIND])).toEqual({ state: 'up' })
})

// -- the assembled row -------------------------------------------------------

test('a running service offers NO start at all — only restart/stop/open remain', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_DOWN], EN)
  expect(svc.state).toBe('up')
  expect(svc.startOptions).toEqual([])
  expect(svc.running).toEqual(['local'])
  expect(svc.active?.id).toBe('local')
  expect(svc.active?.pid).toBe(48213)
  expect(svc.conflict).toBeUndefined()
})

test('a stopped service keeps its row and offers exactly the starts this box can perform', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_DOWN, MACHINE_DOWN], EN)
  expect(svc.state).toBe('down')
  expect(svc.active).toBeUndefined()
  // Every runtime that can run now offers BOTH shapes — attached and detached — not just `local`.
  expect(svc.startOptions.map(o => [o.runtime, o.how, o.label])).toEqual([
    ['local', 'fg', EN.optForeground],
    ['local', 'bg', EN.optBackground],
    ['machine', 'fg', EN.optDockerForeground],
    ['machine', 'bg', EN.optDockerBackground],
  ])
})

test('a runtime this box cannot run is not offered as a start that could not possibly work', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_DOWN, MACHINE_NO_DOCKER], EN)
  expect(svc.startOptions.map(o => o.runtime)).toEqual(['local', 'local'])
})

test('the Docker central offers one shape — background — with no plan or a Docker plan', () => {
  const svc = buildService('central', EN.svcCentral, [runtime({ id: 'central' })], EN)
  expect(svc.startOptions).toEqual([
    { runtime: 'central', how: 'bg', label: EN.optCentral, hint: EN.optCentralHint, offersBoot: true },
  ])
  for (const centralPlan of ['script', 'image', 'init'] as const) {
    expect(startOptionsFor('central', EN, { centralPlan })).toEqual([
      { runtime: 'central', how: 'bg', label: EN.optCentral, hint: EN.optCentralHint, offersBoot: true },
    ])
  }
})

// A native central (external Mongo, standalone/no-repo) is the ONE case `runCentral` can run the
// binary directly instead of Docker — see `planCentralStart` in cli-central.ts. It offers BOTH
// shapes, neither of which carries `offersBoot`: foreground because it holds the terminal, and
// background because no native-central systemd unit exists yet (see the field's own doc).
test('a native-capable central offers foreground AND background, and only the detached one boots', () => {
  const opts = startOptionsFor('central', EN, { centralPlan: 'native' })
  expect(opts.map(o => o.how)).toEqual(['fg', 'bg'])
  // A foreground start holds the terminal, so "bring it back at boot" is not a thing it can be.
  expect(opts[0]!.offersBoot).toBeUndefined()
  // The detached one DOES now: `serviceCommandFor` composes the unit from the configured central
  // runtime, so a natively started central gets a unit that runs it natively. It used to install
  // the Docker one — a boot mechanism that did not match what was actually running — which is why
  // the option was withheld entirely.
  expect(opts[1]!.offersBoot).toBe(true)
  expect(opts.every(o => o.centralRuntime === 'native')).toBe(true)
})

// One verb per SHAPE. The screen used to show a single "Start" whose meaning was inferred from
// what happened to be on disk, so a user holding a checkout could not ask for the published image.
test('every available central shape becomes its own start verb', () => {
  const opts = startOptionsFor('central', EN, {
    centralRuntimes: [
      { id: 'docker-image', available: true },
      { id: 'docker-build', available: true },
      { id: 'native', available: false, reason: 'bundled-mongo' },
    ],
  })
  expect(opts.map(o => o.centralRuntime)).toEqual(['docker-image', 'docker-build'])
  // A Docker central's `up` returns once the container is up: there is no attached shape to offer.
  expect(opts.every(o => o.how === 'bg')).toBe(true)
})

// The other half of "a verb that cannot work is not offered": an absence with no explanation reads
// as a broken screen.
test('a withheld shape is explained in a sentence rather than offered and refused', () => {
  const notes = centralStartNotes([
    { id: 'docker-image', available: true },
    { id: 'docker-build', available: false, reason: 'no-checkout' },
    { id: 'native', available: false, reason: 'bundled-mongo' },
  ], EN)
  expect(notes).toHaveLength(2)
  expect(notes[0]).toContain('checkout')
  expect(notes[1]).toContain('external database')
  expect(centralStartNotes(undefined, EN)).toEqual([])
  expect(centralStartNotes([{ id: 'native', available: true }], EN)).toEqual([])
})

// Everything that has to happen AROUND a start is stated with the start, because this side is the
// one that knows it. The screen used to re-derive all three from `option.runtime !== 'local'`,
// which is this model restated in the layer that draws boxes — and wrong the day a second runtime
// takes a port.
test('a start states what must happen around it: the port, the gate, the boot unit', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_DOWN, MACHINE_DOWN], EN)
  const [fg, bg, dockerFg, dockerBg] = svc.startOptions

  // Both runtimes bind the same host ports (native directly, the container via host networking),
  // so every option here would collide with a `local` that came up in the meantime.
  expect(fg!.blockedBy).toBe('local')
  expect(bg!.blockedBy).toBe('local')
  expect(dockerFg!.blockedBy).toBe('local')
  expect(dockerBg!.blockedBy).toBe('local')

  // The consent gate belongs to the process that will be writing history here — the CLI itself
  // for the native runtime, the containerized server (never this CLI) for the Docker one.
  expect([fg!.asksArchive, bg!.asksArchive]).toEqual([true, true])
  expect(dockerFg!.asksArchive).toBeUndefined()
  expect(dockerBg!.asksArchive).toBeUndefined()

  // Only a DETACHED option is worth a boot unit, and only where a real mechanism exists — which is
  // now true for both runtimes: `local` background installs `agentop-server`, `machine` background
  // installs `agentop-machine`. Neither foreground offers it: both hold this session's terminal
  // (directly, or under `suspend` until Ctrl-C) rather than outliving it.
  expect(bg!.offersBoot).toBe(true)
  expect(dockerBg!.offersBoot).toBe(true)
  expect(fg!.offersBoot).toBeUndefined()
  expect(dockerFg!.offersBoot).toBeUndefined()
})

// The state the screen must never tidy away: showing one of the two would have the user act on a
// half-truth about a machine where two copies are fighting over the same port and the same files.
test('both runtimes up is reported as a conflict that NAMES them, not as one of them', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_UP], EN)
  expect(svc.state).toBe('up')
  expect(svc.running).toEqual(['local', 'machine'])
  expect(svc.conflict).toContain('native')
  expect(svc.conflict).toContain('docker')
  // A word, not a colour: the row is painted danger, and colour alone carries nothing.
  expect(svc.conflict).toContain('conflict')
  expect(svc.startOptions).toEqual([])
})

// The sentence is drawn into the detail pane, which on a narrow terminal is under thirty columns
// and truncates from the right. Leading with the word and both names is what keeps a conflict from
// reading, at exactly those sizes, as a red line naming one runtime.
test('the conflict names the word and BOTH runtimes before it can be cut', () => {
  for (const s of [EN, PT]) {
    const svc = buildService('agentistics', s.svcAgentistics, [NATIVE_UP, MACHINE_UP], s)
    const head = (svc.conflict ?? '').slice(0, 26)
    // `conflict` / `conflito` — the same word in both languages, and it leads the sentence.
    expect(head.toLowerCase()).toMatch(/^conflic?t/)
    expect(head).toContain('native')
    expect(head).toContain('docker')
  }
})

// -- the restarts, and the rebuild that must not be offered where it cannot work ----------------

test('a stopped service offers no restart at all — the mirror of a running one offering no start', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_DOWN, MACHINE_DOWN], EN, {
    // Everything a rebuild needs is here; there is simply nothing running to restart.
    rebuild: { local: true, machine: true },
  })
  expect(svc.restartOptions).toEqual([])
})

test('a running service offers the plain bounce and, where possible, a rebuild', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_DOWN], EN, {
    rebuild: { local: true },
  })
  expect(svc.restartOptions).toEqual([
    { target: 'agentistics', rebuild: false, label: EN.optRestart, hint: EN.optRestartHint },
    { target: 'agentistics', rebuild: true, label: EN.optRebuild, hint: EN.optRebuildNativeHint },
  ])
})

// The rule this exists for: `bun run bin` needs the repo checkout and the machine's rebuild needs
// its compose file. Offering a verb that fails on principle is worse than not offering it, because
// the user pressed it on the screen's word.
test('without the pieces a rebuild needs, the rebuild is ABSENT rather than offered and failing', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_DOWN], EN)
  expect(svc.restartOptions.map(o => o.rebuild)).toEqual([false])
  expect(svc.restartOptions.map(o => o.label)).toEqual([EN.optRestart])
})

// A rebuild is only offered for what is RUNNING: the machine container can be rebuilt on this box,
// but rebuilding a container that is down is a start, and the start options are where that lives.
test('a rebuild is offered per RUNNING runtime, not per runtime that could rebuild', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_DOWN], EN, {
    rebuild: { local: false, machine: true },
  })
  expect(svc.restartOptions.map(o => o.rebuild)).toEqual([false])
})

// "Rebuild it" has no single meaning while the same program is running twice — and rebuilding both
// would leave the conflict exactly where it was. Same shape as the per-runtime stops beside them.
test('a conflict names the runtime each rebuild acts on', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_UP], EN, {
    rebuild: { local: true, machine: true },
  })
  expect(svc.restartOptions).toEqual([
    { target: 'agentistics', rebuild: false, label: EN.optRestart, hint: EN.optRestartHint },
    { target: 'local', rebuild: true, label: 'Rebuild & restart (native)', hint: EN.optRebuildNativeHint },
    { target: 'machine', rebuild: true, label: 'Rebuild & restart (docker)', hint: EN.optRebuildDockerHint },
  ])
})

test('the restarts are localized, and a container says what a rebuild means for a container', () => {
  const svc = buildService('central', PT.svcCentral, [runtime({ id: 'central', state: 'up' })], PT, {
    rebuild: { central: true },
  })
  expect(svc.restartOptions.map(o => o.label)).toEqual(['Reiniciar', 'Reconstruir & reiniciar'])
  expect(svc.restartOptions[1]!.hint).toBe(PT.optRebuildDockerHint)
})

test('a conflict offers a stop per runtime, so it can be broken without guessing', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_UP], EN)
  expect(svc.stopOptions).toEqual([
    { runtime: 'local', label: 'Stop (native)' },
    { runtime: 'machine', label: 'Stop (docker)' },
  ])
})

test('a single running runtime is not a conflict and offers no per-runtime stop', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_UP, MACHINE_DOWN], EN)
  expect(svc.stopOptions).toEqual([])
})

test('the conflict sentence and the start options are localized', () => {
  const svc = buildService('agentistics', PT.svcAgentistics, [NATIVE_UP, MACHINE_UP], PT)
  expect(svc.conflict).toBe('conflito: native + docker rodando juntos — pare um')
  const down = buildService('agentistics', PT.svcAgentistics, [NATIVE_DOWN, MACHINE_DOWN], PT)
  expect(down.startOptions.map(o => o.label)).toEqual([
    'Iniciar (neste terminal)', 'Iniciar (background)',
    'Iniciar (docker, neste terminal)', 'Iniciar (docker, background)',
  ])
})

test('an undetectable service still says why, and is still startable', () => {
  const svc = buildService('agentistics', EN.svcAgentistics, [NATIVE_DOWN, MACHINE_BLIND], EN)
  expect(svc.state).toBe('unknown')
  expect(svc.reason).toBe(EN.dockerUnreachable)
  expect(svc.startOptions.map(o => o.runtime)).toEqual<RuntimeId[]>(['local', 'local', 'machine', 'machine'])
})

// ---------------------------------------------------------------------------
// boot state — the one fact on this screen that only an OS probe can answer
// ---------------------------------------------------------------------------

test('parseBootState reads the words systemd actually prints', () => {
  expect(parseBootState('enabled')).toBe('on')
  expect(parseBootState('enabled-runtime\n')).toBe('on')
  expect(parseBootState('linked')).toBe('on')
  expect(parseBootState('disabled')).toBe('off')
  expect(parseBootState('masked')).toBe('off')
})

test('parseBootState never INVENTS an off — an unknown answer is silence', () => {
  // This is the whole reason the field is optional. A detail pane that says "does not start at
  // boot" because systemd was never asked is a fact the user acts on by installing a unit they
  // already have — the same rule the dashboard applies to a capability it cannot measure.
  for (const out of ['', '   ', 'not-found', 'static', 'indirect', 'alias', 'generated', 'transient',
    'Failed to get unit file state for agentop-server.service: No such file or directory']) {
    expect(parseBootState(out)).toBeUndefined()
  }
})

test('parseBootState reads the FIRST line, which is where systemd puts the word', () => {
  expect(parseBootState('enabled\nsome trailing noise')).toBe('on')
})

test('buildService says nothing about boot unless it was told', () => {
  const s = cliStrings('en')
  const runtimes: ServiceRuntimeState[] = [
    { id: 'local', kind: 'native', state: 'down', available: true },
  ]
  expect(buildService('agentistics', s.svcAgentistics, runtimes, s).boot).toBeUndefined()
  expect(buildService('agentistics', s.svcAgentistics, runtimes, s, { boot: 'on' }).boot).toBe('on')
  expect(buildService('agentistics', s.svcAgentistics, runtimes, s, { boot: 'off' }).boot).toBe('off')
})

// ---------------------------------------------------------------------------
// the BOOT switch — both positions, and the absences that must stay absences
// ---------------------------------------------------------------------------
//
// The bug these cover, stated once: `enableBoot` wrote a systemd user unit and nothing in the
// product could take it away. A user who stopped their central because they were finished with it
// got it back on the next boot — and on the next login that starts the user's systemd manager —
// with nothing on screen naming what had brought it back. A switch with one position is not a
// switch, and `bootOptionsFor` is the thing that has to have both.

const BOOT_S = cliStrings('en')

const mech = (over: Partial<BootMechanism> = {}): BootMechanism => ({
  unit: 'agentop-server.service',
  runtime: 'local',
  mech: 'native',
  on: false,
  installable: true,
  ...over,
})

test('a registered mechanism offers to be REMOVED, and only that', () => {
  const opts = bootOptionsFor([mech({ on: true })], BOOT_S, true, 'agentistics')
  expect(opts.map(o => o.enable)).toEqual([false])
  // Never both positions of one switch: a row offering "start at boot" beside "do not start at
  // boot" asks the user which of two facts about the same unit is the true one.
  expect(opts).toHaveLength(1)
})

test('an unregistered mechanism offers to be WRITTEN, and only that', () => {
  const opts = bootOptionsFor([mech({ on: false })], BOOT_S, true, 'agentistics')
  expect(opts.map(o => o.enable)).toEqual([true])
})

test('every sentence NAMES the unit — both directions, and the one asked after a stop', () => {
  const [off] = bootOptionsFor([mech({ on: true })], BOOT_S, true, 'agentistics')
  const [on] = bootOptionsFor([mech({ on: false })], BOOT_S, true, 'agentistics')
  // This is the honest trail. A confirmation that says "it will not come back" without saying what
  // was bringing it back leaves the user with nothing to go and look at.
  expect(off!.confirm).toContain('agentop-server.service')
  expect(off!.confirmAfterStop).toContain('agentop-server.service')
  expect(off!.confirmAfterStop).toContain('agentistics')
  expect(on!.confirm).toContain('agentop-server.service')
})

test('only a REMOVAL carries the after-stop sentence', () => {
  // There is no such moment for the other direction: nothing offers to register a boot unit on the
  // way out of stopping something.
  const [on] = bootOptionsFor([mech({ on: false })], BOOT_S, true, 'agentistics')
  expect(on!.confirmAfterStop).toBeUndefined()
})

test('a unit this box could not WRITE is absent, never present and failing', () => {
  // `serviceCommandFor` answers null when the file the ExecStart would point at is not here, and a
  // unit whose ExecStart cannot resolve is a service systemd restarts every five seconds forever.
  expect(bootOptionsFor([mech({ on: false, installable: false })], BOOT_S, true, 'x')).toEqual([])
  // Removing one that IS registered never needs the file — it only unlinks.
  expect(bootOptionsFor([mech({ on: true, installable: false })], BOOT_S, true, 'x')).toHaveLength(1)
})

test('a platform with no user systemd offers NOTHING, whatever the mechanisms say', () => {
  // Absence is absence, the same rule `ControlService.boot` follows: macOS and Windows are not
  // wired up at all, so a verb there would refuse on principle.
  expect(bootOptionsFor([mech({ on: true }), mech({ on: false })], BOOT_S, false, 'x')).toEqual([])
})

test('both mechanisms of agentistics get their own verb, each naming its runtime', () => {
  // The case that makes this a list rather than a flag: the native unit is registered and the
  // container's is not, so the two verbs point in opposite directions on one service.
  const opts = bootOptionsFor([
    mech({ unit: 'agentop-server.service', runtime: 'local', mech: 'native', on: true }),
    mech({ unit: 'agentop-machine.service', runtime: 'machine', mech: 'docker', on: false }),
  ], BOOT_S, true, 'agentistics')
  expect(opts.map(o => o.runtime)).toEqual(['local', 'machine'])
  expect(opts.map(o => o.enable)).toEqual([false, true])
  expect(opts[0]!.label).toContain('native')
  expect(opts[1]!.label).toContain('docker')
})

test('a service with one mechanism names no runtime on its verb', () => {
  // "Start at boot (docker)" on the central would invite the question "as opposed to what?".
  const [only] = bootOptionsFor([mech({ mech: '', runtime: 'central', on: false })], BOOT_S, true, 'c')
  expect(only!.label).not.toContain('(')
})

// `enableBoot` and `disableBoot` must resolve the same press to the same unit, or the switch turns
// one mechanism on and a different one off.
test('bootModeFor sends the docker runtime to the docker unit and everything else to the native one', () => {
  expect(bootModeFor('agentistics', 'machine')).toBe('machine')
  expect(bootModeFor('agentistics', 'local')).toBe('server')
  // The manual verb has no runtime to name — it has always meant the native server.
  expect(bootModeFor('agentistics', undefined)).toBe('server')
})

test('the central has ONE mechanism, whatever runtime is named', () => {
  for (const runtime of [undefined, 'central', 'local', 'machine'] as const) {
    expect(bootModeFor('central', runtime)).toBe('central')
  }
})

test('buildService carries the unit only beside a boot state it actually has', () => {
  const runtimes: ServiceRuntimeState[] = [
    { id: 'local', kind: 'native', state: 'down', available: true },
  ]
  const known = buildService('agentistics', 'agentistics', runtimes, BOOT_S, {
    boot: 'on', bootUnit: 'agentop-server.service',
  })
  expect(known.bootUnit).toBe('agentop-server.service')
  // A box whose init system could not be asked says NOTHING about boot — so a unit name there would
  // be a fact about a question nobody could answer.
  const unknown = buildService('agentistics', 'agentistics', runtimes, BOOT_S, {
    bootUnit: 'agentop-server.service',
  })
  expect(unknown.boot).toBeUndefined()
  expect(unknown.bootUnit).toBeUndefined()
})

test('boot options are offered whatever the service state, unlike starts and restarts', () => {
  // The asymmetry is the point: "should this come back after a reboot" is a question about the
  // FUTURE and is just as answerable while the thing is running as while it is stopped.
  const up: ServiceRuntimeState[] = [{ id: 'local', kind: 'native', state: 'up', available: true }]
  const options = bootOptionsFor([mech({ on: true })], BOOT_S, true, 'agentistics')
  const running = buildService('agentistics', 'agentistics', up, BOOT_S, { bootOptions: options })
  expect(running.startOptions).toEqual([])
  expect(running.bootOptions).toHaveLength(1)
})

// FIXWAVE 1, Finding 3: `linkProcessConversationSoon` (the actual trigger call inside
// `spawnManaged`, the one piece of the sessions-web-conversation-link fix with no test anywhere)
// is not itself exported or easily driven without a real backend — but the DECISION of whether it
// should run at all is pure, and this is the seam. Deleting the call site's `if
// (needsProcessLinkRetry(...))` guard, or getting its condition wrong, is now something a test can
// catch without spawning anything real.
test('needsProcessLinkRetry fires only for a harness with a process-log route and no id yet', () => {
  // antigravity: the one harness with a `HARNESS_PROCESS_LOGS` entry and no `assignId` — the exact
  // shape the retry exists for.
  expect(needsProcessLinkRetry('antigravity', undefined)).toBe(true)
})

test('needsProcessLinkRetry is a no-op once assignId/resumeId already settled the link', () => {
  // claude and copilot always have a `conversationId` by the time this is asked (their SpawnSpec
  // has `assignId`), so retrying would cost a `/proc` sweep and a `scanProcesses()` every spawn for
  // nothing — this is what stops that, and it is asked with the id ALREADY set, the real shape
  // `spawnManaged` calls it in.
  expect(needsProcessLinkRetry('claude', 'c-1')).toBe(false)
  expect(needsProcessLinkRetry('copilot', 'c-1')).toBe(false)
  // Antigravity itself, once linked by any route (a future assignId, or an earlier attempt of this
  // very loop), must not keep retrying either.
  expect(needsProcessLinkRetry('antigravity', 'agy-1')).toBe(false)
})

test('needsProcessLinkRetry is a no-op for a harness with no process-log route at all', () => {
  // codex/kimi/gemini have neither `assignId` nor a `HARNESS_PROCESS_LOGS` entry — scheduling the
  // retry for them would spend the whole ~12s budget finding nothing, poll after poll.
  for (const harness of ['codex', 'kimi', 'gemini'] as const) {
    expect(needsProcessLinkRetry(harness, undefined)).toBe(false)
  }
})

// FIXWAVE 1 round 2, Finding 1 (CRITICAL): the collision guard in `sessions-host.ts`'s poll loop is
// entirely gated on `if (o.resolveProcessLog)`, and `resolveProcessLog` was never one of the options
// `ensureSessionsPoller` passed to `createSessionsPoller` for the production, continuous `/api/fleet`
// poller — despite being imported in this very file and used inline inside the spawn-time retry.
// Every unit test that exercised the collision guard constructed `createSessionsPoller({ …,
// resolveProcessLog: async () => … })` directly, so nothing ever asserted the REAL wiring carried it
// — round 2's reviewer live-reproduced the exact cross-link this whole fix wave exists to prevent
// (two antigravity sessions started together, sharing one log by second, cross-linked to the same
// conversation on one ordinary poll) against the running server. `sessionsPollerOptions` is the exact
// object `ensureSessionsPoller` hands to `createSessionsPoller`; asserting against IT rather than
// re-deriving the same facts is what makes this fail the moment the real wiring regresses.
test('the production poller wiring carries resolveProcessLog — the collision guard\'s own input', () => {
  const fakeBackend = {} as SessionBackend
  const opts = sessionsPollerOptions(fakeBackend)
  expect(opts.backend).toBe(fakeBackend)
  // Identity, not merely "a function": a wrapper that silently drops the pid/harness or swallows
  // errors differently from the real reader would pass a `typeof === 'function'` check and still be
  // wrong. Same for the two others the collision guard is built from.
  expect(opts.resolveProcessLog).toBe(resolveProcessLog)
  expect(opts.readProcessConversation).toBe(readProcessConversation)
  expect(typeof opts.recordConversation).toBe('function')
})

/**
 * `linkProcessConversationSoon` — the spawn-time retry (FIXWAVE 1's own doc-comment calls it "the
 * whole of the fix") — does real `/proc` and tmux I/O and is not exported, so it cannot safely be
 * driven from a unit test (this suite never spawns a real backend — see the housekeeping rule that
 * keeps these tests off the owner's live tmux socket). Round 1's Finding 3 named exactly this: the
 * one line in `spawnManaged` that triggers it — `if (needsProcessLinkRetry(...))
 * linkProcessConversationSoon(id, req.harness)` — was exercised by no test, and deleting it left the
 * entire suite green (round 2 re-confirmed this by planting it). The DECISION is already covered by
 * `needsProcessLinkRetry`'s own tests above; what was missing is proof the real `spawnManaged` still
 * ACTS on it. This scans the real, comment-stripped source of `spawnManaged` for the actual call —
 * matching `response-policy-composition.test.ts`'s pattern for the identical problem (a wiring gap a
 * type checker and a green suite both miss) — so a plant of the call site fails this test rather than
 * passing silently a second time.
 */
function extractTopLevelFunction(src: string, name: string): string {
  const signature = `function ${name}(`
  const start = src.indexOf(signature)
  if (start === -1) throw new Error(`no top-level function named "${name}" found`)
  // The parameter list itself can hold an inline object TYPE (`req: { harness: HarnessId, … }`),
  // whose own `{`/`}` would fool a plain `indexOf('{', start)` into treating the parameter's brace
  // as the function's body — so the parameter list is closed by PAREN depth alone, ignoring braces
  // entirely, before the body's opening brace is even looked for.
  let depth = 0
  let i = start + signature.length - 1
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break } }
  }
  if (depth !== 0) throw new Error(`unbalanced parameter list for "${name}"`)
  const bodyOpen = src.indexOf('{', i)
  if (bodyOpen === -1) throw new Error(`no opening brace found for "${name}"`)
  const bodyClose = src.indexOf('\n}', bodyOpen)
  if (bodyClose === -1) throw new Error(`no top-level closing brace found for "${name}"`)
  return src.slice(start, bodyClose)
}

test('spawnManaged still fires the process-link retry when needsProcessLinkRetry says so', () => {
  const src = stripComments(readFileSync(join(import.meta.dir, 'cli-start.ts'), 'utf8'))
  const body = extractTopLevelFunction(src, 'spawnManaged')

  // Sanity check first, so the assertions below are not vacuously true against the wrong slice.
  expect(body).toContain('backend.spawn(')

  expect(body).toContain('needsProcessLinkRetry(')
  const gateIndex = body.indexOf('needsProcessLinkRetry(')
  // The trigger call must appear close after the gate — inside the `if` it guards, not merely
  // somewhere else in the function.
  const after = body.slice(gateIndex, gateIndex + 200)
  expect(after).toContain('linkProcessConversationSoon(')
})
