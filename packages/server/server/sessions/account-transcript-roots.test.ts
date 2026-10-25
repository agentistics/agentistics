import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setAccountRootsForTest, accountRootFrom, newestTranscript, accountRootOf, accountRootsFrom, accountStoreDirs, storeDirOf,
  type AccountRootsSource,
} from './account-transcript-roots'
import { encodeProjectDir, forgetChatTailPaths, resolveClaudeTranscriptAnyAccount } from './chat-tail'
import { transcriptReaderFor } from './harness-transcript'

const REGISTRY: AccountRootsSource = {
  accounts: [
    { id: 'acc_main', harness: 'claude', root: null },
    { id: 'acc_pro', harness: 'claude', root: '/data/accounts/claude/r_pro' },
    { id: 'acc_codex2', harness: 'codex', root: '/data/accounts/codex/r_two' },
  ],
  bindings: {
    'claude:': 'acc_main',
    'claude:/data/accounts/claude/r_pro': 'acc_pro',
    'claude:/data/accounts/claude/r_bound_only': 'acc_bound',
    'codex:/data/accounts/codex/r_two': 'acc_codex2',
  },
  aliases: { acc_old_pro: 'acc_pro' },
}

describe('storeDirOf (pure)', () => {
  it('names where each harness keeps its conversations inside a config root', () => {
    expect(storeDirOf('claude', '/r')).toBe('/r/projects')
    expect(storeDirOf('codex', '/r')).toBe('/r/sessions')
    expect(storeDirOf('copilot', '/r')).toBe('/r/session-state')
    expect(storeDirOf('kimi', '/r')).toBe('/r/sessions')
    // GEMINI_CLI_HOME is a HOME: the CLI creates `.gemini` inside it.
    expect(storeDirOf('gemini', '/r')).toBe('/r/.gemini/tmp')
    expect(storeDirOf('antigravity', '/r')).toBeNull()
    expect(storeDirOf('opencode', '/r')).toBeNull()
  })
})

describe('accountRootsFrom / accountRootFrom (pure)', () => {
  it('lists every non-default root of one harness, from accounts and bindings, once each', () => {
    expect(accountRootsFrom(REGISTRY, 'claude'))
      .toEqual(['/data/accounts/claude/r_pro', '/data/accounts/claude/r_bound_only'])
    expect(accountRootsFrom(REGISTRY, 'codex')).toEqual(['/data/accounts/codex/r_two'])
    expect(accountRootsFrom(REGISTRY, 'gemini')).toEqual([])
  })
  it('gives an account its root; the default login and an unknown id have none', () => {
    expect(accountRootFrom(REGISTRY, 'acc_pro')).toBe('/data/accounts/claude/r_pro')
    expect(accountRootFrom(REGISTRY, 'acc_old_pro')).toBe('/data/accounts/claude/r_pro')
    expect(accountRootFrom(REGISTRY, 'acc_bound')).toBe('/data/accounts/claude/r_bound_only')
    expect(accountRootFrom(REGISTRY, 'acc_main')).toBeNull()
    expect(accountRootFrom(REGISTRY, 'acc_nobody')).toBeNull()
  })
})

