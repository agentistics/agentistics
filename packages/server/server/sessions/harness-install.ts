import { appendFile, access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { getChatDriver } from '../chat-drivers'
import { forgetHarnessVersion } from './harness-version'
import { resetHarnessAvailability } from './harness-available'
import { userSearchPath } from './user-path'
import {
  cleanInstallLine, HARNESS_INSTALLERS, planHarnessInstall, planNodeInstall, parseHarnessVersion,
  type HarnessInstallFacts, type HarnessInstallPlan,
} from './harness-install-plan'

type Harness = Extract<HarnessId, 'claude' | 'codex' | 'gemini' | 'copilot'>
type Event = { type: 'progress' | 'done' | 'error'; message: string; version?: string }
export type Runner = (argv: string[], onLine: (line: string) => void, timeoutMs: number) => Promise<number>
export interface InstallDeps {
  runner: Runner
  /** Reads the machine facts the plan depends on. Injected so tests never look at the real PATH. */
  facts: () => Promise<HarnessInstallFacts>
}

const LOG = join(homedir(), '.agentistics', 'harness-install.log')
let busy = false

/** The user-writable npm prefix test: `npm i -g` into a root-owned prefix would need sudo. */
async function npmPrefixWritable(env: Record<string, string | undefined>): Promise<boolean> {
  try {
    if (!Bun.which('npm', { PATH: env.PATH ?? '' })) return false
    const proc = Bun.spawn(['npm', 'prefix', '-g'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env })
    const prefix = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (!prefix) return false
    await access(join(prefix, 'lib'), constants.W_OK).catch(() => access(prefix, constants.W_OK))
    return true
  } catch { return false }
}

export function installEnv(): Record<string, string | undefined> {
  return { ...process.env, PATH: userSearchPath() }
}

async function realFacts(): Promise<HarnessInstallFacts> {
  const env = installEnv()
  const path = env.PATH ?? ''
  return {
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    nodePresent: Bun.which('node', { PATH: path }) !== null && Bun.which('npm', { PATH: path }) !== null,
    npmGlobalWritable: await npmPrefixWritable(env),
    npmPrefix: join(homedir(), '.local'),
  }
}

export async function harnessInstallPlan(id: Harness, input?: HarnessInstallFacts): Promise<HarnessInstallPlan> {
  return planHarnessInstall(id, input ?? await realFacts())
}

async function defaultRunner(argv: string[], onLine: (line: string) => void, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: installEnv() })
  const read = async (stream: ReadableStream<Uint8Array> | null) => {
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
      for (const line of lines) if (line.trim()) onLine(line)
    }
    if (pending.trim()) onLine(pending)
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    await Promise.all([read(proc.stdout), read(proc.stderr)])
    return await proc.exited
  } finally {
    clearTimeout(timer)
  }
}

function sse(events: AsyncGenerator<Event>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      try { for await (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
      finally { controller.close() }
    },
  })
}

