/**
 * cli-provider-models.test.ts — `agentop provider models <endpoint>` over injected deps. No network,
 * no disk: the resolver and the lister are stubs.
 */
import { describe, expect, test } from 'bun:test'
import type { CredentialHandle } from '@agentistics/runtime'
import {
  runProviderModels,
  type ProviderModelsCliDeps,
  type ProviderModelsListResult,
} from './cli-provider-models.ts'

const KEY_SENTINEL = 'sk-or-' + 'sentinel-' + 'z'.repeat(40)
const KNOWN = ['openai', 'openrouter', 'deepseek', 'litellm', '9router', 'ollama'] as const

function sentinelHandle(): { handle: CredentialHandle; reveals: () => number } {
  let n = 0
  return {
    handle: { provider: 'openai-compatible', fingerprint: 'sha256:00000000', reveal: () => { n++; return KEY_SENTINEL } },
    reveals: () => n,
  }
}

interface Harness {
  deps: ProviderModelsCliDeps
  out: string[]
  err: string[]
  listed: Array<{ endpointId: string; baseUrl: string; credential: CredentialHandle | null }>
  resolved: string[]
}

function harness(over: Partial<ProviderModelsCliDeps> = {}, result?: ProviderModelsListResult): Harness {
  const out: string[] = []
  const err: string[] = []
  const listed: Harness['listed'] = []
  const resolved: string[] = []
  const { handle } = sentinelHandle()
  const deps: ProviderModelsCliDeps = {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    isCentral: async () => false,
    flagOn: () => true,
    knownEndpoints: KNOWN,
    resolveEndpoint: async (id) => {
      resolved.push(id)
      return { ok: true, endpoint: { baseUrl: 'https://openrouter.ai/api/v1', credential: handle } }
    },
    listModels: async (args) => {
      listed.push(args)
      return result ?? {
        ok: true,
        models: [{ id: 'openai/gpt-5.6-mini', contextLength: 400000 }, { id: 'z-ai/glm-5' }],
        fetchedAt: '2026-09-27T12:00:00.000Z',
        fromCache: false,
        dropped: 1,
      }
    },
    ...over,
  }
  return { deps, out, err, listed, resolved }
}

describe('agentop provider models', () => {
  test('lists ids one per line, the context length when stated, then a count line', async () => {
    const h = harness()
    expect(await runProviderModels(['openrouter'], h.deps)).toBe(0)
    expect(h.out).toEqual([
      'openai/gpt-5.6-mini  (context 400000)',
      'z-ai/glm-5',
      '2 models, 1 dropped.',
    ])
    expect(h.err).toEqual([])
  })

  test('the stored handle is passed on UNREVEALED — this module never reads the key', async () => {
    const { handle, reveals } = sentinelHandle()
    const h = harness({
      resolveEndpoint: async () => ({ ok: true, endpoint: { baseUrl: 'https://openrouter.ai/api/v1', credential: handle } }),
    })
    await runProviderModels(['openrouter'], h.deps)
    expect(h.listed[0]!.credential).toBe(handle)
    expect(reveals()).toBe(0)
  })

  test('--json prints the whole result and no key', async () => {
    const h = harness()
    expect(await runProviderModels(['openrouter', '--json'], h.deps)).toBe(0)
    const parsed = JSON.parse(h.out.join('\n'))
    expect(parsed.models).toHaveLength(2)
    expect(parsed.dropped).toBe(1)
    expect(h.out.join('\n')).not.toContain(KEY_SENTINEL)
  })

  test('an unknown endpoint is refused BEFORE resolving, and the argument is never echoed', async () => {
    const h = harness()
    // exactly the position a mistyped key lands in
    expect(await runProviderModels([KEY_SENTINEL], h.deps)).toBe(2)
    expect(h.resolved).toEqual([])
    expect(h.listed).toEqual([])
    const all = [...h.out, ...h.err].join('\n')
    expect(all).not.toContain(KEY_SENTINEL)
    expect(all).toContain('supported: openai, openrouter')
  })

  test('an unknown flag is refused without echoing it', async () => {
    const h = harness()
    expect(await runProviderModels(['openrouter', `--key=${KEY_SENTINEL}`], h.deps)).toBe(2)
    expect([...h.out, ...h.err].join('\n')).not.toContain(KEY_SENTINEL)
    expect(h.listed).toEqual([])
  })

  test('the flag off and a central refuse before any read or request', async () => {
    const off = harness({ flagOn: () => false })
    expect(await runProviderModels(['openrouter'], off.deps)).toBe(1)
    expect(off.err.join('\n')).toContain('AGENTISTICS_PROVIDER')
    expect(off.resolved).toEqual([])

    const central = harness({ isCentral: async () => true })
    expect(await runProviderModels(['openrouter'], central.deps)).toBe(1)
    expect(central.err.join('\n')).toContain('central')
    expect(central.resolved).toEqual([])
    expect(central.listed).toEqual([])
  })

  test('a known endpoint with nothing stored says how to store it, and sends nothing', async () => {
    const h = harness({ resolveEndpoint: async () => ({ ok: false, reason: 'not-stored' }) })
    expect(await runProviderModels(['openrouter'], h.deps)).toBe(1)
    expect(h.err.join('\n')).toContain('agentop provider key set openrouter')
    expect(h.listed).toEqual([])
  })

  test('each failure is a sentence with the reason and the status, never the body', async () => {
    const cases: Array<[ProviderModelsListResult, string]> = [
      [{ ok: false, reason: 'unauthorized', status: 401 }, 'rejected (HTTP 401)'],
      [{ ok: false, reason: 'http-error', status: 502 }, 'error (HTTP 502)'],
      [{ ok: false, reason: 'network' }, 'could not reach'],
      [{ ok: false, reason: 'not-json' }, 'not JSON'],
      [{ ok: false, reason: 'bad-shape' }, 'did not carry a models list'],
    ]
    for (const [result, expected] of cases) {
      const h = harness({}, result)
      expect(await runProviderModels(['openrouter'], h.deps)).toBe(1)
      expect(h.err.join('\n')).toContain(expected)
      expect(h.out).toEqual([])
    }
  })

  test('no usage line leaks the key in any path', async () => {
    const h = harness()
    await runProviderModels([], h.deps)
    await runProviderModels(['--help'], h.deps)
    expect([...h.out, ...h.err].join('\n')).not.toContain(KEY_SENTINEL)
  })
})
