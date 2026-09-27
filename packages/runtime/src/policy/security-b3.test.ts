/**
 * security-b3.test.ts — the leader's B3 security review (2026-09-27, @085d5888), one describe per
 * finding. Every case here is the EXACT bypass the review described, written before its fix and
 * shown failing against 085d5888; the fixes are recorded in the B3 spec §8 (D-T3.S1–S4).
 *
 * Offline: paths resolve purely (`resolvePath` injected), except the symlink cases, which build
 * their own directory and use the real resolver.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PersonAnswer, PolicyRequest, PolicySubject, PolicyVerdict, ToolPermission } from '../tools/contract.ts'
import { scriptedAsker } from '../tools/testing.ts'
import { AGENTISTICS_DATA_DIRS, floorForPath, HOME_SECRET_PREFIXES } from './floor.ts'
import { createPolicy, type PolicyOptions } from './policy.ts'
import type { PolicyLayer, PolicyRule } from './rules.ts'

const HOME = '/home/u'
const WS = '/home/u/ws'

const pure = async (cwd: string, p: string): Promise<string> => resolve(cwd, p)

function policy(layers: PolicyLayer[] = [], extra: Partial<PolicyOptions> = {}) {
  return createPolicy({ layers, home: HOME, resolvePath: pure, now: () => new Date('2026-09-27T12:00:00Z'), ...extra })
}

const layer = (name: string, ...rules: PolicyRule[]): PolicyLayer => ({ name, rules })

let seq = 0
function req(subjects: PolicySubject[], o: { permission?: ToolPermission; tool?: string; answers?: PersonAnswer[] | null; ws?: string } = {}): PolicyRequest {
  return {
    call: { toolExecutionId: `sx_${++seq}`, toolName: o.tool ?? 'shell.start' },
    kind: 'shell' as PolicyRequest['kind'],
    permission: o.permission ?? 'ask',
    subjects,
    workspaceRoot: o.ws ?? WS,
    asker: o.answers === null || o.answers === undefined ? undefined : scriptedAsker(o.answers),
  }
}

const sh = (command: string, cwd = WS): PolicySubject => ({ action: 'shell', command, cwd, tty: false })

async function judge(command: string, layers: PolicyLayer[], extra: Partial<PolicyOptions> = {}, cwd = WS): Promise<PolicyVerdict> {
  return policy(layers, extra).evaluate(req([sh(command, cwd)]))
}

const ALLOW_SHELL: PolicyRule = { id: 'u.allow-shell', effect: 'allow', match: { action: 'shell' } }
const ALLOW_WRITES: PolicyRule = { id: 'u.allow-writes', effect: 'allow', match: { action: 'write' } }
const ALLOW_READS: PolicyRule = { id: 'u.allow-reads', effect: 'allow', match: { action: 'read' } }
/** Someone allowed everything under their own ~/.agentistics — the floor must still hold. */
const ALLOW_AGT: PolicyRule = { id: 'u.agt', effect: 'allow', match: { pathGlob: '~/.agentistics/**' } }
const ALLOW_HOME: PolicyRule = { id: 'u.home', effect: 'allow', match: { pathGlob: '~/**' } }
const EVERYTHING = [layer('user', ALLOW_SHELL, ALLOW_WRITES, ALLOW_READS, ALLOW_AGT, ALLOW_HOME)]

// ── F1 — the ~/.agentistics secret set is floor, not a liftable ask ─────────────────────────────

