import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME_WRITABLE_CARVEOUTS, homeOf, homeReadOnlySteps, homeScope, netnsInnerScript, netnsNotice, persistenceGuard, probeNetns, repoCarveOuts } from './run-netns'

/**
 * RUN.ISOLAMENTO-PERSISTENCIA: from inside `agentop run --rm` the REAL home is read-only (except named carve-outs), so a process cannot
 * plant ~/.claude/skills/<x>/SKILL.md, ~/.local/bin/<x>, ~/.config/systemd/user/<x>.service or a ~/.bashrc line by ABSOLUTE path.
 * These tests may themselves run inside a run, where the real home is already read-only, and they must never write a real config path:
 * the live bypass attempts target a FAKE home under /tmp that the run is told to protect exactly like the real one
 * (AGENTISTICS_RUN_EXTRA_PROTECTED_HOMES, a seam that can only ADD a protected tree), and the real persistence points are only probed
 * with `[ -w ]`.
 */
const REAL_HOME = realpathSync(homeOf())
const decision = probeNetns(false)
const skipReason = decision.mode === 'netns' ? null : decision.reason
const CLI = join(import.meta.dir, '..', 'bin', 'cli.ts')
const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = realpathSync(mkdtempSync('/tmp/pp-home-')); made.push(d); return d }
/** A fake home with the usual persistence points, and a repo in it. */
function fakeHome(): { home: string; repo: string } {
  const home = tmp()
  for (const d of ['.claude/skills', '.local/bin', '.config/systemd/user', '.ssh', 'work']) mkdirSync(join(home, d), { recursive: true })
  for (const f of ['.bashrc', '.profile', '.gitconfig', '.claude/settings.json']) writeFileSync(join(home, f), 'orig\n')
  const repo = join(home, 'work', 'repo'); mkdirSync(repo)
  expect(git(repo, 'init', '-q').exitCode).toBe(0)
  writeFileSync(join(repo, 'a.txt'), 'a'); git(repo, 'add', 'a.txt')
  return { home, repo }
}
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdout: 'pipe', stderr: 'pipe', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) })

async function inRun(script: string, protect: string[], extra: string[] = [], cwd?: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, 'run', '--rm', ...extra, '--', 'sh', '-c', script], {
    stdout: 'pipe', stderr: 'pipe', ...(cwd ? { cwd } : {}),
    env: { ...process.env, AGENTISTICS_RUN_EXTRA_PROTECTED_HOMES: protect.join(':'), AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_FLOWS: '', AGENTISTICS_HEAVY_JOB: '1' },
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return out + '\n' + err
}

