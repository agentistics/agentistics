import { hostWhich, resetHostWhich } from '../host-which'
import { appendFile, access, constants, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { redactSecrets, type HarnessId } from '@agentistics/core'
import { getChatDriver } from '../chat-drivers'
import { forgetHarnessVersion } from './harness-version'
import { resetHarnessAvailability } from './harness-available'
import { userSearchPath } from './user-path'
import {
  cleanInstallLine, HARNESS_INSTALLERS, installFailureDetail, installSearchPath, planHarnessInstall, planNodeInstall, parseHarnessVersion,
  type HarnessInstallFacts, type HarnessInstallPlan,
} from './harness-install-plan'
import { npmPrefixOf, UNINSTALL_PACKAGES, type HarnessUninstallFacts, type HarnessUninstallPlan, type UninstallHarness } from './harness-uninstall-plan'
import { liveRowsOf, previewUninstall, UNINSTALL_SAY, type UninstallChecks } from './harness-uninstall'

type Harness = Extract<HarnessId, 'claude' | 'codex' | 'gemini' | 'copilot' | 'opencode'>
type Event = { type: 'progress' | 'done' | 'error'; message: string; version?: string }
export type Runner = (argv: string[], onLine: (line: string, stream?: 'stdout' | 'stderr') => void, timeoutMs: number) => Promise<number>
export interface InstallDeps {
  runner: Runner
  /** Reads the machine facts the plan depends on. Injected so tests never look at the real PATH. */
  facts: () => Promise<HarnessInstallFacts>
  /** SSE comment interval. Injected so a test can watch one without waiting 15 s. */
  keepaliveMs?: number
}

/**
 * A comment line on the install stream while the installer is silent. `install.sh` downloads the
 * Claude Code binary with `curl -fsSL` — NO output for as long as the download takes — and
 * `Bun.serve`'s `idleTimeout` (60 s) closes a response that sends nothing for that long. On a
 * modest connection the stream was cut mid-download, the browser's read failed, and the dialog fell
 * back to "check your internet" with the route's own "Installing…" as the only line (reported on
 * macOS, 2.159.3). An SSE comment (`: …`) is ignored by the client and keeps the socket alive.
 */
export const INSTALL_KEEPALIVE_MS = 15_000

const LOG = join(homedir(), '.agentistics', 'harness-install.log')
let busy = false

/** The user-writable npm prefix test: `npm i -g` into a root-owned prefix would need sudo. */
async function npmPrefixWritable(env: Record<string, string | undefined>): Promise<boolean> {
  try {
    if (!hostWhich('npm', { PATH: env.PATH ?? '', negativeTtlMs: 30_000 })) return false
    const proc = Bun.spawn(['npm', 'prefix', '-g'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env })
    const prefix = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (!prefix) return false
    await access(join(prefix, 'lib'), constants.W_OK).catch(() => access(prefix, constants.W_OK))
    return true
  } catch { return false }
}

export function installEnv(): Record<string, string | undefined> {
  // The ':'-joined search path is a POSIX shape; on Windows the process's own environment stands.
  if (process.platform === 'win32') return { ...process.env }
  return { ...process.env, PATH: installSearchPath(userSearchPath()) }
}

async function realFacts(): Promise<HarnessInstallFacts> {
  const env = installEnv()
  const path = env.PATH ?? ''
  return {
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    nodePresent: hostWhich('node', { PATH: path, negativeTtlMs: 30_000 }) !== null && hostWhich('npm', { PATH: path, negativeTtlMs: 30_000 }) !== null,
    npmGlobalWritable: await npmPrefixWritable(env),
    npmPrefix: join(homedir(), '.local'),
  }
}

export async function harnessInstallPlan(id: Harness, input?: HarnessInstallFacts): Promise<HarnessInstallPlan> {
  return planHarnessInstall(id, input ?? await realFacts())
}

export async function defaultRunner(argv: string[], onLine: (line: string, stream?: 'stdout' | 'stderr') => void, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: installEnv() })
  const read = async (stream: ReadableStream<Uint8Array> | null, tag: 'stdout' | 'stderr') => {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      const lines = pending.split(/\r?\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line, tag)
    }
    if (pending.trim()) onLine(pending, tag)
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    await Promise.all([read(proc.stdout, 'stdout'), read(proc.stderr, 'stderr')])
    return await proc.exited
  } finally {
    clearTimeout(timer)
  }
}

