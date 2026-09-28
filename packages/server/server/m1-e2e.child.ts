/**
 * m1-e2e.child.ts — the PROCESS the M1 end-to-end test starts, kills and starts again. It is the real
 * `agentop code` (`runCode`) over the real host (`createRuntimeHost`: sqlite store, file content
 * store, native tools, real policy), with exactly two doubles: the MODEL is a script read from a file
 * (no provider call, no key), and the journal is a JSONL file the parent can read. Test support only —
 * never imported by the product.
 *
 * Env: AGT_M1_DIR (state dir), AGT_M1_PHASE ('1' | '2'). argv: the `agentop code` arguments.
 * Phase 2 attaches a SECOND watcher to the resumed session before `runCode` drives it, and writes
 * every frame it sees to `watcher2.jsonl` — the "second surface" of §24.3.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromAnthropicStopReason, fromAnthropicUsage, type AgentisticsEvent } from '@agentistics/core'
import {
  createSessionHub,
  type InvocationResult,
  type ProviderClient,
  type ProviderContent,
  type ProviderRequest,
  type ProviderStreamEvent,
} from '@agentistics/runtime'
import { runCode } from './cli-code.ts'
import { createRuntimeHost } from './runtime-host.ts'

const dir = process.env.AGT_M1_DIR!
const phase = process.env.AGT_M1_PHASE!
const use = (id: string, name: string, input: unknown): ProviderContent => ({ type: 'tool_use', id, name, input })

const PATCH = [
  '*** Begin Patch', '*** Update File: hello.ts', '@@',
  "-export const greeting = 'hello'", "+export const greeting = 'hello, world'", '*** End Patch',
].join('\n')

const SCRIPTS: Record<string, ProviderContent[][]> = {
  '1': [
    [use('t1', 'file__read', { path: 'hello.ts' })],
    [use('t2', 'file__patch', { patch: PATCH })],
    [use('t3', 'shell__start', { command: 'cat hello.ts && sleep 120' })],
    [{ type: 'text', text: 'never reached' }],
  ],
  '2': [[{ type: 'text', text: 'resumed and done' }]],
}

function scriptedClient(turns: ProviderContent[][]): ProviderClient {
  const queue = [...turns]
  let n = 0
  return {
    provider: 'anthropic',
    adapterVersion: 'stub@1',
    capabilities: { streaming: true, editPolicy: 'verbatim' as never },
    async invokeOnce(): Promise<InvocationResult> { throw new Error('streams only') },
    stream(req: ProviderRequest, attempt: number) {
      appendFileSync(join(dir, `requests-${phase}.jsonl`), JSON.stringify({ messages: req.messages }) + '\n')
      const content = queue.shift()
      if (!content) throw new Error('script exhausted')
      n += 1
      async function* gen(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: 'started' }
        for (const c of content!) if (c.type === 'text') yield { type: 'text-delta', index: 0, text: c.text }
        const result: InvocationResult = {
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: new Date().toISOString(), latencyMs: 5, status: 'completed', messageId: `msg_${phase}_${n}`,
          servedModel: req.model, usage: fromAnthropicUsage({ input_tokens: 10, output_tokens: 5 }).usage,
          usageAnomalies: [], content: content!,
          stopReason: fromAnthropicStopReason(content!.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn'),
        }
        yield { type: 'end', result }
      }
      return gen()
    },
  }
}

const journal = {
  async append(events: readonly AgentisticsEvent[]) {
    for (const e of events) appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify(e) + '\n')
    return { written: events.length, duplicates: 0 }
  },
}

// ONE client for the process, so the script advances across runs rather than restarting.
const client = scriptedClient(SCRIPTS[phase]!)
const args = process.argv.slice(2)
const hub = createSessionHub()
let pump: Promise<void> | null = null
let stopWatch: (() => void) | null = null
const resumeAt = args.indexOf('--resume')
if (phase === '2' && resumeAt >= 0) {
  const w = hub.watch(args[resumeAt + 1]!)
  stopWatch = () => w.close()
  pump = (async () => {
    for await (const f of w) appendFileSync(join(dir, 'watcher2.jsonl'), JSON.stringify(f) + '\n')
  })()
}

// The parent answers each ask on stdin, so this process plays the terminal: it is what makes an
// ask reach a PERSON (the parent) instead of being denied for want of one.
const code = await runCode(args, {
  isTty: true,
  host: async (askerFor) => {
    const host = await createRuntimeHost({
      askerFor, hub, journal,
      dbPath: join(dir, 'sessions.db'),
      contentDir: join(dir, 'content'),
      clientFor: () => client,
      retry: { sleep: async () => {} },
    })
    return { host, content: host.content, journal: host.journal, runtimeVersion: host.runtimeVersion }
  },
})
stopWatch?.()
await pump
process.exit(code)
