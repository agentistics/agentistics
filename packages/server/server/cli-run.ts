import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

const REAL_API_PORT = 47291
const REAL_WEB_PORT = 47292
const DEFAULT_TTL = '2h'
const THROWAWAY_PORT_BASE = 48100
const STATE_ROOT_NAME = 'agentistics-throwaway'

export function isRealAgentopPort(port: number): boolean { return port === REAL_API_PORT || port === REAL_WEB_PORT }

export type ThrowawayState = {
  name: string
  home: string
  apiPort: number
  webPort: number
  pid?: number
  unit?: string
  startedAt: string
  command: string[]
}

type RunOptions = { name: string; ttl: string; portOffset: number | null; remove: boolean; command: string[] }

function usage(): string {
  return `Usage: agentop run --rm [--ttl 2h] [--port-offset N] [--name x] -- <command...>
       agentop run --rm [--ttl 2h] [--port-offset N] [--name x]
       agentop run ls
       agentop run stop <name>`
}

function stateRoot(): string { return join(process.env.HOME || process.env.USERPROFILE || homedir(), '.cache', STATE_ROOT_NAME) }
function statePath(name: string): string { return join(stateRoot(), `${name}.json`) }
function safeName(value: string): string {
  const name = value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  if (!name) throw new Error('run name must contain letters, numbers, dot, underscore or hyphen')
  return name.slice(0, 48)
}

function parseTtl(value: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(value)
  if (!m) throw new Error(`invalid --ttl ${value}; use e.g. 30m, 2h or 1d`)
  const n = Number(m[1])
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]!]!
}

function parseArgs(args: string[]): RunOptions | { action: 'ls' } | { action: 'help' } | { action: 'stop'; name: string } {
  if (args[0] === '--help' || args[0] === '-h') return { action: 'help' }
  if (args[0] === 'ls') return { action: 'ls' }
  if (args[0] === 'stop') {
    if (!args[1]) throw new Error('run stop needs a name')
    return { action: 'stop', name: safeName(args[1]) }
  }
  let name = `run-${Date.now().toString(36)}`
  let ttl = DEFAULT_TTL
  let portOffset: number | null = null
  let remove = false
  let command: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { command = args.slice(i + 1); break }
    if (arg === '--rm') { remove = true; continue }
    if (arg === '--name') { name = safeName(args[++i] ?? ''); continue }
    if (arg === '--ttl') { ttl = args[++i] ?? ''; parseTtl(ttl); continue }
    if (arg === '--port-offset') {
      const raw = args[++i] ?? ''
      if (!/^\d+$/.test(raw)) throw new Error('--port-offset must be a non-negative integer')
      portOffset = Number(raw)
      continue
    }
    throw new Error(`unknown run option: ${arg}`)
  }
  if (!remove) throw new Error('agentop run requires --rm (throwaway runs are always explicit)')
  return { name, ttl, portOffset, remove, command }
}

