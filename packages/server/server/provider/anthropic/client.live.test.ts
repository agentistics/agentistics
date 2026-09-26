/**
 * client.live.test.ts — B1.7: `agentop provider try anthropic`.
 *
 * TWO parts, and only the second can spend money:
 *
 *  1. The verb against a STUB client — always runs, network-free. It pins the order the emitter
 *     promises (`model.invoked` first), what is printed, that an unreported counter prints as "not
 *     reported" and never as `0` (D21), and that a call which cannot be made leaves no event behind.
 *
 *  2. The LIVE call — runs ONLY when `AGENTISTICS_LIVE_ANTHROPIC=1` AND a key is stored. One call to
 *     the cheapest model, `max_tokens` 16, recorded in a throwaway journal. When it does not run it
 *     says why, in words, and bun reports it as SKIPPED — never as a pass. `bun test` (the
 *     pre-commit hook) therefore never spends money. The OWNER runs it, with their own key and a
 *     spend limit set in the Anthropic console (spec §6.6).
 *
 * This is a `*.test.ts`, so `provider-secrets.lint.test.ts` does not walk it; the one `process.env`
 * read below is the opt-in switch, never a credential.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent, ProviderUsage } from '@agentistics/core'
import { runProvider, TRY_DEFAULT_MODEL, TRY_MAX_TOKENS, TRY_PROMPT, type ProviderCliDeps } from '../../cli-provider.ts'
import { openJournal } from '../../journal/journal'
import type { Journal } from '../../journal/types'
import { PROVIDER_KEYS_DIR } from '../../config.ts'
import { validateKeyShape } from '../credential-plan.ts'
import { resolveCredential, storeCredential } from '../credentials.ts'
import type { InvocationResult, ProviderClient, ProviderRequest } from '../client.ts'

const FAKE_KEY = 'sk-ant-' + 'live' + 'q'.repeat(40)
expect(validateKeyShape(FAKE_KEY).ok).toBe(true)

const cleanups: string[] = []
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true })
})

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(d)
  return d
}

async function readAll(j: Journal): Promise<AgentisticsEvent[]> {
  return (await j.readFrom(0, 100)).events
}

interface Run { code: number; out: string[]; err: string[]; journal: Journal; events: () => Promise<AgentisticsEvent[]> }

async function runTry(args: string[], over: Partial<ProviderCliDeps>, journalDir: string): Promise<Run> {
  const journal = await openJournal({ path: join(journalDir, 'journal.db') })
  const out: string[] = []
  const err: string[] = []
  const deps: Partial<ProviderCliDeps> = {
    stdout: l => out.push(l),
    stderr: l => err.push(l),
    isCentral: async () => false,
    flagOn: () => true,
    openJournal: async () => journal,
    ...over,
  }
  const code = await runProvider(['try', ...args], deps)
  return { code, out, err, journal, events: () => readAll(journal) }
}

function completed(req: ProviderRequest, attempt: number, usage: ProviderUsage): InvocationResult {
  return {
    invocationId: req.correlation.invocationId, attempt, provider: 'anthropic',
    requestedModel: req.model, startedAt: new Date().toISOString(), latencyMs: 12,
    requestId: 'req_stub', status: 'completed', messageId: 'msg_stub', servedModel: req.model,
    usage, usageAnomalies: [], stopReason: { kind: 'end-turn' }, content: [{ type: 'text', text: 'ok' }],
  }
}

function stub(usage: ProviderUsage, seen: ProviderRequest[] = [], before?: () => Promise<void>): ProviderClient {
  return {
    provider: 'anthropic', adapterVersion: 'stub-1', capabilities: { streaming: false, editPolicy: 'none' as never },
    async invokeOnce(req, attempt) { await before?.(); seen.push(req); return completed(req, attempt, usage) },
  }
}

async function keyDir(): Promise<string> {
  const dir = await tmp('agentop-try-keys-')
  const r = await storeCredential('anthropic', FAKE_KEY, { dir })
  expect(r.ok).toBe(true)
  return dir
}

describe('agentop provider try — against a stub client (no network)', () => {
  test('sends the fixed tiny prompt, journals invoked BEFORE the call, then completed', async () => {
    const dir = await keyDir(); const jd = await tmp('agentop-try-j-')
    const seen: ProviderRequest[] = []
    let journaledBeforeCall: string[] = []
    let jref: Journal | undefined
    const client = stub(
      { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 }, seen,
      async () => { journaledBeforeCall = (await readAll(jref!)).map(e => e.type) },
    )
    const journal = await openJournal({ path: join(jd, 'journal.db') })
    jref = journal
    const out: string[] = []
    const code = await runProvider(['try', 'anthropic'], {
      stdout: l => out.push(l), stderr: () => {}, isCentral: async () => false, flagOn: () => true,
      dir, client, openJournal: async () => journal,
    })
    expect(code).toBe(0)
    expect(journaledBeforeCall).toEqual(['model.invoked'])
    expect(seen).toHaveLength(1)
    expect(seen[0]!.model).toBe(TRY_DEFAULT_MODEL)
    expect(seen[0]!.maxTokens).toBe(TRY_MAX_TOKENS)
    expect(seen[0]!.maxTokens).toBeLessThanOrEqual(64)
    expect(seen[0]!.messages).toEqual([{ role: 'user', content: TRY_PROMPT }])
    expect((await readAll(journal)).map(e => e.type)).toEqual(['model.invoked', 'model.completed'])
    const text = out.join('\n')
    expect(text).toContain('request-id: req_stub')
    expect(text).toContain('journaled: yes')
    expect(text).not.toContain(FAKE_KEY)
    journal.close()
  })

  test('an unreported counter prints as "not reported" and is ABSENT in the event — never 0 (D21)', async () => {
    const dir = await keyDir(); const jd = await tmp('agentop-try-j-')
    const r = await runTry(['anthropic', '--model', 'claude-sonnet-5'], {
      dir, client: stub({ input: 9, output: 2, cacheRead: 0, cacheWrite: 0, missing: ['cacheRead', 'cacheWrite'] }),
    }, jd)
    expect(r.code).toBe(0)
    const text = r.out.join('\n')
    expect(text).toContain('cacheRead: not reported by the provider')
    expect(text).toContain('cacheWrite: not reported by the provider')
    expect(text).toContain('input: 9')
    const done = (await r.events()).find(e => e.type === 'model.completed')!
    const usage = (done.data as { usage: Record<string, number> }).usage
    expect(usage).toEqual({ input: 9, output: 2 })
    expect('cacheRead' in usage).toBe(false)
    r.journal.close()
  })

  test('a failed call is journaled as model.failed with no usage, and exits 1', async () => {
    const dir = await keyDir(); const jd = await tmp('agentop-try-j-')
    const client: ProviderClient = {
      provider: 'anthropic', adapterVersion: 'stub-1', capabilities: { streaming: false, editPolicy: 'none' as never },
      async invokeOnce(req, attempt) {
        return {
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: new Date().toISOString(), latencyMs: 3, requestId: 'req_bad', status: 'failed',
          error: { kind: 'authentication', retryable: false } as never,
        }
      },
    }
    const r = await runTry(['anthropic'], { dir, client }, jd)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('authentication')
    expect((await r.events()).map(e => e.type)).toEqual(['model.invoked', 'model.failed'])
    expect(JSON.stringify(await r.events())).not.toContain('"usage"')
    r.journal.close()
  })

  test('with no key stored it refuses in words and journals NOTHING', async () => {
    const dir = await tmp('agentop-try-empty-'); const jd = await tmp('agentop-try-j-')
    const seen: ProviderRequest[] = []
    const r = await runTry(['anthropic'], { dir, client: stub({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, seen) }, jd)
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no key stored')
    expect(seen).toHaveLength(0)
    expect(await r.events()).toHaveLength(0)
    r.journal.close()
  })

  test('refuses when the flag is off, on a central, for an unknown provider, and for stray arguments', async () => {
    const jd = await tmp('agentop-try-j-')
    const client = stub({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })
    expect((await runTry(['anthropic'], { flagOn: () => false, client }, jd)).code).toBe(1)
    expect((await runTry(['anthropic'], { isCentral: async () => true, client }, jd)).code).toBe(1)
    expect((await runTry(['nope'], { client }, jd)).code).toBe(2)
    expect((await runTry(['anthropic', '--max-tokens', '900'], { client }, jd)).code).toBe(2)
    expect((await runTry(['anthropic', 'extra'], { client }, jd)).code).toBe(2)
    expect((await runTry(['anthropic', '--model'], { client }, jd)).code).toBe(2)
  })
})

// ── the live call ───────────────────────────────────────────────────────────────────────────────

const OPT_IN = process.env.AGENTISTICS_LIVE_ANTHROPIC === '1'
const keyStored = OPT_IN && (await resolveCredential('anthropic')).ok
const skipReason = !OPT_IN
  ? 'AGENTISTICS_LIVE_ANTHROPIC is not "1" — no call made, no money spent'
  : !keyStored
    ? `AGENTISTICS_LIVE_ANTHROPIC=1 but no usable key is stored in ${PROVIDER_KEYS_DIR} — run \`agentop provider key set anthropic\``
    : ''

if (skipReason) console.log(`[client.live.test] SKIPPED — ${skipReason}`)

describe('agentop provider try — LIVE (one real, billed call)', () => {
  const t = skipReason ? test.skip : test
  t(skipReason ? `live call SKIPPED: ${skipReason}` : 'one call: model.invoked + model.completed, counters as reported', async () => {
    const jd = await tmp('agentop-live-j-'); const cd = await tmp('agentop-live-cap-')
    const r = await runTry(['anthropic'], { captureDir: cd }, jd)
    const printed = [...r.out, ...r.err].join('\n')
    console.log(printed)
    expect(r.code).toBe(0)

    const events = await r.events()
    expect(events.map(e => e.type)).toEqual(['model.invoked', 'model.completed'])
    const done = events[1]!
    const data = done.data as {
      providerRequestId?: string; usage: Record<string, unknown>; modelServed?: string; latencyMs: number
    }
    expect(data.providerRequestId).toMatch(/^msg_/)
    expect(data.modelServed?.length ?? 0).toBeGreaterThan(0)

    // D21: a counter the provider REPORTED is a non-negative integer; one it did not is ABSENT, and
    // the printed report agrees with the event on which is which.
    for (const c of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const notReported = printed.includes(`${c}: not reported by the provider`)
      if (notReported) expect(c in data.usage).toBe(false)
      else {
        expect(Number.isInteger(data.usage[c])).toBe(true)
        expect(data.usage[c] as number).toBeGreaterThanOrEqual(0)
      }
    }
    // A real answer consumed input and produced output, so those two must have been reported.
    expect(data.usage.input as number).toBeGreaterThan(0)
    expect(data.usage.output as number).toBeGreaterThan(0)
    // Nothing the key or a prompt could leak through: the event carries no credential shape.
    expect(JSON.stringify(events)).not.toMatch(/sk-ant-/)
    expect(printed).not.toMatch(/sk-ant-/)
    r.journal.close()
  }, 60_000)
})