/** The sentences the route itself says (the installer's own lines are passed through untouched). */
const SAY = {
  pt: { updating: 'Atualizando…', installing: 'Instalando…', node: 'Instalando o Node.js, que este assistente precisa…', nodeFail: 'Não consegui instalar o Node.js. Tente de novo.', fail: 'Não consegui terminar. Verifique a internet e tente de novo.', verifying: 'Verificando a versão…', noVersion: 'O assistente foi instalado, mas não consegui abri-lo para confirmar. Tente de novo; se persistir, reinicie o app.', done: 'Instalação concluída.' },
  en: { updating: 'Updating…', installing: 'Installing…', node: 'Installing Node.js, which this assistant needs…', nodeFail: 'Could not install Node.js. Try again.', fail: 'It did not finish. Check your internet connection and try again.', verifying: 'Checking the version…', noVersion: 'The assistant was installed, but I could not open it to confirm. Try again; if it persists, restart the app.', done: 'Installation complete.' },
} as const

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * POST /api/harnesses/:id/(install|update) — body `{confirmed: true, installNode?: true}`.
 * Never runs without `confirmed` (the UI's confirmation modal is the only thing that sends it).
 * Streams SSE events: progress lines while the official installer runs, then `done` (with the
 * version read back from `<bin> --version`) or `error` with a plain-language sentence.
 */
export async function handleHarnessInstallRoute(
  req: Request, id: string, operation: 'install' | 'update',
  deps: Partial<InstallDeps> | Runner = {},
): Promise<Response> {
  const resolved: InstallDeps = typeof deps === 'function'
    ? { runner: deps, facts: realFacts }
    : { runner: deps.runner ?? defaultRunner, facts: deps.facts ?? realFacts }
  const { runner } = resolved
  const driver = Object.hasOwn(HARNESS_INSTALLERS, id) ? getChatDriver(id as Harness) : null
  if (!driver) return json(404, { error: 'unknown_harness' })
  const body = await req.json().catch(() => null) as { confirmed?: boolean; installNode?: boolean; lang?: string } | null
  if (body?.confirmed !== true) return json(400, { error: 'confirmation_required' })
  if (busy) return json(409, { error: 'install_in_progress' })
  // Claimed BEFORE the first await below: two requests arriving together must not both pass.
  busy = true
  let facts: HarnessInstallFacts
  let plan: HarnessInstallPlan
  const wantsNode = body.installNode === true
  const say = SAY[body.lang === 'en' ? 'en' : 'pt']
  try {
    facts = await resolved.facts()
    plan = planHarnessInstall(id as Harness, facts)
    if (plan.reason === 'node-required' && wantsNode) {
      const node = planNodeInstall(facts)
      if (node.reason !== 'ok') { busy = false; return json(400, { error: node.reason }) }
    } else if (plan.reason !== 'ok' || !plan.command) { busy = false; return json(400, { error: plan.reason }) }
  } catch (err) {
    busy = false
    return json(500, { error: err instanceof Error ? err.message : 'install_failed' })
  }

  async function* events(): AsyncGenerator<Event> {
    const log = async (message: string) => { await appendFile(LOG, `${new Date().toISOString()} ${id} ${operation} ${message}\n`).catch(() => {}) }
    // Lines arrive from a callback; the generator drains them as they come, so the modal moves
    // while the installer runs instead of after it.
    const queue: string[] = []
    let wake: (() => void) | null = null
    const push = (raw: string) => {
      const line = cleanInstallLine(raw)
      if (!line) return
      void log(line); queue.push(line); wake?.()
    }
    async function* run(argv: string[], timeoutMs: number): AsyncGenerator<Event, number> {
      let code: number | null = null
      const done = runner(argv, push, timeoutMs).then(c => { code = c; wake?.() }, () => { code = 1; wake?.() })
      while (code === null || queue.length > 0) {
        const next = queue.shift()
        if (next !== undefined) { yield { type: 'progress', message: next }; continue }
        await new Promise<void>(resolve => { wake = resolve; if (code !== null || queue.length > 0) resolve() })
      }
      await done
      return code!
    }
    try {
      await log('started')
      let current = plan
      if (plan.reason === 'node-required') {
        yield { type: 'progress', message: say.node }
        const code = yield* run(planNodeInstall(facts).command!, 10 * 60_000)
        if (code !== 0) { yield { type: 'error', message: say.nodeFail }; return }
        current = planHarnessInstall(id as Harness, { ...facts, nodePresent: true, npmGlobalWritable: false })
      }
      yield { type: 'progress', message: operation === 'update' ? say.updating : say.installing }
      const code = yield* run(current.command!, 10 * 60_000)
      if (code !== 0) { yield { type: 'error', message: say.fail }; return }
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
  return new Response(sse(events()), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
}

/** POST /api/fleet/harness-login — the harness's own login runs in an ordinary managed session. */
export async function handleHarnessLoginRoute(
  body: { harness?: unknown } | null, lang: 'pt' | 'en',
  spawn: (lang: 'pt' | 'en', body: { harness: string; cwd: string; label: string }) => Promise<{ ok: boolean; message: string; id?: string }>,
): Promise<{ status: number; body: { ok: boolean; message: string; id?: string } }> {
  const id = typeof body?.harness === 'string' ? body.harness : ''
  if (!Object.hasOwn(HARNESS_INSTALLERS, id)) return { status: 404, body: { ok: false, message: 'unknown_harness' } }
  const name = ({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' } as Record<string, string>)[id]!
  const out = await spawn(lang, { harness: id, cwd: homedir(), label: `${lang === 'pt' ? 'Entrar' : 'Sign in'} · ${name}` })
  return { status: 200, body: out }
}