async function freePort(preferred: number, reserved: Set<number>): Promise<number> {
  let port = Math.max(1024, preferred)
  for (let attempts = 0; attempts < 1000; attempts++) {
    while (isRealAgentopPort(port) || reserved.has(port)) port++
    if (port >= 65535) break
    const candidate = port
    const ok = await new Promise<boolean>(resolve => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (ok) return candidate
    port++
  }
  throw new Error('no free throwaway port is available')
}

function readStates(): ThrowawayState[] {
  try { return readdirSync(stateRoot()).flatMap(file => {
    try { return [JSON.parse(readFileSync(join(stateRoot(), file), 'utf8')) as ThrowawayState] } catch { return [] }
  }) } catch { return [] }
}

async function stopState(state: ThrowawayState): Promise<void> {
  if (state.unit && process.platform === 'linux' && existsSync('/run/systemd/system')) {
    const result = spawn('systemctl', ['--user', 'stop', state.unit], { stdio: 'ignore' })
    await new Promise<void>(resolve => { result.once('exit', () => resolve()); result.once('error', () => resolve()) })
  } else if (state.pid) {
    try { process.kill(-state.pid, 'SIGTERM') } catch { try { process.kill(state.pid, 'SIGTERM') } catch {} }
  }
  rmSync(state.home, { recursive: true, force: true })
  rmSync(statePath(state.name), { force: true })
  console.log(`removed ${state.home}`)
}

async function listRuns(): Promise<number> {
  for (const state of readStates()) {
    console.log(`${state.name}\tapi=${state.apiPort}\tweb=${state.webPort}\thome=${state.home}${state.unit ? `\tunit=${state.unit}` : `\tpid=${state.pid ?? '-'}`}`)
  }
  return 0
}

async function startRun(options: RunOptions): Promise<number> {
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 })
  if (existsSync(statePath(options.name))) throw new Error(`a throwaway run named ${options.name} already exists`)
  const home = mkdtempSync(join(stateRoot(), `${safeName(options.name)}-`))
  const agentistics = join(home, '.agentistics')
  mkdirSync(agentistics, { recursive: true, mode: 0o700 })
  for (const dir of ['.claude', '.codex', '.gemini', '.copilot']) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 })
  let apiPort: number
  let webPort: number
  try {
    const preferred = options.portOffset === null ? THROWAWAY_PORT_BASE : REAL_API_PORT + options.portOffset
    if (isRealAgentopPort(preferred) || isRealAgentopPort(preferred + 1)) {
      throw new Error(`--port-offset ${options.portOffset} would land on the real agentop ports ${REAL_API_PORT}/${REAL_WEB_PORT}; refused`)
    }
    apiPort = await freePort(preferred, new Set())
    webPort = await freePort(apiPort + 1, new Set([apiPort]))
  } catch (error) {
    rmSync(home, { recursive: true, force: true })
    throw error
  }
  const state: ThrowawayState = { name: options.name, home, apiPort, webPort, startedAt: new Date().toISOString(), command: options.command }
  const script = process.argv[1]
  const argv = options.command.length ? options.command : (script?.endsWith('.ts') || script?.endsWith('.js') ? [process.execPath, script, 'server'] : [process.execPath, 'server'])
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGENTISTICS_DIR: agentistics, PORT: String(apiPort), WEB_PORT: String(webPort), SERVE_STATIC: '1', AGENTISTICS_SERVER_FOREGROUND: '1', AGENTISTICS_EXPERIMENTAL: '0', TMUX_TMPDIR: join(home, 'tmp'), TMPDIR: join(home, 'tmp'), AGENTISTICS_THROWAWAY: options.name }
  mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 })
  const unit = `agentistics-throwaway-${options.name}.scope`
  const systemd = process.platform === 'linux' && !!process.env.XDG_RUNTIME_DIR && await commandExists('systemd-run')
  const childArgs = systemd ? ['--user', '--scope', '--unit', unit.replace(/\.scope$/, ''), '-p', 'MemoryMax=2G', '-p', `RuntimeMaxSec=${parseTtl(options.ttl)}`, '--', ...argv] : argv
  const child = spawn(systemd ? 'systemd-run' : argv[0]!, systemd ? childArgs : argv.slice(1), { env, stdio: 'inherit', detached: !systemd })
  state.pid = child.pid
  if (systemd) state.unit = unit
  writeFileSync(statePath(options.name), JSON.stringify(state, null, 2), { mode: 0o600 })
  console.log(`throwaway ${options.name}`)
  console.log(`  api:  http://localhost:${apiPort}`)
  console.log(`  web:  http://localhost:${webPort}`)
  console.log(`  home: ${home}`)
  console.log(`  stop: agentop run stop ${options.name}`)

  // One shared promise: a signal handler and the normal exit path both call this, and the second
  // caller must wait for the first one's removal instead of exiting the process under it.
  let cleaning: Promise<void> | undefined
  const cleanup = () => (cleaning ??= stopState(state))
  const childExit = new Promise<number>(resolve => { child.once('exit', (status, sig) => resolve(status ?? (sig ? 1 : 0))); child.once('error', () => resolve(1)) })
  const signal = async (sig: NodeJS.Signals) => { try { process.kill(child.pid!, sig) } catch {} ; await childExit; await cleanup(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)) }
  process.once('SIGINT', () => void signal('SIGINT'))
  process.once('SIGTERM', () => void signal('SIGTERM'))
  const ttlTimer = setTimeout(() => { try { process.kill(child.pid!, 'SIGTERM') } catch {} }, parseTtl(options.ttl) * 1000)
  const code = await childExit
  clearTimeout(ttlTimer)
  await cleanup()
  return code
}

async function commandExists(command: string): Promise<boolean> {
  const check = spawn('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' })
  return await new Promise(resolve => { check.once('exit', code => resolve(code === 0)); check.once('error', () => resolve(false)) })
}

export async function runRun(args: string[]): Promise<number> {
  try {
    const parsed = parseArgs(args)
    if ('action' in parsed) {
      if (parsed.action === 'help') { console.log(usage()); return 0 }
      if (parsed.action === 'ls') return listRuns()
      const stateFile = statePath(parsed.name)
      if (!existsSync(stateFile)) throw new Error(`no throwaway run named ${parsed.name}`)
      await stopState(JSON.parse(readFileSync(stateFile, 'utf8')) as ThrowawayState)
      return 0
    }
    return await startRun(parsed)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`)
    return 2
  }
}