describe('a second account\'s conversation is found in its own root', () => {
  // Measured 2026-10-23: a Claude Pro session's transcript sat under its root's `projects/`, and the
  // chat (and, once it ended, the "transcript removed" diagnosis) looked in `~/.claude` only.
  const CONV = '7d3f0a52-6b1e-4c8a-9f21-0a5b3c4d5e6f'
  const CWD = '/home/someone/soar'
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'acct-root-'))
    const dir = join(root, 'projects', encodeProjectDir(CWD))
    await mkdir(dir, { recursive: true })
    const line = { type: 'user', uuid: 'u1', timestamp: '2026-10-23T10:00:00Z', message: { role: 'user', content: 'hello from the pro account' } }
    await writeFile(join(dir, `${CONV}.jsonl`), JSON.stringify(line) + '\n')
    await mkdir(join(root, 'session-state', CONV), { recursive: true })
    await writeFile(join(root, 'session-state', CONV, 'events.jsonl'), '')
  })
  afterEach(() => { __setAccountRootsForTest(null); forgetChatTailPaths() })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  const registryWith = (harness: 'claude' | 'copilot'): AccountRootsSource => ({
    accounts: [{ id: 'acc_second', harness, root }], bindings: { [`${harness}:${root}`]: 'acc_second' },
  })

  it('the Claude reader falls back from the default store to the account root', async () => {
    __setAccountRootsForTest(registryWith('claude'))
    const path = await transcriptReaderFor('claude')!.resolve({ conversationId: CONV, cwd: CWD })
    expect(path).toBe(join(root, 'projects', encodeProjectDir(CWD), `${CONV}.jsonl`))
    const read = await transcriptReaderFor('claude')!.read(path!, 50)
    expect(read.turns.map(t => t.text)).toContain('hello from the pro account')
  })

  it('callers holding only cwd + id find it too', async () => {
    __setAccountRootsForTest(registryWith('claude'))
    expect(await resolveClaudeTranscriptAnyAccount(CWD, CONV))
      .toBe(join(root, 'projects', encodeProjectDir(CWD), `${CONV}.jsonl`))
  })

  it('another harness\'s root is never searched (claude id, copilot root)', async () => {
    __setAccountRootsForTest(registryWith('copilot'))
    expect(await transcriptReaderFor('claude')!.resolve({ conversationId: CONV, cwd: CWD })).toBeNull()
    expect(await transcriptReaderFor('copilot')!.resolve({ conversationId: CONV }))
      .toBe(join(root, 'session-state', CONV, 'events.jsonl'))
  })

  it('without any account root nothing changes: an unknown id is still a miss', async () => {
    __setAccountRootsForTest({ accounts: [], bindings: {} })
    expect(await accountStoreDirs('claude')).toEqual([])
    expect(await transcriptReaderFor('claude')!.resolve({ conversationId: CONV, cwd: CWD })).toBeNull()
  })

  it('accountRootOf reads the registry the same way', async () => {
    __setAccountRootsForTest(registryWith('claude'))
    expect(await accountRootOf('acc_second')).toBe(root)
    expect(await accountRootOf(undefined)).toBeNull()
  })
})

describe('an account switch leaves the conversation in TWO roots: the chat follows the live one', () => {
  // 2026-10-25: a leader switched Principal → Vini; the switch COPIED its transcript into the new root,
  // then the session kept writing there. The reader took the first hit (the old root, frozen at the
  // switch), so the web chat stopped at the switch while the TUI went on.
  const CONV = '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b'
  const CWD = '/home/someone/ws'
  let oldRoot: string
  let newRoot: string
  const file = (root: string) => join(root, 'projects', encodeProjectDir(CWD), `${CONV}.jsonl`)

  beforeAll(async () => {
    oldRoot = await mkdtemp(join(tmpdir(), 'acct-old-'))
    newRoot = await mkdtemp(join(tmpdir(), 'acct-new-'))
    for (const r of [oldRoot, newRoot]) {
      await mkdir(join(r, 'projects', encodeProjectDir(CWD)), { recursive: true })
      await writeFile(file(r), JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-10-25T10:00:00Z', message: { role: 'user', content: 'x' } }) + '\n')
    }
    await utimes(file(oldRoot), new Date('2026-10-25T13:30:00Z'), new Date('2026-10-25T13:30:00Z'))
    await utimes(file(newRoot), new Date('2026-10-25T15:00:00Z'), new Date('2026-10-25T15:00:00Z'))
  })
  afterEach(() => { __setAccountRootsForTest(null); forgetChatTailPaths() })
  afterAll(async () => { await rm(oldRoot, { recursive: true, force: true }); await rm(newRoot, { recursive: true, force: true }) })

  const both = (first: string, second: string): AccountRootsSource => ({
    accounts: [{ id: 'a1', harness: 'claude', root: first }, { id: 'a2', harness: 'claude', root: second }], bindings: {},
  })

  it('the newest copy wins whichever root the registry lists first', async () => {
    __setAccountRootsForTest(both(oldRoot, newRoot))
    expect(await resolveClaudeTranscriptAnyAccount(CWD, CONV)).toBe(file(newRoot))
    expect(await transcriptReaderFor('claude')!.resolve({ conversationId: CONV, cwd: CWD })).toBe(file(newRoot))
    __setAccountRootsForTest(both(newRoot, oldRoot))
    forgetChatTailPaths()
    expect(await resolveClaudeTranscriptAnyAccount(CWD, CONV)).toBe(file(newRoot))
  })

  it('newestTranscript keeps the default store\'s hit when it is the newest, and a lone hit as it is', async () => {
    __setAccountRootsForTest(both(oldRoot, newRoot))
    expect(await newestTranscript('claude', file(newRoot), async dir => (dir === join(oldRoot, 'projects') ? file(oldRoot) : null)))
      .toBe(file(newRoot))
    expect(await newestTranscript('claude', null, async dir => (dir === join(oldRoot, 'projects') ? file(oldRoot) : null)))
      .toBe(file(oldRoot))
    expect(await newestTranscript('claude', null, async () => null)).toBeNull()
  })
})
