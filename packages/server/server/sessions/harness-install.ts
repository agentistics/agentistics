import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { getChatDriver } from '../chat-drivers'
import { planHarnessInstall, parseHarnessVersion, type HarnessInstallFacts, type HarnessInstallPlan } from './harness-install-plan'

type Harness = Extract<HarnessId, 'claude' | 'codex' | 'gemini' | 'copilot'>
type Event = { type: 'progress' | 'done' | 'error'; message: string; version?: string }
type Runner = (argv: string[], onLine: (line: string) => void, timeoutMs: number) => Promise<number>

const LOG = join(homedir(), '.agentistics', 'harness-install.log')
let busy = false

function facts(): HarnessInstallFacts {
  const npmPrefix = join(homedir(), '.local')
  return {
    platform: process.platform,
    nodePresent: Bun.which('node') !== null && Bun.which('npm') !== null,
    npmGlobalWritable: (() => { try { return Bun.which('npm') !== null && process.getuid?.() !== 0 } catch { return false } })(),
    npmPrefix,
  }
}

export function harnessInstallPlan(id: Harness, input = facts()): HarnessInstallPlan {
  return planHarnessInstall(id, input)
}

async function defaultRunner(argv: string[], onLine: (line: string) => void, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const read = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      pending += next.value
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line.trim())
    }
    if (pending.trim()) onLine(pending.trim())
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

export async function handleHarnessInstallRoute(
  req: Request, id: string, operation: 'install' | 'update', runner: Runner = defaultRunner,
): Promise<Response> {
  const driver = getChatDriver(id as Harness)
  if (!driver || !['claude', 'codex', 'gemini', 'copilot'].includes(id)) return new Response(JSON.stringify({ error: 'unknown_harness' }), { status: 404 })
  const body = await req.json().catch(() => null) as { confirmed?: boolean } | null
  if (body?.confirmed !== true) return new Response(JSON.stringify({ error: 'confirmation_required' }), { status: 400 })
  if (busy) return new Response(JSON.stringify({ error: 'install_in_progress' }), { status: 409 })
  const plan = harnessInstallPlan(id as Harness)
  if (plan.reason !== 'ok' || !plan.command) return new Response(JSON.stringify({ error: plan.reason }), { status: 400 })
  busy = true
  async function* events(): AsyncGenerator<Event> {
    const log = async (message: string) => { await appendFile(LOG, `${new Date().toISOString()} ${id} ${operation} ${message}\n`).catch(() => {}) }
    try {
      yield { type: 'progress', message: operation === 'update' ? 'Atualizando…' : 'Instalando…' }
      await log('started')
      const code = await runner(plan.command!, line => { void log(line) }, 10 * 60_000)
      if (code !== 0) { yield { type: 'error', message: 'A instalação não terminou. Tente de novo.' }; return }
      yield { type: 'progress', message: 'Verificando a versão…' }
      let output = ''
      const verifyCode = await runner(plan.verify, line => { output += `${line}\n` }, 30_000)
      const version = parseHarnessVersion(output)
      if (verifyCode !== 0 || !version) { yield { type: 'error', message: 'Instalou, mas não consegui confirmar a versão. Tente de novo.' }; return }
      yield { type: 'done', message: 'Instalação concluída.', version }
    } finally { busy = false }
  }
  return new Response(sse(events()), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
}