function sse(events: AsyncGenerator<Event>, keepaliveMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null } }
  return new ReadableStream({
    async start(controller) {
      timer = setInterval(() => { try { controller.enqueue(encoder.encode(': keepalive\n\n')) } catch { stop() } }, keepaliveMs)
      try { for await (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
      finally { stop(); controller.close() }
    },
    cancel() { stop() },
  })
}

export interface UninstallDeps extends UninstallChecks {
  runner: Runner
  keepaliveMs?: number
}

async function realUninstallFacts(harness: UninstallHarness): Promise<HarnessUninstallFacts> {
  const home = homedir()
  const platform = process.platform
  const path = platform === 'win32' ? (process.env.PATH ?? '') : `${installEnv().PATH ?? ''}:${home}/.npm-global/bin`
  // Looked up fresh: this decides what gets deleted, so a remembered answer is not good enough.
  resetHostWhich()
  const binPath = hostWhich(harness, { PATH: path, negativeTtlMs: 0 })
  const real = binPath ? await realpath(binPath).catch(() => binPath) : null
  const pkg = UNINSTALL_PACKAGES[harness]
  const prefix = real ? npmPrefixOf(real, pkg) : null
  const prefixWritable = prefix
    ? await access(join(prefix, 'lib', 'node_modules'), constants.W_OK).then(() => true, () => false)
    : undefined
  const shimHasPackage = platform === 'win32' && binPath
    ? await access(join(dirname(binPath), 'node_modules', pkg)).then(() => true, () => false)
    : undefined
  return {
    platform, home, binPath, realPath: real,
    realHome: await realpath(home).catch(() => home),
    ...(prefixWritable === undefined ? {} : { prefixWritable }),
    ...(shimHasPackage === undefined ? {} : { shimHasPackage }),
  }
}

/** The fleet's live rows of this harness, then any process of it the fleet does not list. */
async function realLiveSessions(harness: UninstallHarness): Promise<string[]> {
  const { fleetSessionHub } = await import('./fleet-web')
  const rows = liveRowsOf(harness, (await (await fleetSessionHub()).refresh()).sessions)
  if (rows.length > 0) return rows
  const { scanProcesses } = await import('../live-sessions')
  const scan = await scanProcesses('other')
  // Where processes can be read at all, a failed read is "cannot tell", never "none".
  if (scan.unavailable && process.platform !== 'win32') throw new Error('process list unavailable')
  return scan.procs.filter(p => p.harness === harness)
    .map(p => `${p.cwd}${p.pid === undefined ? '' : ` (pid ${p.pid})`}`)
}

/** Is this server a descendant of a running process of this harness? */
async function realRunningInside(harness: UninstallHarness): Promise<boolean> {
  if (process.platform === 'win32') return false
  const { scanProcesses } = await import('../live-sessions')
  const pids = new Set((await scanProcesses('other')).procs.filter(p => p.harness === harness).map(p => p.pid))
  if (pids.size === 0) return false
  let pid = process.pid
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    let out = ''
    if (await defaultRunner(['ps', '-o', 'ppid=', '-p', String(pid)], line => { out += line }, 5_000) !== 0) return false
    pid = Number(out.trim())
    if (pids.has(pid)) return true
  }
  return false
}

function uninstallDeps(deps: Partial<UninstallDeps>): UninstallDeps {
  return {
    runner: deps.runner ?? defaultRunner,
    facts: deps.facts ?? realUninstallFacts,
    liveSessions: deps.liveSessions ?? realLiveSessions,
    runningInside: deps.runningInside ?? realRunningInside,
    keepaliveMs: deps.keepaliveMs,
  }
}

/**
 * GET  /api/harnesses/:id/uninstall?lang= — what would happen: removed, kept, or why not.
 * POST /api/harnesses/:id/uninstall — body `{confirmed: true}`; the install route's own lock, runner,
 * stream and log.
 */
export async function handleHarnessUninstallRoute(req: Request, id: string, deps: Partial<UninstallDeps> = {}): Promise<Response> {
  const resolved = uninstallDeps(deps)
  if (req.method !== 'GET') {
    return handleHarnessInstallRoute(req, id, 'uninstall', { runner: resolved.runner, keepaliveMs: resolved.keepaliveMs }, resolved)
  }
  if (!Object.hasOwn(HARNESS_INSTALLERS, id)) return json(404, { error: 'unknown_harness' })
  const lang = new URL(req.url).searchParams.get('lang') === 'en' ? 'en' : 'pt'
  try { return json(200, (await previewUninstall(id as UninstallHarness, resolved, lang)).view) }
  catch { return json(500, { error: 'uninstall_failed' }) }
}

