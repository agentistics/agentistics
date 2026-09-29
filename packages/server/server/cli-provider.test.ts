import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerKeyFile } from './config.ts'
import { keyShapeSentence, refusalSentence, validateKeyShape } from './provider/credential-plan.ts'
import { rateLimitSentence, runProvider, type ProviderCliDeps } from './cli-provider.ts'

// A fake key built at runtime, never a literal in source — same convention the spec asks for so a
// source grep for a real-looking key can never mistake this file's own fixture for a leak.
const FAKE_KEY = 'sk-ant-' + 'test' + 'y'.repeat(40)
const FAKE_KEY_2 = 'sk-ant-' + 'test' + 'z'.repeat(40)

expect(validateKeyShape(FAKE_KEY).ok).toBe(true)
expect(validateKeyShape(FAKE_KEY_2).ok).toBe(true)

interface Harness {
  deps: ProviderCliDeps
  out: string[]
  err: string[]
  all: () => string
  dir: string
}

async function makeHarness(overrides: Partial<ProviderCliDeps> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-provider-cli-'))
  const out: string[] = []
  const err: string[] = []
  const deps: ProviderCliDeps = {
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    stdinIsTTY: true,
    readStdinLine: async () => {
      throw new Error('readStdinLine should not be called on this path')
    },
    maskedInput: async () => {
      throw new Error('maskedInput should not be called on this path')
    },
    confirm: async () => {
      throw new Error('confirm should not be called on this path')
    },
    isCentral: async () => false,
    flagOn: () => true,
    dir,
    ...overrides,
  }
  return { deps, out, err, all: () => [...out, ...err].join('\n'), dir }
}

async function cleanup(h: Harness): Promise<void> {
  await rm(h.dir, { recursive: true, force: true })
}

