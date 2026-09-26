#!/usr/bin/env bun
/**
 * record-anthropic-fixtures.ts — the OWNER-RUN recorder for B1.5's fixtures.
 *
 * spec: docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §15 B1.5, §6.3.3 ("Fixtures").
 *
 * Makes ONE real, billed Anthropic call per invocation and writes the raw exchange to
 * `packages/server/test/fixtures/provider/anthropic/<scenario>.recorded.json`. An agent session
 * never runs this (§6.1); the owner does, with the key already stored by `agentop provider key set`.
 *
 * Usage:
 *   bun packages/server/scripts/record-anthropic-fixtures.ts plain
 *   bun packages/server/scripts/record-anthropic-fixtures.ts cache-write
 *   bun packages/server/scripts/record-anthropic-fixtures.ts cache-read     # within 5 min of cache-write
 *   options: --model <id>   (default claude-haiku-4-5-20251001, the cheapest current model)
 *            --force        overwrite an existing <scenario>.recorded.json
 *
 * THE KEY IS NEVER IN THIS FILE'S HANDS. The call goes through the real `invokeOnce`, whose default
 * resolver reads the key through `credentials.ts` and unwraps it inside `anthropic/client.ts` — the
 * one file allowed to. This script never names a header, never calls the unwrap, never reads the
 * environment. The cache scenarios need a `cache_control` marker `ProviderRequest` cannot express
 * yet; instead of touching the client (B1.4's), the script hands `invokeOnce` a `fetchImpl` that
 * edits the outgoing JSON BODY only (`init.body`) and forwards `init` otherwise untouched.
 *
 * WHAT IS WRITTEN goes through the same allowlist the runtime uses: the exchange is read back from
 * the content-addressed capture `invokeOnce` already wrote (headers allowlisted by `raw.ts` at the
 * transport), the headers are passed through `allowlistHeaders` AGAIN, and the whole document is
 * scanned by `assertFixtureClean` before a byte reaches the fixtures directory. A scan hit aborts
 * with nothing written.
 *
 * COST: one call each. `plain` is a few tokens. The cache scenarios send a ~8k-token system prompt
 * (a cache write is billed at 1.25x input; a read at 0.1x) — cents on Haiku 4.5.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactSecrets } from '@agentistics/core'
import { invokeOnce } from '../server/provider/anthropic/client.ts'
import { allowlistHeaders } from '../server/provider/anthropic/raw.ts'
import type { ProviderRequest } from '../server/provider/client.ts'

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/provider/anthropic',
)

export const SCENARIOS = ['plain', 'cache-write', 'cache-read'] as const
export type Scenario = (typeof SCENARIOS)[number]

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Substrings that must never appear in a fixture, lower-cased and compared case-insensitively.
 * Spelled out (not derived) so the list a reviewer reads is the list that runs.
 */
export const FORBIDDEN_NEEDLES: readonly string[] = [
  'sk-ant-',
  'x-api-key',
  'authorization',
  'anthropic-organization-id',
  'anthropic-workspace-id',
  'set-cookie',
  'cookie',
  'bearer ',
]

/**
 * Throws when `text` carries anything a fixture may not: a forbidden needle, or anything
 * `@agentistics/core`'s `redactSecrets` would rewrite (its patterns are the repo's one definition of
 * "secret-shaped"). Returns nothing; the only success is not throwing.
 */
export function assertFixtureClean(text: string): void {
  const hay = text.toLowerCase()
  const hits = FORBIDDEN_NEEDLES.filter(n => hay.includes(n))
  if (hits.length > 0) throw new Error(`fixture refused: contains ${hits.map(h => JSON.stringify(h)).join(', ')}`)
  if (redactSecrets(text) !== text) throw new Error('fixture refused: redactSecrets would rewrite part of it')
}

/** ~8k tokens of deterministic, non-degenerate text — above every model's minimum cacheable prompt. */
function paddedSystem(): string {
  const lines: string[] = ['You are a terse archivist. The index below is reference material; answer in one word.']
  for (let i = 1; i <= 500; i++) {
    lines.push(`Entry ${i}: the item catalogued under shelf ${i % 17}, bay ${i % 23} was accessioned in year ${1900 + (i % 120)}.`)
  }
  return lines.join('\n')
}

function buildRequest(scenario: Scenario, model: string): ProviderRequest {
  const base = {
    model,
    correlation: { invocationId: `inv_record_${scenario.replace('-', '_')}` },
    credential: { provider: 'anthropic' as const, id: 'default' },
  }
  if (scenario === 'plain') {
    return { ...base, maxTokens: 32, messages: [{ role: 'user', content: 'Reply with exactly: Hello.' }] }
  }
  return {
    ...base,
    maxTokens: 16,
    system: paddedSystem(),
    messages: [{ role: 'user', content: 'Reply with the single word: Noted.' }],
  }
}

