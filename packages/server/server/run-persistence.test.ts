import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { HOME_WRITABLE_CARVEOUTS, homeOf, nodeModulesDirs, outsideNodeModules, homeReadOnlySteps, homeScope, netnsInnerScript, netnsNotice, persistenceGuard, probeNetns, repoCarveOuts } from './run-netns'

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
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdout: 'pipe', stderr: 'pipe', env: gitTestEnv() })

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
  test('the carve-outs are the run home and the worktree + its common git dir — nothing else of the home, and NOT the shared bun cache', () => {
    expect(HOME_WRITABLE_CARVEOUTS).toEqual([])
    const { home, repo } = fakeHome()
    mkdirSync(join(home, '.bun/install/cache'), { recursive: true })
    mkdirSync(join(repo, 'node_modules/.bun/x'), { recursive: true }); mkdirSync(join(repo, 'packages/a/node_modules'), { recursive: true })
    const runHome = join(home, '.cache', 'run-x'); mkdirSync(runHome, { recursive: true })
    const [g] = persistenceGuard(runHome, [repo], home, {})
    expect(g!.writable.slice().sort()).toEqual([runHome, repo, join(repo, '.git')].sort())
    expect(g!.masked.slice().sort()).toEqual([join(repo, '.git', 'hooks'), join(repo, '.git', 'config'), join(repo, '.git', 'info'), join(repo, '.git', 'refs', 'replace'), join(repo, 'node_modules'), join(repo, 'packages/a/node_modules')].sort())
    expect(g!.writable.some(p => /\.claude|\.local\/bin|\.config|\.bashrc|\.ssh|\.bun/.test(p))).toBe(false)
  })
  test('nodeModulesDirs finds the hardlink farms, never descends into one, skips .git', () => {
    const d = tmp()
    for (const p of ['node_modules/a/node_modules', 'packages/x/node_modules', '.git/node_modules', 'a/b/c/d/e/f/node_modules']) mkdirSync(join(d, p), { recursive: true })
    expect(nodeModulesDirs(d).sort()).toEqual([join(d, 'node_modules'), join(d, 'packages/x/node_modules')].sort())
  })
  test('outsideNodeModules covers farms of a cwd that is outside every guarded home, and none inside one', () => {
    const inHome = fakeHome(); const away = tmp()
    mkdirSync(join(away, 'node_modules'), { recursive: true }); mkdirSync(join(inHome.repo, 'node_modules'), { recursive: true })
    const guards = [{ home: inHome.home, writable: [], masked: [] }]
    expect(outsideNodeModules([away, inHome.repo], guards)).toEqual([join(away, 'node_modules')])
  })
  test('R3: refs/replace and info/ of the common git dir are masked (they rewrite history for every worktree), and refs/replace exists so it can be', () => {
    const { home, repo } = fakeHome()
    rmSync(join(repo, '.git', 'refs', 'replace'), { recursive: true, force: true })
    const r = repoCarveOuts(repo, home)
    expect(r.masked).toContain(join(repo, '.git', 'refs', 'replace'))
    expect(r.masked).toContain(join(repo, '.git', 'info'))
    expect(existsSync(join(repo, '.git', 'refs', 'replace'))).toBe(true)
  })
  test('RS2: info/ is created when ABSENT so it can be masked (grafts cannot be planted in a common dir that lacks it)', () => {
    const { home, repo } = fakeHome()
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true })
    const r = repoCarveOuts(repo, home)
    expect(existsSync(join(repo, '.git', 'info'))).toBe(true)
    expect(r.masked).toContain(join(repo, '.git', 'info'))
  })
  test('R3: the help says plainly that .husky/_ is writable like the rest of the worktree, and what the farm coverage is', () => {
    const src = readFileSync(new URL('./cli-run.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/\.husky\/_ is WRITABLE/)
    expect(src).toMatch(/refs\/replace/); expect(src).toMatch(/info\/grafts/)
    expect(src).toMatch(/node_modules farm of a repo OTHER than the one you run from[^]*NOT covered/i)
  })
  test('QM3: homeOf is the passwd home, whatever $HOME says (a throwaway HOME must not become the protected home)', () => {
    const saved = process.env.HOME
    try {
      process.env.HOME = '/tmp/definitely-not-the-account-home'
      const fromPasswd = readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.split(':')[2] === String(process.getuid?.()))?.split(':')[5]
      if (fromPasswd) expect(homeOf()).toBe(fromPasswd)
      else expect(homeOf()).not.toBe('/tmp/definitely-not-the-account-home')
      expect(homeOf()).not.toBe(process.env.HOME)
    } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved }
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

  test('B1: a file with a second hard link OUTSIDE the worktree cannot be written through node_modules; the outside name is unchanged', async () => {
    const { home, repo } = fakeHome()
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    const outside = join(tmp(), 'twin.txt'); writeFileSync(outside, 'orig\n')
    linkSync(outside, join(repo, 'node_modules', 'shared.txt'))
    const out = await inRun(`echo evil >> node_modules/shared.txt 2>&1; echo "nm rc=$?"; echo evil > node_modules/new.txt 2>&1; echo "new rc=$?"; echo ok > fine.txt && echo "wt ok"`, [home], [], repo)
    expect(out).toMatch(/^nm rc=[1-9]/m); expect(out).toMatch(/^new rc=[1-9]/m); expect(out).toMatch(/Read-only file system/); expect(out).toContain('wt ok')
    expect(readFileSync(outside, 'utf8')).toBe('orig\n')
    expect(existsSync(join(repo, 'node_modules', 'new.txt'))).toBe(false)
  }, 60_000)

  test('R3: inside a run, refs/replace and info/grafts of the common dir cannot be written, while a normal commit still works', async () => {
    const { home, repo } = fakeHome()
    const out = await inRun(`git replace HEAD~0 HEAD 2>&1 | head -1; mkdir -p .git/refs/replace/x 2>&1; echo "mkdir rc=$?"; echo evil > .git/refs/replace/deadbeef 2>&1; echo "replace rc=$?"; echo evil > .git/info/grafts 2>&1; echo "grafts rc=$?"; echo c > c.txt; git add c.txt && git -c user.email=t@t -c user.name=t commit -q -m ok && echo "commit ok"`, [home], [], repo)
    for (const k of ['replace', 'grafts']) expect(out).toMatch(new RegExp(`^${k} rc=[1-9]`, 'm'))
    expect(out).toContain('commit ok')
    expect(existsSync(join(repo, '.git', 'info', 'grafts'))).toBe(false)
    expect(existsSync(join(repo, '.git', 'refs', 'replace', 'deadbeef'))).toBe(false)
  }, 60_000)

  test('RS2: inside a run, info/grafts cannot be planted even when the common dir had no info/', async () => {
    const { home, repo } = fakeHome()
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true })
    const out = await inRun(`mkdir -p .git/info 2>&1; echo evil > .git/info/grafts 2>&1; echo "grafts rc=$?"; echo c > c.txt; git add c.txt && git -c user.email=t@t -c user.name=t commit -q -m ok && echo "commit ok"`, [home], [], repo)
    expect(out).toMatch(/^grafts rc=[1-9]/m)
    expect(out).toContain('commit ok')
    expect(existsSync(join(repo, '.git', 'info', 'grafts'))).toBe(false)
  }, 60_000)

  test('M8: a cwd OUTSIDE every guarded home has its node_modules read-only inside the run (outsideNodeModules is wired into the launch)', async () => {
    const { home } = fakeHome()
    const away = tmp(); expect(git(away, 'init', '-q').exitCode).toBe(0)
    mkdirSync(join(away, 'node_modules'), { recursive: true }); mkdirSync(join(away, 'pkgs/a/node_modules'), { recursive: true })
    const twin = join(tmp(), 'twin.txt'); writeFileSync(twin, 'orig\n'); linkSync(twin, join(away, 'node_modules', 'shared.txt'))
    const out = await inRun(`echo evil >> node_modules/shared.txt 2>&1; echo "nm rc=$?"; echo x > node_modules/new 2>&1; echo "new rc=$?"; echo x > pkgs/a/node_modules/n 2>&1; echo "nested rc=$?"; echo ok > fine.txt && echo "wt ok"`, [home], [], away)
    for (const k of ['nm', 'new', 'nested']) expect(out).toMatch(new RegExp(`^${k} rc=[1-9]`, 'm'))
    expect(out).toContain('wt ok')
    expect(readFileSync(twin, 'utf8')).toBe('orig\n')
    expect(existsSync(join(away, 'node_modules', 'new'))).toBe(false)
  }, 60_000)

  test('the run gets a PRIVATE bun cache, and the shared one is not writable', async () => {
    const { home } = fakeHome()
    const out = await inRun(`echo "cache=$BUN_INSTALL_CACHE_DIR home=$HOME"; [ -w '${REAL_HOME}/.bun/install/cache' ] && echo SHARED-WRITABLE || echo shared-ro`, [home])
    expect(out).not.toContain('SHARED-WRITABLE')
    expect(out).toMatch(/cache=(\S+)\/\.cache\/bun-install home=\1\n/)
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