describe('runProvider — set (tty)', () => {
  test('first set stores the key and prints only a fingerprint', async () => {
    const h = await makeHarness({ maskedInput: async () => FAKE_KEY })
    const code = await runProvider(['key', 'set', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).not.toContain(FAKE_KEY)
    expect(h.all()).toMatch(/sha256:[0-9a-f]{8}/)
    await cleanup(h)
  })

  test('rotation asks to confirm, shows old -> new fingerprint, never the keys', async () => {
    const h = await makeHarness({ maskedInput: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'anthropic'], h.deps)).toBe(0)

    let asked = false
    h.deps.maskedInput = async () => FAKE_KEY_2
    h.deps.confirm = async (message) => { asked = true; return true }
    const code = await runProvider(['key', 'set', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(asked).toBe(true)
    expect(h.all()).toMatch(/sha256:[0-9a-f]{8}\s*→\s*sha256:[0-9a-f]{8}/)
    expect(h.all()).not.toContain(FAKE_KEY)
    expect(h.all()).not.toContain(FAKE_KEY_2)
    await cleanup(h)
  })

  test('declining the rotation confirm leaves the old key in place', async () => {
    const h = await makeHarness({ maskedInput: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'anthropic'], h.deps)).toBe(0)
    const originalFingerprint = h.all().match(/sha256:[0-9a-f]{8}/)?.[0]
    expect(originalFingerprint).toBeTruthy()

    h.out.length = 0
    h.err.length = 0
    h.deps.maskedInput = async () => FAKE_KEY_2
    h.deps.confirm = async () => false
    const code = await runProvider(['key', 'set', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(h.all().toLowerCase()).toContain('left unchanged')

    h.out.length = 0
    h.err.length = 0
    await runProvider(['key', 'status', 'anthropic'], h.deps)
    expect(h.all()).toContain(originalFingerprint!)
    await cleanup(h)
  })
})

describe('runProvider — set (--stdin)', () => {
  test('reads exactly one line and stores it', async () => {
    const h = await makeHarness({ readStdinLine: async () => FAKE_KEY })
    const code = await runProvider(['key', 'set', 'anthropic', '--stdin'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).not.toContain(FAKE_KEY)
    await cleanup(h)
  })

  test('rotation without --replace is refused, with it succeeds', async () => {
    const h = await makeHarness({ readStdinLine: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'anthropic', '--stdin'], h.deps)).toBe(0)

    h.deps.readStdinLine = async () => FAKE_KEY_2
    const refused = await runProvider(['key', 'set', 'anthropic', '--stdin'], h.deps)
    expect(refused).toBe(1)
    expect(h.all().toLowerCase()).toContain('--replace')
    expect(h.all()).not.toContain(FAKE_KEY)
    expect(h.all()).not.toContain(FAKE_KEY_2)

    const code = await runProvider(['key', 'set', 'anthropic', '--stdin', '--replace'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).not.toContain(FAKE_KEY)
    expect(h.all()).not.toContain(FAKE_KEY_2)
    await cleanup(h)
  })
})

describe('runProvider — refusals that must never echo the argument', () => {
  test('a key typed on argv is refused and never echoed', async () => {
    const h = await makeHarness()
    const code = await runProvider(['key', 'set', 'anthropic', FAKE_KEY], h.deps)
    expect(code).toBe(2)
    expect(h.all()).not.toContain(FAKE_KEY)
    expect(h.all().toLowerCase()).toContain('never accepted on the command line')
    await cleanup(h)
  })

  test('a key typed in place of the provider id is refused and never echoed', async () => {
    const h = await makeHarness()
    const code = await runProvider(['key', 'set', FAKE_KEY], h.deps)
    expect(code).toBe(2)
    expect(h.all()).not.toContain(FAKE_KEY)
    await cleanup(h)
  })

  test('an unknown flag is refused without being echoed', async () => {
    const h = await makeHarness()
    const code = await runProvider(['key', 'set', 'anthropic', '--this-flag-does-not-exist'], h.deps)
    expect(code).toBe(2)
    expect(h.all()).not.toContain('--this-flag-does-not-exist')
    await cleanup(h)
  })

  test('an unknown provider is refused, naming the supported ones', async () => {
    const h = await makeHarness()
    // (`openai` became a keyed ENDPOINT in B5a, so the unknown id here is one no table holds.)
    const code = await runProvider(['key', 'status', 'mistralx'], h.deps)
    expect(code).toBe(2)
    expect(h.all()).toContain('anthropic')
    expect(h.all()).toContain('openrouter')
    expect(h.all()).not.toContain('mistralx')
    await cleanup(h)
  })
})

describe('runProvider — no terminal, no --stdin', () => {
  test('refuses rather than falling through to an echoing prompt', async () => {
    const h = await makeHarness({ stdinIsTTY: false })
    const code = await runProvider(['key', 'set', 'anthropic'], h.deps)
    expect(code).toBe(2)
    expect(h.all().toLowerCase()).toContain('--stdin')
    await cleanup(h)
  })
})

describe('runProvider — bracketed-paste residue', () => {
  test('is refused by the shape validator and never printed', async () => {
    const residue = 'sk-ant-' + 'x'.repeat(30) + '[200~'
    const h = await makeHarness({ maskedInput: async () => residue })
    const code = await runProvider(['key', 'set', 'anthropic'], h.deps)
    expect(code).toBe(1)
    expect(h.all()).not.toContain(residue)
    expect(h.all()).toBe(keyShapeSentence('bracketed-paste'))
    await cleanup(h)
  })
})

describe('runProvider — the AGENTISTICS_PROVIDER flag', () => {
  test('off: set and remove refuse; status still exits 0 and never shows a fingerprint', async () => {
    // Store a key while the flag is (implicitly) on, then flip it off for the read.
    const seed = await makeHarness({ maskedInput: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'anthropic'], seed.deps)).toBe(0)

    const h = await makeHarness({ dir: seed.dir, flagOn: () => false })
    const setCode = await runProvider(['key', 'set', 'anthropic'], h.deps)
    expect(setCode).toBe(1)
    expect(h.all()).toContain(refusalSentence('flag-off'))

    const removeCode = await runProvider(['key', 'remove', 'anthropic'], h.deps)
    expect(removeCode).toBe(1)

    const statusOut: string[] = []
    const statusDeps: ProviderCliDeps = { ...h.deps, stdout: (l) => statusOut.push(l) }
    const statusCode = await runProvider(['key', 'status', 'anthropic'], statusDeps)
    expect(statusCode).toBe(0)
    expect(statusOut.join('\n')).toContain(refusalSentence('flag-off'))
    expect(statusOut.join('\n')).not.toContain('fingerprint:')
    expect(statusOut.join('\n')).not.toContain(FAKE_KEY)
    await cleanup(seed)
  })
})

describe('runProvider — central', () => {
  test('refuses set and remove; status still exits 0 and says so', async () => {
    const h = await makeHarness({ isCentral: async () => true })
    const setCode = await runProvider(['key', 'set', 'anthropic'], h.deps)
    expect(setCode).toBe(1)
    expect(h.all()).toContain(refusalSentence('central'))

    const removeCode = await runProvider(['key', 'remove', 'anthropic'], h.deps)
    expect(removeCode).toBe(1)

    const statusOut: string[] = []
    const statusDeps: ProviderCliDeps = { ...h.deps, stdout: (l) => statusOut.push(l) }
    const statusCode = await runProvider(['key', 'status', 'anthropic'], statusDeps)
    expect(statusCode).toBe(0)
    expect(statusOut.join('\n')).toContain(refusalSentence('central'))
    await cleanup(h)
  })
})

describe('runProvider — status', () => {
  test('absent key reports state absent, no fingerprint', async () => {
    const h = await makeHarness()
    const code = await runProvider(['key', 'status', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).toContain('absent')
    expect(h.all()).not.toContain('fingerprint:')
    await cleanup(h)
  })

  test('present key reports state present with path, mode and fingerprint', async () => {
    const h = await makeHarness({ maskedInput: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'anthropic'], h.deps)).toBe(0)
    h.out.length = 0
    h.err.length = 0
    const code = await runProvider(['key', 'status', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).toContain('present')
    expect(h.all()).toContain(providerKeyFile('anthropic', h.dir))
    expect(h.all()).toMatch(/sha256:[0-9a-f]{8}/)
    expect(h.all()).not.toContain(FAKE_KEY)
    // C-3: the last 4 characters are shown — and nothing longer than that tail is.
    expect(h.all()).toContain(`ends with: …${FAKE_KEY.slice(-4)}`)
    expect(h.all()).not.toContain(FAKE_KEY.slice(-5))
    await cleanup(h)
  })

  test('a too-open file mode is reported, with the chmod fix, and no fingerprint', async () => {
    const h = await makeHarness({ maskedInput: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'anthropic'], h.deps)).toBe(0)
    await chmod(providerKeyFile('anthropic', h.dir), 0o644)

    h.out.length = 0
    h.err.length = 0
    const code = await runProvider(['key', 'status', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).toContain('permissions-too-open')
    expect(h.all().toLowerCase()).toContain('chmod 600')
    expect(h.all()).not.toContain(FAKE_KEY)
    await cleanup(h)
  })

  test('with no provider given, reports every keyed provider', async () => {
    const h = await makeHarness()
    const code = await runProvider(['key', 'status'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).toContain('anthropic:')
    await cleanup(h)
  })
})

describe('runProvider — remove', () => {
  test('removing an absent key says so and exits 0', async () => {
    const h = await makeHarness()
    const code = await runProvider(['key', 'remove', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(h.all().toLowerCase()).toContain('no key stored')
    await cleanup(h)
  })

  test('removing a present key prints its fingerprint and the revocation caveat, never the key', async () => {
    const h = await makeHarness({ maskedInput: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'anthropic'], h.deps)).toBe(0)
    h.out.length = 0
    h.err.length = 0
    const code = await runProvider(['key', 'remove', 'anthropic'], h.deps)
    expect(code).toBe(0)
    expect(h.all()).toMatch(/sha256:[0-9a-f]{8}/)
    expect(h.all().toLowerCase()).toContain('revoke')
    expect(h.all()).not.toContain(FAKE_KEY)

    h.out.length = 0
    h.err.length = 0
    const statusCode = await runProvider(['key', 'status', 'anthropic'], h.deps)
    expect(statusCode).toBe(0)
    expect(h.all()).toContain('absent')
    await cleanup(h)
  })
})

describe('runProvider — help', () => {
  test('no args and --help print usage and never mention a real-looking key value', async () => {
    const h = await makeHarness()
    expect(await runProvider([], h.deps)).toBe(0)
    expect(await runProvider(['--help'], h.deps)).toBe(0)
    expect(h.all().toLowerCase()).toContain('never accepted on the command line')
    expect(h.all().toLowerCase()).toContain('subscription')
    expect(h.all()).not.toContain(FAKE_KEY)
    await cleanup(h)
  })

  test('unknown top-level and key subcommands are refused, not silently ignored', async () => {
    const h = await makeHarness()
    expect(await runProvider(['nonsense'], h.deps)).toBe(2)
    expect(await runProvider(['key', 'nonsense'], h.deps)).toBe(2)
    await cleanup(h)
  })
})

describe('runProvider — try --stream (fake client, no network)', () => {
  // Imported lazily so the rest of this file never opens a journal.
  async function setup(client: import('@agentistics/runtime').ProviderClient) {
    const { openJournal } = await import('./journal/journal')
    const { storeCredential } = await import('./provider/credentials.ts')
    const h = await makeHarness()
    expect((await storeCredential('anthropic', FAKE_KEY, { dir: h.dir })).ok).toBe(true)
    const journal = await openJournal({ path: join(h.dir, 'journal.db') })
    const written: string[] = []
    h.deps.client = client
    h.deps.openJournal = async () => journal
    h.deps.write = (c) => written.push(c)
    return { h, journal, written }
  }

  function completedResult(req: import('@agentistics/runtime').ProviderRequest, attempt: number): import('@agentistics/runtime').InvocationResult {
    return {
      invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
      startedAt: new Date().toISOString(), latencyMs: 7, requestId: 'req_stream', status: 'completed',
      messageId: 'msg_stream', servedModel: req.model, usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
      usageAnomalies: [], stopReason: { kind: 'end-turn' }, content: [{ type: 'text', text: 'ok!' }],
    }
  }

  test('prints the deltas in order as they arrive, then the same summary', async () => {
    let invokeOnceCalled = false
    const { h, journal, written } = await setup({
      provider: 'anthropic', adapterVersion: 'fake-1', capabilities: { streaming: true, editPolicy: 'none' as never },
      async invokeOnce(req, a) { invokeOnceCalled = true; return completedResult(req, a) },
      async *stream(req, a) {
        yield { type: 'started', requestId: 'req_stream', messageId: 'msg_stream' }
        yield { type: 'text-delta', index: 0, text: 'o' }
        yield { type: 'text-delta', index: 0, text: 'k' }
        yield { type: 'usage', outputTokensSoFar: 1 }
        yield { type: 'text-delta', index: 0, text: '!' }
        yield { type: 'end', result: completedResult(req, a) }
      },
    })
    const code = await runProvider(['try', 'anthropic', '--stream'], h.deps)
    expect(code).toBe(0)
    expect(invokeOnceCalled).toBe(false)
    expect(written).toEqual(['o', 'k', '!', '\n'])
    const out = h.out.join('\n')
    expect(out).toContain('message id: msg_stream')
    expect(out).toContain('request-id: req_stream')
    expect(out).toContain('input: 9')
    expect(out).toContain('journaled: yes')
    expect(h.err).toEqual([])
    const types = (await journal.readFrom(0, 100)).events.map(e => e.type)
    // model.started is journaled from the provider's `started` event; the deltas never are.
    expect(types).toEqual(['model.invoked', 'model.started', 'model.completed'])
    journal.close()
    await cleanup(h)
  })

  test('tool calls are one compact line each; a failed one goes to stderr', async () => {
    const { h, journal, written } = await setup({
      provider: 'anthropic', adapterVersion: 'fake-1', capabilities: { streaming: true, editPolicy: 'none' as never },
      async invokeOnce(req, a) { return completedResult(req, a) },
      async *stream(req, a) {
        yield { type: 'text-delta', index: 0, text: 'hi' }
        yield { type: 'tool-call-delta', index: 1, id: 'tu_1', name: 'lookup', partialJson: '{"q":' }
        yield { type: 'tool-call-delta', index: 1, id: 'tu_1', name: 'lookup', partialJson: '1}' }
        yield { type: 'tool-call', index: 1, id: 'tu_1', name: 'lookup', input: { q: 1 } }
        yield { type: 'tool-call-failed', failure: { index: 2, id: 'tu_2', name: 'bad', reason: 'malformed', userCode: 'provider.tool_call_malformed' } }
        yield { type: 'end', result: completedResult(req, a) }
      },
    })
    expect(await runProvider(['try', 'anthropic', '--stream'], h.deps)).toBe(0)
    expect(written).toEqual(['hi', '\n'])
    expect(h.out.filter(l => l.includes('tool call lookup'))).toEqual([
      '  → tool call lookup (arguments streaming…)',
      '  → tool call lookup ready (tu_1) — not executed',
    ])
    expect(h.err.join('\n')).toContain('tool call bad could not be assembled: malformed')
    journal.close()
    await cleanup(h)
  })

  test('a non-streaming client is refused in words, exits non-zero, and journals nothing', async () => {
    let called = false
    const { h, journal } = await setup({
      provider: 'anthropic', adapterVersion: 'fake-1', capabilities: { streaming: false, editPolicy: 'none' as never },
      async invokeOnce(req, a) { called = true; return completedResult(req, a) },
    })
    const code = await runProvider(['try', 'anthropic', '--stream'], h.deps)
    expect(code).toBe(1)
    expect(called).toBe(false)
    expect(h.err.join('\n')).toContain('cannot stream (provider.streaming_unsupported)')
    expect((await journal.readFrom(0, 100)).events).toEqual([])
    journal.close()
    await cleanup(h)
  })

  test('a stream that ends without `end` says the outcome is unknown and exits non-zero', async () => {
    const { h, journal } = await setup({
      provider: 'anthropic', adapterVersion: 'fake-1', capabilities: { streaming: true, editPolicy: 'none' as never },
      async invokeOnce(req, a) { return completedResult(req, a) },
      async *stream() { yield { type: 'text-delta', index: 0, text: 'o' } },
    })
    expect(await runProvider(['try', 'anthropic', '--stream'], h.deps)).toBe(1)
    expect(h.err.join('\n')).toContain('ended without a result')
    journal.close()
    await cleanup(h)
  })

  test('the usage string names --stream', async () => {
    const h = await makeHarness()
    expect(await runProvider(['try', '--help'], h.deps)).toBe(0)
    expect(h.out.join('\n')).toContain('[--stream]')
    await cleanup(h)
  })
})

// ── B5a — OpenAI-compatible endpoints ───────────────────────────────────────────────────────────

// Fakes built at runtime, never a literal key in source.
const FAKE_OR_KEY = 'sk-or-' + 'test' + 'w'.repeat(40)
const FAKE_OAI_KEY = 'sk-' + 'test' + 'v'.repeat(40)

describe('runProvider — endpoint key set/status/remove', () => {
  test('set openrouter via --stdin stores the preset base URL and prints only a fingerprint', async () => {
    const h = await makeHarness({ readStdinLine: async () => FAKE_OR_KEY })
    expect(await runProvider(['key', 'set', 'openrouter', '--stdin'], h.deps)).toBe(0)
    expect(h.all()).toContain('https://openrouter.ai/api/v1')
    expect(h.all()).toMatch(/sha256:[0-9a-f]{8}/)
    expect(h.all()).not.toContain(FAKE_OR_KEY)

    h.out.length = 0; h.err.length = 0
    expect(await runProvider(['key', 'status', 'openrouter'], h.deps)).toBe(0)
    expect(h.all()).toContain('base url: https://openrouter.ai/api/v1')
    expect(h.all()).toContain(`ends with: …${FAKE_OR_KEY.slice(-4)}`)
    expect(h.all()).not.toContain(FAKE_OR_KEY.slice(-5))
    expect(h.all()).not.toContain(FAKE_OR_KEY)
    await cleanup(h)
  })

  test('--base-url overrides the preset and is normalised; litellm without one is refused', async () => {
    const h = await makeHarness({ readStdinLine: async () => 'sk-1234' })
    expect(await runProvider(['key', 'set', 'litellm', '--stdin'], h.deps)).toBe(2)
    expect(h.all()).toContain('--base-url')
    h.out.length = 0; h.err.length = 0
    expect(await runProvider(['key', 'set', 'litellm', '--stdin', '--base-url', 'https://proxy.example.com/v1/'], h.deps)).toBe(0)
    expect(h.all()).toContain('https://proxy.example.com/v1 ')
    expect(h.all()).not.toContain('sk-1234')
    await cleanup(h)
  })

  test('a plain-http remote or a userinfo base URL is refused BEFORE the key is asked, and never echoed', async () => {
    let asked = false
    const h = await makeHarness({ readStdinLine: async () => { asked = true; return FAKE_OAI_KEY } })
    for (const url of ['http://evil.example/v1', 'https://user:hunter2secret@api.example.com/v1', 'https://x.example/v1?k=v', 'ftp://x/v1']) {
      h.out.length = 0; h.err.length = 0
      expect(await runProvider(['key', 'set', 'openai', '--stdin', '--base-url', url], h.deps)).toBe(1)
      expect(h.all()).not.toContain(url)
      expect(h.all()).not.toContain('hunter2secret')
    }
    expect(asked).toBe(false)
    await cleanup(h)
  })

  test('http to loopback is accepted (9router preset)', async () => {
    const h = await makeHarness({ readStdinLine: async () => 'router-key-1' })
    expect(await runProvider(['key', 'set', '9router', '--stdin'], h.deps)).toBe(0)
    expect(h.all()).toContain('http://localhost:20128/v1')
    await cleanup(h)
  })

  test('ollama may be stored keyless; --no-key is refused where a key is required', async () => {
    const h = await makeHarness()
    expect(await runProvider(['key', 'set', 'ollama', '--no-key'], h.deps)).toBe(0)
    expect(h.all()).toContain('no key at http://localhost:11434/v1')
    h.out.length = 0; h.err.length = 0
    expect(await runProvider(['key', 'status', 'ollama'], h.deps)).toBe(0)
    expect(h.all()).toContain('key: none (keyless)')
    h.out.length = 0; h.err.length = 0
    expect(await runProvider(['key', 'set', 'openai', '--no-key'], h.deps)).toBe(2)
    await cleanup(h)
  })

  test('an Anthropic key is refused for an endpoint (it would be sent to another host), and never echoed', async () => {
    const h = await makeHarness({ readStdinLine: async () => FAKE_KEY })
    expect(await runProvider(['key', 'set', 'openai', '--stdin'], h.deps)).toBe(1)
    expect(h.all()).toBe(keyShapeSentence('foreign-prefix', 'openai'))
    expect(h.all()).not.toContain(FAKE_KEY)
    await cleanup(h)
  })

  test('a key on argv is refused for an endpoint too', async () => {
    const h = await makeHarness()
    expect(await runProvider(['key', 'set', 'openai', FAKE_OAI_KEY], h.deps)).toBe(2)
    expect(h.all()).not.toContain(FAKE_OAI_KEY)
    await cleanup(h)
  })

  test('a replace via --stdin needs --replace, and shows old → new with the base URLs', async () => {
    const h = await makeHarness({ readStdinLine: async () => FAKE_OAI_KEY })
    expect(await runProvider(['key', 'set', 'openai', '--stdin'], h.deps)).toBe(0)
    h.deps.readStdinLine = async () => FAKE_OAI_KEY + 'x'
    expect(await runProvider(['key', 'set', 'openai', '--stdin'], h.deps)).toBe(1)
    h.out.length = 0; h.err.length = 0
    expect(await runProvider(['key', 'set', 'openai', '--stdin', '--replace'], h.deps)).toBe(0)
    expect(h.all()).toMatch(/sha256:[0-9a-f]{8} at https:\/\/api\.openai\.com\/v1 → sha256:[0-9a-f]{8} at https:\/\/api\.openai\.com\/v1/)
    expect(h.all()).not.toContain(FAKE_OAI_KEY)
    await cleanup(h)
  })

  test('remove says where the key is still valid, never the key', async () => {
    const h = await makeHarness({ readStdinLine: async () => FAKE_OR_KEY })
    expect(await runProvider(['key', 'set', 'openrouter', '--stdin'], h.deps)).toBe(0)
    h.out.length = 0; h.err.length = 0
    expect(await runProvider(['key', 'remove', 'openrouter'], h.deps)).toBe(0)
    expect(h.all()).toContain('still valid at OpenRouter')
    expect(h.all()).not.toContain(FAKE_OR_KEY)
    await cleanup(h)
  })

  test('a central refuses set, remove and try for an endpoint exactly like Anthropic', async () => {
    const h = await makeHarness({ isCentral: async () => true, readStdinLine: async () => FAKE_OR_KEY })
    expect(await runProvider(['key', 'set', 'openrouter', '--stdin'], h.deps)).toBe(1)
    expect(await runProvider(['key', 'remove', 'openrouter'], h.deps)).toBe(1)
    expect(await runProvider(['try', 'openrouter', '--model', 'x/y'], h.deps)).toBe(1)
    expect(h.err.filter(l => l === refusalSentence('central'))).toHaveLength(3)
    await cleanup(h)
  })

  test('`models` runs over THIS call\'s deps by default (no network: nothing stored), and a hook overrides it', async () => {
    const h = await makeHarness()
    // default wiring: the harness's own dir holds no openrouter record → refused before any request
    expect(await runProvider(['models', 'openrouter'], h.deps)).toBe(1)
    expect(h.all()).toContain('agentop provider key set openrouter')
    // an argument outside the closed set is refused without being repeated back
    expect(await runProvider(['models', 'sk-or-v1-' + 'x'.repeat(40)], h.deps)).toBe(2)
    expect(h.all()).not.toContain('sk-or-v1-')
    let got: string[] = []
    h.deps.runModels = async (a) => { got = a; return 0 }
    expect(await runProvider(['models', 'openrouter', '--json'], h.deps)).toBe(0)
    expect(got).toEqual(['openrouter', '--json'])
    await cleanup(h)
  })
})

describe('runProvider — try <endpoint> --stream (B2 × B5a)', () => {
  // The openai-compatible client has no stream yet: `--stream` against an endpoint must be refused in
  // words — never a hang, never quietly answered by the non-streamed call — and journal nothing.
  async function setup(streaming: boolean) {
    const { openJournal } = await import('./journal/journal')
    const h = await makeHarness({ readStdinLine: async () => FAKE_OR_KEY })
    expect(await runProvider(['key', 'set', 'openrouter', '--stdin'], h.deps)).toBe(0)
    h.out.length = 0; h.err.length = 0
    const journal = await openJournal({ path: join(h.dir, 'journal.db') })
    const calls = { invokeOnce: 0, stream: 0 }
    const client: import('@agentistics/runtime').ProviderClient = {
      provider: 'openai-compatible', adapterVersion: 'fake-1', capabilities: { streaming, editPolicy: 'none' as never },
      async invokeOnce() { calls.invokeOnce++; throw new Error('invokeOnce must not be called') },
      ...(streaming ? { async *stream() { calls.stream++; yield { type: 'text-delta' as const, index: 0, text: 'x' } } } : {}),
    }
    h.deps.client = client
    h.deps.openJournal = async () => journal
    return { h, journal, calls }
  }

  test('is refused with the runtime\'s streaming_unsupported code, exits non-zero, calls nothing, journals nothing', async () => {
    const { h, journal, calls } = await setup(false)
    expect(await runProvider(['try', 'openrouter', '--model', 'x/y', '--stream'], h.deps)).toBe(1)
    expect(h.err.join('\n')).toContain('openrouter: this client cannot stream (provider.streaming_unsupported) — run without --stream.')
    expect(calls).toEqual({ invokeOnce: 0, stream: 0 })
    expect(h.out).toEqual([])
    expect((await journal.readFrom(0, 100)).events).toEqual([])
    journal.close()
    await cleanup(h)
  })

  test('is refused even if the client someday declares a stream — this verb has no streamed endpoint path', async () => {
    const { h, journal, calls } = await setup(true)
    expect(await runProvider(['try', 'openrouter', '--model', 'x/y', '--stream'], h.deps)).toBe(1)
    expect(h.err.join('\n')).toContain('(provider.streaming_unsupported)')
    expect(calls).toEqual({ invokeOnce: 0, stream: 0 })
    expect((await journal.readFrom(0, 100)).events).toEqual([])
    journal.close()
    await cleanup(h)
  })

  test('without --model the missing-model sentence still comes first', async () => {
    const h = await makeHarness()
    expect(await runProvider(['try', 'openrouter', '--stream'], h.deps)).toBe(2)
    expect(h.err.join('\n')).toContain('has no default model')
    await cleanup(h)
  })
})

// ── B9.3 — the rate-limit line ──────────────────────────────────────────────────────────────────

describe('rateLimitSentence — one line, in the machine\'s local time', () => {
  const NOW = new Date('2026-09-28T14:00:00.000Z')
  const reading = {
    source: 'headers' as const,
    resources: [
      { kind: 'requests' as const, limit: 50, remaining: 49, resetsAt: '2026-09-28T14:32:00.000Z' },
      { kind: 'tokens' as const, limit: 40000, remaining: 39000, resetsAt: '2026-09-28T14:32:40.000Z' },
    ],
    dropped: 0,
  }

  test('EN, UTC', () => {
    expect(rateLimitSentence(reading, 'en', { now: NOW, timeZone: 'UTC' }))
      .toBe('rate limit: requests 49/50 left until 14:32 · tokens 39,000/40,000 left until 14:32')
  })

  test('PT, São Paulo — the zone is the injected one, not the host\'s', () => {
    expect(rateLimitSentence(reading, 'pt', { now: NOW, timeZone: 'America/Sao_Paulo' }))
      .toBe('limite de taxa: requisições 49/50 restantes até 11:32 · tokens 39.000/40.000 restantes até 11:32')
  })

  test('a reset on another local day carries its date', () => {
    const r = { ...reading, resources: [{ kind: 'requests' as const, remaining: 3, resetsAt: '2026-09-29T02:10:00.000Z' }] }
    expect(rateLimitSentence(r, 'en', { now: NOW, timeZone: 'UTC' })).toBe('rate limit: requests 3 left until 2026-09-29 02:10')
  })

  test('an absent remaining is said, never printed as 0', () => {
    const r = { ...reading, resources: [{ kind: 'output-tokens' as const, limit: 8000 }] }
    const line = rateLimitSentence(r, 'en', { now: NOW, timeZone: 'UTC' })
    expect(line).toBe('rate limit: output tokens limit 8,000 (remaining not stated)')
    expect(line).not.toContain(' 0')
  })

  test('retry-after and dropped headers are named', () => {
    const r = { source: 'headers' as const, resources: [], retryAfterMs: 56_000, dropped: 2 }
    expect(rateLimitSentence(r, 'en', { now: NOW, timeZone: 'UTC' })).toBe('rate limit: retry after 56s · 2 headers unreadable')
    expect(rateLimitSentence(r, 'pt', { now: NOW, timeZone: 'UTC' })).toBe('limite de taxa: tentar de novo em 56s · 2 cabeçalhos ilegíveis')
  })

  test('absent readings are a reason in words', () => {
    expect(rateLimitSentence({ absent: 'not-documented', dropped: 0 }, 'en', { now: NOW, timeZone: 'UTC' }))
      .toBe('rate limit: not stated — this provider documents no rate-limit header')
    expect(rateLimitSentence({ absent: 'no-headers', dropped: 0 }, 'pt', { now: NOW, timeZone: 'UTC' }))
      .toBe('limite de taxa: não informado — a resposta não trouxe cabeçalho de limite de taxa')
    expect(rateLimitSentence({ absent: 'unparseable', dropped: 3 }, 'en', { now: NOW, timeZone: 'UTC' }))
      .toBe('rate limit: not read — 3 rate-limit headers were present and none could be parsed')
  })
})

describe('runProvider — try prints the rate-limit line (fake client, no network)', () => {
  test('after the summary, in the chosen language', async () => {
    const { openJournal } = await import('./journal/journal')
    const { storeCredential } = await import('./provider/credentials.ts')
    const h = await makeHarness({ lang: 'pt', timeZone: 'UTC' })
    expect((await storeCredential('anthropic', FAKE_KEY, { dir: h.dir })).ok).toBe(true)
    const journal = await openJournal({ path: join(h.dir, 'journal.db') })
    h.deps.openJournal = async () => journal
    h.deps.client = {
      provider: 'anthropic', adapterVersion: 'fake-1', capabilities: { streaming: false, editPolicy: 'none' as never },
      async invokeOnce(req, attempt) {
        return {
          invocationId: req.correlation.invocationId, attempt, provider: 'anthropic', requestedModel: req.model,
          startedAt: new Date().toISOString(), latencyMs: 7, status: 'completed',
          messageId: 'msg_rl', servedModel: req.model, usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
          usageAnomalies: [], stopReason: { kind: 'end-turn' }, content: [{ type: 'text', text: 'ok' }],
          rateLimit: { source: 'headers', resources: [{ kind: 'requests', limit: 50, remaining: 49, resetsAt: '2099-01-01T14:32:00.000Z' }], dropped: 0 },
        }
      },
    }
    expect(await runProvider(['try', 'anthropic'], h.deps)).toBe(0)
    expect(h.out).toContain('  limite de taxa: requisições 49/50 restantes até 2099-01-01 14:32')
    journal.close()
    await cleanup(h)
  })
})