/** The sentences the route itself says (the installer's own lines are passed through untouched). */
const SAY = {
  pt: { updating: 'Atualizando…', installing: 'Instalando…', node: 'Instalando o Node.js, que este assistente precisa…', nodeFail: 'Não consegui instalar o Node.js. Tente de novo.', fail: 'Não consegui terminar. Verifique a internet e tente de novo.', verifying: 'Verificando a versão…', noVersion: 'O assistente foi instalado, mas não consegui abri-lo para confirmar. Tente de novo; se persistir, reinicie o app.', done: 'Instalação concluída.' },
  en: { updating: 'Updating…', installing: 'Installing…', node: 'Installing Node.js, which this assistant needs…', nodeFail: 'Could not install Node.js. Try again.', fail: 'It did not finish. Check your internet connection and try again.', verifying: 'Checking the version…', noVersion: 'The assistant was installed, but I could not open it to confirm. Try again; if it persists, restart the app.', done: 'Installation complete.' },
} as const

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * POST /api/harnesses/:id/(install|update|uninstall) — body `{confirmed: true, installNode?: true}`.
 * Never runs without `confirmed` (the UI's confirmation modal is the only thing that sends it).
 * Streams SSE events: progress lines while the official installer runs, then `done` (with the
 * version read back from `<bin> --version`) or `error` with a plain-language sentence.
 */
export async function handleHarnessInstallRoute(
  req: Request, id: string, operation: 'install' | 'update' | 'uninstall',
  deps: Partial<InstallDeps> | Runner = {}, removalDeps?: UninstallDeps,
): Promise<Response> {
  const resolved: InstallDeps = typeof deps === 'function'
    ? { runner: deps, facts: realFacts }
    : { runner: deps.runner ?? defaultRunner, facts: deps.facts ?? realFacts, keepaliveMs: deps.keepaliveMs }
  const { runner } = resolved
  // opencode has no chat driver (its sessions run over ACP) but has an installer: the table is what decides.
  const known = Object.hasOwn(HARNESS_INSTALLERS, id) && (id === 'opencode' || !!getChatDriver(id as Exclude<Harness, 'opencode'>))
  if (!known) return json(404, { error: 'unknown_harness' })
  const body = await req.json().catch(() => null) as { confirmed?: boolean; installNode?: boolean; lang?: string } | null
  if (body?.confirmed !== true) return json(400, { error: 'confirmation_required' })
  const removal = operation === 'uninstall' ? removalDeps ?? uninstallDeps({ runner }) : undefined
  if (busy) return json(409, { error: 'install_in_progress', ...(removal ? { message: UNINSTALL_SAY[body.lang === 'en' ? 'en' : 'pt'].busy } : {}) })
  // Claimed BEFORE the first await below: two requests arriving together must not both pass.
  busy = true
  let facts: HarnessInstallFacts
  let plan: HarnessInstallPlan
  let removalPlan: HarnessUninstallPlan | undefined
  const wantsNode = body.installNode === true
  const lang = body.lang === 'en' ? 'en' : 'pt'
  const say = SAY[lang]
  try {
    if (removal) {
      // Checked again here: the dialog's preview is a moment old by the time somebody confirms.
      const checked = await previewUninstall(id as UninstallHarness, removal, lang)
      if (checked.view.reason !== 'ok' || !checked.plan.command) {
        busy = false
        return json(409, { error: checked.view.reason, message: checked.view.message })
      }
      removalPlan = checked.plan
      facts = { platform: process.platform, nodePresent: true, npmPrefix: '' }
      plan = { harness: id as Harness, reason: 'ok', verify: [] }
    } else {
      const op = operation === 'update' ? 'update' : 'install'
      facts = await resolved.facts()
      plan = planHarnessInstall(id as Harness, facts, op)
      if (plan.reason === 'node-required' && wantsNode) {
        const node = planNodeInstall(facts)
        if (node.reason !== 'ok') { busy = false; return json(400, { error: node.reason }) }
      } else if (plan.reason !== 'ok' || !plan.command) { busy = false; return json(400, { error: plan.reason }) }
    }
  } catch (err) {
    busy = false
    return json(500, { error: err instanceof Error ? err.message : 'install_failed' })
  }

  async function* events(): AsyncGenerator<Event> {
    const log = async (message: string) => { await appendFile(LOG, `${new Date().toISOString()} ${id} ${operation} ${redactSecrets(message)}\n`).catch(() => {}) }
    // Lines arrive from a callback; the generator drains them as they come, so the modal moves
    // while the installer runs instead of after it.
    const queue: string[] = []
    let wake: (() => void) | null = null
    // The last lines the installer wrote to stderr: what a failure is explained with.
    let stderrTail: string[] = []
    let spawnError: string | undefined
    const push = (raw: string, stream?: 'stdout' | 'stderr') => {
      const line = cleanInstallLine(raw)
      if (!line) return
      if (stream === 'stderr') stderrTail = [...stderrTail, line].slice(-3)
      void log(line); queue.push(line); wake?.()
    }
    async function* run(argv: string[], timeoutMs: number): AsyncGenerator<Event, number> {
      let code: number | null = null
      stderrTail = []; spawnError = undefined
      // A runner that THROWS (spawn failed: no such executable, a PATH without /bin) is a failure
      // with a reason, never a silent `1` — that swallow is how the macOS report showed nothing.
      const done = runner(argv, push, timeoutMs).then(
        c => { code = c; wake?.() },
        (err: unknown) => { spawnError = err instanceof Error ? err.message : String(err); code = 1; wake?.() },
      )
      while (code === null || queue.length > 0) {
        const next = queue.shift()
        if (next !== undefined) { yield { type: 'progress', message: next }; continue }
        await new Promise<void>(resolve => { wake = resolve; if (code !== null || queue.length > 0) resolve() })
      }
      await done
      await log(spawnError ? `spawn failed: ${cleanInstallLine(spawnError)}` : `exit code ${code}`)
      return code!
    }
    const failed = (base: string, code: number) =>
      ({ type: 'error' as const, message: `${base} ${installFailureDetail({ code, spawnError, stderrTail }, lang)}` })
    try {
      if (removal && removalPlan) {
        const words = UNINSTALL_SAY[lang]
        await log(`started: ${removalPlan.command!.join(' ')}`)
        yield { type: 'progress', message: words.removing }
        const code = yield* run(removalPlan.command!, 10 * 60_000)
        if (code !== 0) { yield { type: 'error', message: `${words.fail} ${installFailureDetail({ code, spawnError, stderrTail }, lang, 'uninstaller')}` }; return }
        yield { type: 'progress', message: words.verifying }
        const after = await removal.facts(id as UninstallHarness)
        // Whatever the outcome, what the pickers believe is now stale.
        forgetHarnessVersion()
        resetHarnessAvailability()
        if (after.binPath !== null && after.binPath === removalPlan.binPath) { yield { type: 'error', message: words.still }; return }
        await log(after.binPath ? `another copy at ${after.binPath}` : 'removed')
        yield { type: 'done', message: after.binPath ? words.other(after.binPath) : words.done }
        return
      }
      await log('started')
      let current = plan
      if (plan.reason === 'node-required') {
        yield { type: 'progress', message: say.node }
        const code = yield* run(planNodeInstall(facts).command!, 10 * 60_000)
        if (code !== 0) { yield failed(say.nodeFail, code); return }
        current = planHarnessInstall(id as Harness, { ...facts, nodePresent: true, npmGlobalWritable: false }, operation === 'update' ? 'update' : 'install')
      }
      yield { type: 'progress', message: operation === 'update' ? say.updating : say.installing }
      const code = yield* run(current.command!, 10 * 60_000)
      if (code !== 0) { yield failed(say.fail, code); return }
      yield { type: 'progress', message: say.verifying }
      let output = ''
      const verifyCode = await runner(current.verify, line => { output += `${line}\n` }, 30_000).catch(() => 1)
      const version = parseHarnessVersion(output)
      if (verifyCode !== 0 || !version) { yield { type: 'error', message: say.noVersion }; return }
      forgetHarnessVersion()
      // A harness that appeared must show in the picker now, not at the next server restart.
      resetHarnessAvailability()
      yield { type: 'done', message: say.done, version }
    } finally { busy = false }
  }
  return new Response(sse(events(), resolved.keepaliveMs ?? INSTALL_KEEPALIVE_MS), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
}
