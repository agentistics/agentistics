import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerKeyFile } from './config.ts'
import { keyShapeSentence, refusalSentence, validateKeyShape } from './provider/credential-plan.ts'
import { runProvider, type ProviderCliDeps } from './cli-provider.ts'

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
    const code = await runProvider(['key', 'status', 'openai'], h.deps)
    expect(code).toBe(2)
    expect(h.all()).toContain('anthropic')
    expect(h.all()).not.toContain('openai')
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