describe('F1 — the runtime\'s own data directory (its key store first) is the credential floor', () => {
  const secrets = [
    '/home/u/.agentistics/provider-keys/anthropic',
    '/home/u/.agentistics/provider-keys',
    '/home/u/.agentistics/machine-key',
    '/home/u/.agentistics/machine-key.json',
    '/home/u/.agentistics/connections/c1.json',
    '/home/u/.agentistics/github-backup.json',
    '/home/u/.agentistics/preferences.json',
    '/home/u/.agentistics/central/central.env',
    '/home/u/.agentistics/team/secret',
    '/home/u/.agentistics/content/ab/ab12',
    '/home/u/.agentistics/credentials.json',
    '/home/u/.agentistics',
    '/home/u/.claude/sessions/1234.abcd.key',
  ]
  for (const p of secrets) {
    test(`file.read ${p} → floor, even under a rule allowing ~/**`, async () => {
      const v = await policy(EVERYTHING).evaluate(req([{ action: 'read', path: p }], { tool: 'file.read', permission: 'auto' }))
      expect(v).toMatchObject({ decision: 'deny', policy: 'floor:credential-store' })
    })
  }
  test('`cat ~/.agentistics/provider-keys/anthropic` → floor under allow-everything', async () => {
    expect(await judge('cat ~/.agentistics/provider-keys/anthropic', EVERYTHING)).toMatchObject({ decision: 'deny', policy: 'floor:credential-store' })
  })
  test('`cd ~/.agentistics && cat provider-keys/x` → floor', async () => {
    expect(await judge('cd ~/.agentistics && cat provider-keys/x', EVERYTHING)).toMatchObject({ decision: 'deny', policy: 'floor:credential-store' })
  })
  test('a write into provider-keys (planting a key) → floor', async () => {
    const v = await policy(EVERYTHING).evaluate(req([{ action: 'write', path: '/home/u/.agentistics/provider-keys/openai', op: 'create' } as PolicySubject], { tool: 'file.write', permission: 'auto' }))
    expect(v).toMatchObject({ decision: 'deny', policy: 'floor:credential-store' })
  })
  test('a RELOCATED data dir the host passes (AGENTISTICS_DIR) is floor too', async () => {
    const v = await policy(EVERYTHING, { agentisticsDir: '/data/agt' })
      .evaluate(req([{ action: 'read', path: '/data/agt/provider-keys/anthropic' }], { tool: 'file.read', permission: 'auto', ws: '/data' }))
    expect(v).toMatchObject({ decision: 'deny', policy: 'floor:credential-store' })
  })
  test('a harness credential file the HOST passes as protectedPaths is floor (the runtime may not name it)', async () => {
    const v = await policy(EVERYTHING, { protectedPaths: ['~/.claude/.credentials.json'] })
      .evaluate(req([{ action: 'read', path: '/home/u/.claude/.credentials.json' }], { tool: 'file.read', permission: 'auto' }))
    expect(v).toMatchObject({ decision: 'deny', policy: 'floor:protected-path' })
  })
  test('near-misses are not floor', async () => {
    for (const p of ['/home/u/.agentistics-notes/x', '/home/u/ws/.agentistics/x', '/home/u/.claude/settings.json']) {
      const v = await policy(EVERYTHING).evaluate(req([{ action: 'read', path: p }], { tool: 'file.read', permission: 'auto' }))
      expect({ p, d: v.decision }).toEqual({ p, d: 'allow' })
    }
  })

  // The runtime may not import packages/server (D23) and provider-secrets.lint forbids it to spell
  // the key store's name, so the floor covers the WHOLE data directory. This pins that choice against
  // the server's own authoritative table of secrets (backup-plan.ts, `reason: 'secret'`), read as
  // TEXT: every `.agentistics/…` secret row must land on the floor. The harness rows are the host's.
  test('every `.agentistics` secret row of the server\'s backup-plan.ts is floor', () => {
    const src = readFileSync(join(import.meta.dir, '../../../server/server/backup/backup-plan.ts'), 'utf8')
    const rows = [...src.matchAll(/pattern: '([^'#]+)(?:#[^']*)?', match: '(?:prefix|contains)', reason: 'secret'/g)].map(m => m[1] ?? '').sort()
    const agt = rows.filter(r => r.startsWith('.agentistics/'))
    expect(agt.length).toBeGreaterThanOrEqual(8)
    const env = { home: HOME, workspaceRoot: WS, protectedPaths: [] as string[] }
    const notFloored = agt.filter(r => floorForPath(`${HOME}/${r}`, 'read', env)?.name !== 'credential-store'
      || floorForPath(`${HOME}/${r}/x`, 'read', env)?.name !== 'credential-store')
    expect(notFloored).toEqual([])
    expect(rows).toContain('.key')
    expect(HOME_SECRET_PREFIXES).toContain('*.key')
  })
  test('and config.ts still puts the data dir — and the key store inside it — where the floor looks', () => {
    const cfg = readFileSync(join(import.meta.dir, '../../../server/server/config.ts'), 'utf8')
    const dflt = /DEFAULT_AGENTISTICS_DATA_DIR = join\(HOME_DIR, '([^']+)'\)/.exec(cfg)?.[1]
    expect(AGENTISTICS_DATA_DIRS).toContain(dflt ?? '<not found in config.ts>')
    // provider keys and captures live INSIDE the data dir (so the whole-dir floor covers them)
    expect(cfg).toMatch(/PROVIDER_KEYS_DIR = join\(AGENTISTICS_DATA_DIR, /)
    expect(cfg).toMatch(/CONTENT_DIR = join\(AGENTISTICS_DATA_DIR, /)
  })
})

// ── F2 — a command-named WRITE target under .git is git-internals ───────────────────────────────

describe('F2 — shell commands that name a write target inside .git are the git-internals floor', () => {
  const layers = [layer('user', ALLOW_SHELL, ALLOW_WRITES)]
  const cases = [
    'cp evil.sh .git/hooks/pre-commit',
    'cp evil.sh /home/u/ws/.git/hooks/pre-commit',
    'cp -t .git/hooks evil.sh',
    'cp --target-directory=.git/hooks evil.sh',
    'mv evil.sh .git/hooks/post-checkout',
    'mv /home/u/ws/evil.sh /home/u/ws/.git/hooks/post-checkout',
    'tee -a .git/config',
    'echo x | tee .git/hooks/pre-push',
    'sed -i s/a/b/ .git/config',
    'sed --in-place=.bak s/a/b/ .git/config',
    'dd if=evil.sh of=.git/hooks/pre-commit',
    'chmod +x .git/hooks/pre-commit',
    'chmod 755 /home/u/ws/.git/hooks/pre-commit',
    'install -m 755 evil.sh .git/hooks/pre-commit',
    'ln -s ../../evil.sh .git/hooks/pre-commit',
    'ln -sf /tmp/evil .git/hooks/pre-commit',
    'truncate -s 0 .git/HEAD',
    'touch .git/hooks/pre-commit',
    'rsync evil.sh .git/hooks/pre-commit',
    'cd sub && cp ../evil.sh ../.git/hooks/pre-commit',
    'rm .git/index',
    'rm -rf .git',
    'rm -rf .git/hooks',
    'chmod -R 777 .git/hooks',
    'mv evil.sh .git',
    'find .git/hooks -name x -delete',
    'sed -n -i p .git/config',
    'git config --file .git/config core.hooksPath /tmp/h',
    'git config -f .git/config core.fsmonitor evil',
  ]
  for (const c of cases) {
    test(`${c} → floor:git-internals`, async () => {
      expect(await judge(c, layers)).toMatchObject({ decision: 'deny', policy: 'floor:git-internals' })
    })
  }
  test('reading .git stays allowed: cat / ls / git -C / --git-dir', async () => {
    for (const c of ['cat .git/config', 'ls .git/hooks', 'git -C .git/.. status', 'git --git-dir=.git log']) {
      expect((await judge(c, layers)).decision).toBe('allow')
    }
  })
  test('cp FROM .git into the workspace is a read of .git, not a write', async () => {
    expect((await judge('cp .git/config backup.cfg', layers)).decision).toBe('allow')
  })

  // `git config` / `git -c` change what git will EXECUTE (core.hooksPath, core.fsmonitor, core.pager,
  // alias.*, core.sshCommand) without naming a path under .git at all: an ask no rule lifts.
  const gitConfig = [
    'git config core.hooksPath ./h',
    'git -C . config core.hooksPath ./h',
    'git --git-dir=.git config core.fsmonitor "touch /tmp/pwn"',
    'git config --global core.hooksPath ./h',
    'git -c core.hooksPath=./h commit -m x',
    'git -c core.fsmonitor="touch /tmp/pwn" status',
    'git --config-env=core.pager=EVIL log',
  ]
  for (const c of gitConfig) {
    test(`${c} → an ask no allow rule lifts (no person → deny)`, async () => {
      const v = await judge(c, layers)
      expect(v.decision).toBe('deny')
      if (v.decision === 'deny') expect(v.code).toBe('policy.denied.no-person')
    })
  }
  test('reading git config stays allowed', async () => {
    for (const c of ['git config --get user.name', 'git config --list', 'git config -l', 'git config --get-regexp alias']) {
      expect((await judge(c, layers)).decision).toBe('allow')
    }
  })

  test('a symlink inside the workspace pointing into .git/hooks is judged by where it lands', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agt-b3sec-')))
    try {
      const ws = join(base, 'ws')
      mkdirSync(join(ws, '.git', 'hooks'), { recursive: true })
      symlinkSync(join(ws, '.git', 'hooks'), join(ws, 'h'))
      const p = createPolicy({ layers, home: base, now: () => new Date('2026-09-27T12:00:00Z') })
      for (const c of ['cp evil.sh h/pre-commit', 'chmod +x h/pre-commit', 'tee h/pre-push']) {
        const v = await p.evaluate(req([sh(c, ws)], { ws }))
        expect(v).toMatchObject({ decision: 'deny', policy: 'floor:git-internals' })
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

// ── F3 — assignments that change what a later command resolves to are judged ────────────────────

describe('F3 — leading / exported assignments of resolution-changing variables ask, and no rule lifts them', () => {
  const layers = [layer('user', ALLOW_SHELL)]
  const cases = [
    'PATH=/tmp/evil:$PATH ls',
    'PATH=/tmp/evil',
    'export PATH=/tmp/evil:$PATH',
    'export PATH',
    'declare -x PATH=/tmp/evil',
    'typeset -x PATH=/tmp/evil',
    'readonly PATH=/tmp/evil',
    'env PATH=/tmp/evil ls',
    'LD_PRELOAD=/tmp/evil.so ls',
    'export LD_LIBRARY_PATH=/tmp',
    'BASH_ENV=/tmp/evil bash script.sh',
    'IFS=/ ls',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/h git commit -m x',
    'export GIT_SSH_COMMAND="touch /tmp/pwn"',
    'GIT_DIR=/tmp/x git status',
    'CDPATH=/ ls',
    'export PROMPT_COMMAND="touch /tmp/pwn"',
    'NODE_OPTIONS="--require /tmp/evil.js" node x.js',
    'alias ls="touch /tmp/pwn"',
    'hash -p ./evil ls',
    'enable -f ./evil.so ls',
  ]
  for (const c of cases) {
    test(`${c} → not allowed without a person`, async () => {
      const v = await judge(c, layers)
      expect(v.decision).toBe('deny')
      if (v.decision === 'deny') expect(v.code).toBe('policy.denied.no-person')
    })
  }
  test('harmless assignments stay allowed', async () => {
    for (const c of ['FOO=1 ls', 'export FOO=bar', 'NODE_ENV=test ls', 'CI=1 env', 'X=1']) {
      expect((await judge(c, layers)).decision).toBe('allow')
    }
  })
  test('a session approval does not cover it either — the question offers no "for this session"', async () => {
    const p = policy(layers)
    const asker = scriptedAsker([{ answered: true, choice: 0 }])
    await p.evaluate({ ...req([sh('export PATH=/tmp/evil:$PATH')]), asker })
    expect(asker.asked[0]!.options.map(o => o.label)).toEqual(['Allow once', 'Deny'])
  })
})

// ── F4 — secret-shaped files INSIDE the workspace ask by default ────────────────────────────────

describe('F4 — in-workspace .env*, *.pem, id_* ask by default; a rule naming the path allows it', () => {
  const secretFiles = ['.env', '.env.local', '.env.production', '.envrc', 'server.pem', 'certs/tls.pem', 'id_rsa', 'deploy/id_ed25519', 'sub/dir/.env']
  const broad = [layer('user', ALLOW_SHELL, ALLOW_READS, ALLOW_WRITES)]
  for (const f of secretFiles) {
    test(`file.read ${f} → asks (no person → deny) under a rule allowing every read`, async () => {
      const v = await policy(broad).evaluate(req([{ action: 'read', path: join(WS, f) }], { tool: 'file.read', permission: 'auto' }))
      expect(v.decision).toBe('deny')
      if (v.decision === 'deny') expect(v.code).toBe('policy.denied.no-person')
    })
    test(`\`cat ${f}\` → asks`, async () => {
      const v = await judge(`cat ${f}`, broad)
      expect(v.decision).toBe('deny')
      if (v.decision === 'deny') expect(v.code).toBe('policy.denied.no-person')
    })
  }
  test('`< .env` redirection read → asks', async () => {
    const v = await judge('grep KEY < .env', broad)
    expect(v.decision).toBe('deny')
  })
  test('a rule that NAMES the path allows it', async () => {
    const named = [layer('user', ALLOW_SHELL, ALLOW_READS, { id: 'u.env-example', effect: 'allow', match: { pathGlob: '.env.example' } })]
    const v = await policy(named).evaluate(req([{ action: 'read', path: join(WS, '.env.example') }], { tool: 'file.read', permission: 'auto' }))
    expect(v).toMatchObject({ decision: 'allow', policy: 'u.env-example' })
    expect((await judge('cat .env.example', named)).decision).toBe('allow')
  })
  test('ordinary files and near-misses are untouched', async () => {
    for (const f of ['src/env.ts', 'environment.md', 'id_utils.ts', 'id_rsa.pub', 'pem.ts', 'README.md']) {
      const v = await policy(broad).evaluate(req([{ action: 'read', path: join(WS, f) }], { tool: 'file.read', permission: 'auto' }))
      expect(v.decision).toBe('allow')
    }
  })
})