/**
 * Marks the last `system` block `cache_control: {type: 'ephemeral'}` by editing `init.body` only.
 * Throws BEFORE calling `inner` when the body is not the shape expected, so a surprise costs no
 * request. `input` and every other `init` field (headers included) are forwarded as received.
 */
export function withCacheControl(inner: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof init?.body !== 'string') throw new Error('recorder: request body is not a JSON string; refusing to send')
    const body = JSON.parse(init.body) as { system?: unknown }
    if (!Array.isArray(body.system) || body.system.length === 0) {
      throw new Error('recorder: request has no system blocks to mark; refusing to send')
    }
    const last = body.system[body.system.length - 1] as Record<string, unknown>
    last.cache_control = { type: 'ephemeral' }
    return inner(input, { ...init, body: JSON.stringify(body) })
  }) as typeof fetch
}

function parseArgs(argv: string[]): { scenario: Scenario; model: string; force: boolean } {
  const scenario = argv.find(a => !a.startsWith('--'))
  if (!SCENARIOS.includes(scenario as Scenario)) {
    throw new Error(`usage: record-anthropic-fixtures.ts <${SCENARIOS.join('|')}> [--model <id>] [--force]`)
  }
  const mi = argv.indexOf('--model')
  const model = mi >= 0 ? argv[mi + 1] : DEFAULT_MODEL
  if (model === undefined || model.startsWith('--')) throw new Error('--model needs a value')
  return { scenario: scenario as Scenario, model, force: argv.includes('--force') }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function record(argv: string[]): Promise<void> {
  const { scenario, model, force } = parseArgs(argv)
  const outPath = join(FIXTURE_DIR, `${scenario}.recorded.json`)
  if (!force && (await exists(outPath))) {
    throw new Error(`${outPath} exists; pass --force to replace it`)
  }

  const captureDir = await mkdtemp(join(tmpdir(), 'agentistics-fixture-capture-'))
  try {
    const usesCache = scenario !== 'plain'
    const result = await invokeOnce(buildRequest(scenario, model), 1, {
      captureDir,
      ...(usesCache ? { fetchImpl: withCacheControl(fetch) } : {}),
    })

    if (result.status === 'failed') {
      const hint =
        result.error.userCode === 'provider.no_credential'
          ? ' — store a key first: `agentop provider key set anthropic`'
          : ''
      throw new Error(
        `call failed: kind=${result.error.kind} code=${result.error.userCode} request-id=${result.requestId ?? 'none'}${hint}`,
      )
    }
    if (result.capture === undefined) throw new Error('call succeeded but no capture was written; nothing to record')

    const u = result.usage
    if (scenario === 'plain' && (u.cacheRead > 0 || u.cacheWrite > 0)) {
      throw new Error(`plain call reported cache activity (read ${u.cacheRead}, write ${u.cacheWrite}); not recording it as "plain"`)
    }
    if (scenario === 'cache-write' && u.cacheWrite === 0) {
      throw new Error(
        'no cache write happened — the prompt may be under this model\'s minimum cacheable size. ' +
          'Nothing recorded. Try `--model claude-sonnet-5`.',
      )
    }
    if (scenario === 'cache-read' && u.cacheRead === 0) {
      throw new Error('no cache read happened — run `cache-write` first and this within 5 minutes. Nothing recorded.')
    }

    const captured = JSON.parse(
      await readFile(join(captureDir, result.capture.sha256.slice(0, 2), result.capture.sha256), 'utf8'),
    ) as { status: number; headers: Record<string, string>; body: string }

    const document = {
      meta: {
        provenance: 'recorded',
        scenario,
        recordedAt: new Date().toISOString(),
        requestedModel: model,
      },
      status: captured.status,
      headers: allowlistHeaders(captured.headers),
      body: captured.body,
    }
    const text = JSON.stringify(document, null, 2) + '\n'
    assertFixtureClean(text)

    await mkdir(FIXTURE_DIR, { recursive: true })
    await writeFile(outPath, text, { mode: 0o644 })
    console.log(
      `recorded ${scenario} -> ${outPath}\n` +
        `  message ${result.messageId}  request-id ${result.requestId ?? 'none'}\n` +
        `  input ${u.input}  output ${u.output}  cacheRead ${u.cacheRead}  cacheWrite ${u.cacheWrite}` +
        (u.cacheWriteByTtl ? `  ttl 5m ${u.cacheWriteByTtl.ephemeral5m} / 1h ${u.cacheWriteByTtl.ephemeral1h}` : ''),
    )
  } finally {
    await rm(captureDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  record(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