describe('RUN.ISOLAMENTO-PERSISTENCIA: the mount plan (pure)', () => {
  const h = { home: '/home/u', writable: ['/home/u/.cache/run-1', '/home/u/proj/wt', '/home/u/proj/.git', '/mnt/other', '/home/u'], masked: ['/home/u/proj/.git/hooks', '/home/u/proj/.git/config', '/home/u/elsewhere/.git/hooks'] }
  const steps = homeReadOnlySteps(h)
  test('the home goes read-only first, then each carve-out is re-opened read-write, then the masks are read-only again', () => {
    expect(steps.slice(0, 2)).toEqual([`mount --rbind '/home/u' '/home/u'`, `mount -o remount,bind,ro '/home/u'`])
    const idx = (s: string) => steps.indexOf(s)
    for (const w of ['/home/u/.cache/run-1', '/home/u/proj/wt', '/home/u/proj/.git']) expect(idx(`mount -o remount,bind,rw '${w}'`)).toBeGreaterThan(1)
    for (const m of ['/home/u/proj/.git/hooks', '/home/u/proj/.git/config']) expect(idx(`mount -o remount,bind,ro '${m}'`)).toBeGreaterThan(idx(`mount -o remount,bind,rw '/home/u/proj/.git'`))
  })
  test('a carve-out outside the home, or the home itself, is never re-opened; a mask outside every carve-out is dropped', () => {
    const text = steps.join('\n')
    expect(text).not.toContain('/mnt/other')
    expect(text).not.toContain(`remount,bind,rw '/home/u'`)
    expect(text).not.toContain('/home/u/elsewhere')
  })
  test('homeScope tells inside / home / outside, and a lookalike prefix is outside', () => {
    expect(homeScope('/home/u', '/home/u/a')).toBe('inside')
    expect(homeScope('/home/u', '/home/u')).toBe('home')
    expect(homeScope('/home/u', '/home/user2/a')).toBe('outside')
    expect(homeScope('/home/u', '/home/u/../root')).toBe('outside')
  })
  test('the inner script installs the home mounts before the store / hiding mounts, and only when asked', () => {
    const on = netnsInnerScript(1000, 1000, [47291], [], [], { homeReadOnly: [h], readOnly: ['/home/u/.agentistics'] })
    expect(on.indexOf(`mount -o remount,bind,ro '/home/u'`)).toBeGreaterThan(0)
    expect(on.indexOf(`mount -o remount,bind,ro '/home/u'`)).toBeLessThan(on.indexOf(`mount --bind '/home/u/.agentistics'`))
    expect(netnsInnerScript(1000, 1000, [47291], [], [], {})).not.toContain('--rbind')
  })
  test('the carve-outs are the run home, the bun install cache and the worktree + its common git dir — nothing else of the home', () => {
    expect(HOME_WRITABLE_CARVEOUTS).toEqual(['.bun/install/cache'])
    const { home, repo } = fakeHome()
    mkdirSync(join(home, '.bun/install/cache'), { recursive: true })
    const runHome = join(home, '.cache', 'run-x'); mkdirSync(runHome, { recursive: true })
    const [g] = persistenceGuard(runHome, [repo], home, {})
    expect(g!.writable.slice().sort()).toEqual([runHome, join(home, '.bun/install/cache'), repo, join(repo, '.git')].sort())
    expect(g!.masked).toEqual([join(repo, '.git', 'hooks'), join(repo, '.git', 'config')])
    expect(g!.writable.some(p => /\.claude|\.local\/bin|\.config|\.bashrc|\.ssh/.test(p))).toBe(false)
  })
  test('the seam adds protected trees and cannot remove the real home', () => {
    const { home } = fakeHome()
    const gs = persistenceGuard(join(home, 'r'), [], REAL_HOME, { AGENTISTICS_RUN_EXTRA_PROTECTED_HOMES: `${home}:/does/not/exist:relative` })
    expect(gs.map(g => g.home)).toEqual([REAL_HOME, home])
    expect(persistenceGuard(join(home, 'r'), [], REAL_HOME, { AGENTISTICS_RUN_EXTRA_PROTECTED_HOMES: '' }).map(g => g.home)).toEqual([REAL_HOME])
  })
  test('a cwd that is not in a repository, or whose repository is the home itself, gets no carve-out', () => {
    const plain = tmp()
    expect(repoCarveOuts(plain, plain).writable).toEqual([])
    const top = tmp(); git(top, 'init', '-q')
    expect(repoCarveOuts(top, top).writable).toEqual([]) // repo root === "home": never opened
  })
  test('the fallback says persistence is NOT prevented', () => {
    expect(netnsNotice({ mode: 'none', reason: 'x', deliberate: false })).toMatch(/Persistence is NOT prevented/)
  })
})

describe.skipIf(skipReason !== null)(`RUN.ISOLAMENTO-PERSISTENCIA: live, inside a real run${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  test('a write by ABSOLUTE path into a protected home fails with a read-only filesystem — skills, bin, systemd unit, rc files, ssh; HOME set or unset', async () => {
    const { home } = fakeHome()
    const out = await inRun(`
      mkdir -p ${home}/.claude/skills/x 2>&1; echo "skills-mkdir rc=$?"
      echo evil > ${home}/.claude/skills/SKILL.md 2>&1; echo "skills-file rc=$?"
      echo evil > ${home}/.local/bin/x 2>&1; echo "bin rc=$?"
      echo evil > ${home}/.config/systemd/user/x.service 2>&1; echo "unit rc=$?"
      echo evil >> ${home}/.bashrc 2>&1; echo "bashrc rc=$?"
      echo evil >> ${home}/.profile 2>&1; echo "profile rc=$?"
      echo evil >> ${home}/.gitconfig 2>&1; echo "gitconfig rc=$?"
      echo evil > ${home}/.ssh/authorized_keys 2>&1; echo "ssh rc=$?"
      echo evil > ${home}/.claude/settings.json 2>&1; echo "settings rc=$?"
      env -u HOME sh -c 'echo evil > ${home}/.local/bin/nohome' 2>&1; echo "nohome rc=$?"
      ln -s /etc/passwd ${home}/.local/bin/link 2>&1; echo "symlink rc=$?"
      chmod 777 ${home}/.local/bin 2>&1; echo "chmod rc=$?"
      rm -f ${home}/.bashrc 2>&1; echo "rm rc=$?"
      mv ${home}/.profile ${home}/.profile.bak 2>&1; echo "mv rc=$?"`, [home])
    expect(out).toMatch(/Read-only file system/)
    for (const k of ['skills-mkdir', 'skills-file', 'bin', 'unit', 'bashrc', 'profile', 'gitconfig', 'ssh', 'settings', 'nohome', 'symlink', 'chmod', 'rm', 'mv']) expect(out).toMatch(new RegExp(`^${k} rc=[1-9]`, 'm'))
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('orig\n')
    expect(readFileSync(join(home, '.profile'), 'utf8')).toBe('orig\n')
    expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe('orig\n')
    for (const p of ['.claude/skills/x', '.claude/skills/SKILL.md', '.local/bin/x', '.local/bin/nohome', '.local/bin/link', '.config/systemd/user/x.service', '.ssh/authorized_keys', '.profile.bak']) expect(existsSync(join(home, p))).toBe(false)
  }, 60_000)

  test('the REAL persistence points are not writable from inside (probed with test -w, never written)', async () => {
    const targets = ['.claude', '.claude/skills', '.claude/settings.json', '.claude.json', '.codex', '.config', '.config/systemd/user', '.local/bin', '.local/bin/agentop', '.bashrc', '.profile', '.zshrc', '.ssh', '.gitconfig', '.agentistics']
      .map(t => join(REAL_HOME, t)).filter(existsSync)
    expect(targets.length).toBeGreaterThan(0)
    const out = await inRun(targets.map(t => `[ -w '${t}' ] && echo "WRITABLE ${t}" || echo "ro ${t}"`).join('; '), [])
    expect(out).not.toMatch(/^WRITABLE /m)
    for (const t of targets) expect(out).toContain(`ro ${t}`)
  }, 60_000)

  test('control: the same write from OUTSIDE succeeds, and inside the run its own HOME, TMPDIR and /tmp are writable', async () => {
    const { home } = fakeHome()
    writeFileSync(join(home, '.local/bin/outside'), 'ok')
    expect(readFileSync(join(home, '.local/bin/outside'), 'utf8')).toBe('ok')
    const out = await inRun(`echo a > "$HOME/own" && echo "own ok"; echo a > "$TMPDIR/t" && echo "tmp ok"; d=$(mktemp -d /tmp/pp-XXXXXX) && echo a > $d/f && echo "slash-tmp ok"; rm -rf $d`, [home])
    for (const k of ['own', 'tmp', 'slash-tmp']) expect(out).toContain(`${k} ok`)
  }, 60_000)

  test('the worktree the run starts in stays writable and `git commit` works; its hooks, config and the rest of the home do not', async () => {
    const { home, repo } = fakeHome()
    const out = await inRun(`echo b > b.txt && echo "wt ok"; git add b.txt && git -c user.email=t@t -c user.name=t commit -q -m inside && echo "commit ok"
      echo x > .git/hooks/pre-commit 2>&1; echo "hook rc=$?"; echo x >> .git/config 2>&1; echo "config rc=$?"
      echo x > ../sibling 2>&1; echo "sibling rc=$?"; echo x > ${home}/.local/bin/x 2>&1; echo "bin rc=$?"
      echo x > ../../.local/bin/rel 2>&1; echo "rel rc=$?"; cd .git && echo x > hooks/h2 2>&1; echo "hookcd rc=$?"; echo x > ../../../.bashrc 2>&1; echo "rc-rel rc=$?"`, [home], [], repo)
    expect(out).toContain('wt ok'); expect(out).toContain('commit ok')
    for (const k of ['hook', 'config', 'sibling', 'bin', 'rel', 'hookcd', 'rc-rel']) expect(out).toMatch(new RegExp(`^${k} rc=[1-9]`, 'm'))
    expect(git(repo, 'log', '--format=%s', '-1').stdout.toString().trim()).toBe('inside')
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false)
    expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('x\n')
    expect(existsSync(join(home, 'work', 'sibling'))).toBe(false)
    expect(existsSync(join(home, '.local/bin/rel'))).toBe(false)
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('orig\n')
  }, 60_000)

  test('a bun install and a bun test still run inside (the run home and the worktree are enough)', async () => {
    const { home, repo } = fakeHome()
    writeFileSync(join(repo, 'package.json'), '{"name":"pp","version":"0.0.0"}')
    writeFileSync(join(repo, 'x.test.ts'), `import {test,expect} from 'bun:test'; test('t',()=>expect(1).toBe(1))`)
    const out = await inRun(`bun install 2>&1 | tail -1; echo "install rc=$?"; ${process.execPath} test x.test.ts 2>&1 | tail -4`, [home], [], repo)
    expect(out).toMatch(/install rc=0/); expect(out).toMatch(/1 pass/)
  }, 120_000)

  test('--no-netns (the fallback) leaves the tree writable and SAYS persistence is not prevented', async () => {
    const { home } = fakeHome()
    const out = await inRun(`echo x > ${home}/.local/bin/fallback 2>&1; echo "rc=$?"`, [home], ['--no-netns'])
    expect(out).toMatch(/Persistence is NOT prevented/)
    expect(out).toMatch(/^rc=0/m)
    expect(existsSync(join(home, '.local/bin/fallback'))).toBe(true)
  }, 60_000)
})
