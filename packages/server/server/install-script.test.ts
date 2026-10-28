import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, '../../../install.sh')
const MARKER = '# agentop: add ~/.local/bin to PATH'

const have = (sh: string): boolean => Bun.spawnSync(['sh', '-c', `command -v ${sh}`]).exitCode === 0

/** Runs install.sh under `interp` in a throwaway HOME with a fake release (a local dir). */
function run(interp: string, shellVar: string, os = 'Linux', arch = 'x86_64', extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'install-sh-'))
  const home = join(root, 'home')
  const rel = join(root, 'release')
  mkdirSync(home)
  mkdirSync(rel)
  const asset = os === 'Darwin' ? (arch === 'arm64' ? 'agentop-darwin-arm64' : 'agentop-darwin-x64') : 'agentop'
  // The stub only records its arguments, so a test can assert what the installer asked it to do.
  writeFileSync(join(rel, asset), `#!/bin/sh\necho "$*" >> "${home}/calls.log"\n`)
  chmodSync(join(rel, asset), 0o755)
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    SHELL: shellVar,
    AGENTOP_INSTALL_BASE_URL: `file://${rel}`,
    AGENTOP_INSTALL_OS: os,
    AGENTOP_INSTALL_ARCH: arch,
    AGENTOP_INSTALL_SKIP_TMUX: '1',
    // Never probe the real dashboard port from a test.
    AGENTOP_INSTALL_PORT: '59999',
    AGENTOP_INSTALL_TTY: join(root, 'no-such-tty'),
    ...extra,
  }
  const exec = () => Bun.spawnSync([interp, SCRIPT], { env, stdin: 'ignore' })
  return { home, root, exec, env }
}

const read = (p: string) => readFileSync(p, 'utf8')
const count = (s: string, needle: string) => s.split(needle).length - 1

for (const interp of ['sh', 'dash', 'bash', 'zsh'].filter(have)) {
  describe(`install.sh under ${interp}`, () => {
    test('zsh login shell -> ~/.zshrc, once', () => {
      const t = run(interp, '/bin/zsh')
      try {
        const r = t.exec()
        expect(r.exitCode).toBe(0)
        expect(existsSync(join(t.home, '.local/bin/agentop'))).toBe(true)
        const rc = read(join(t.home, '.zshrc'))
        expect(rc).toContain('export PATH="$HOME/.local/bin:$PATH"')
        expect(existsSync(join(t.home, '.bashrc'))).toBe(false)
        expect(r.stdout.toString()).toContain('export PATH="$HOME/.local/bin:$PATH"')
        expect(t.exec().exitCode).toBe(0)
        expect(count(read(join(t.home, '.zshrc')), MARKER)).toBe(1)
      } finally {
        rmSync(t.root, { recursive: true, force: true })
      }
    })

    test('bash login shell -> ~/.bashrc only on Linux, plus ~/.bash_profile on macOS', () => {
      const t = run(interp, '/bin/bash')
      try {
        expect(t.exec().exitCode).toBe(0)
        expect(read(join(t.home, '.bashrc'))).toContain(MARKER)
        expect(existsSync(join(t.home, '.bash_profile'))).toBe(false)
        t.exec()
        expect(count(read(join(t.home, '.bashrc')), MARKER)).toBe(1)
      } finally {
        rmSync(t.root, { recursive: true, force: true })
      }
      const m = run(interp, '/bin/bash', 'Darwin', 'arm64')
      try {
        expect(m.exec().exitCode).toBe(0)
        expect(existsSync(join(m.home, '.local/bin/agentop'))).toBe(true)
        expect(read(join(m.home, '.bashrc'))).toContain(MARKER)
        expect(read(join(m.home, '.bash_profile'))).toContain(MARKER)
      } finally {
        rmSync(m.root, { recursive: true, force: true })
      }
    })

    test('fish login shell -> conf.d/agentop.fish with fish_add_path', () => {
      const t = run(interp, '/usr/bin/fish')
      try {
        expect(t.exec().exitCode).toBe(0)
        const f = read(join(t.home, '.config/fish/conf.d/agentop.fish'))
        expect(f).toContain('fish_add_path')
        t.exec()
        expect(count(read(join(t.home, '.config/fish/conf.d/agentop.fish')), MARKER)).toBe(1)
      } finally {
        rmSync(t.root, { recursive: true, force: true })
      }
    })

    test('unknown shell -> ~/.profile', () => {
      const t = run(interp, '/bin/ksh')
      try {
        expect(t.exec().exitCode).toBe(0)
        expect(read(join(t.home, '.profile'))).toContain(MARKER)
      } finally {
        rmSync(t.root, { recursive: true, force: true })
      }
    })
  })
}

const calls = (home: string): string[] => {
  const f = join(home, 'calls.log')
  return existsSync(f) ? read(f).split('\n').filter(Boolean) : []
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('install.sh start offer', () => {
  const root = process.getuid?.() === 0
  test('no terminal and no env: asks nothing, starts nothing, prints the commands', () => {
    const t = run('sh', '/bin/bash')
    try {
      const r = t.exec()
      expect(r.exitCode).toBe(0)
      expect(calls(t.home)).toEqual([])
      expect(r.stdout.toString()).toContain('autostart server enable')
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  test('AGENTOP_INSTALL_START=no calls nothing', () => {
    const t = run('sh', '/bin/bash', 'Linux', 'x86_64', { AGENTOP_INSTALL_START: 'no', AGENTOP_INSTALL_AUTOSTART: 'yes' })
    try {
      expect(t.exec().exitCode).toBe(0)
      expect(calls(t.home)).toEqual([])
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  test.skipIf(root)('yes + yes: recommended defaults, then autostart server enable', () => {
    const t = run('sh', '/bin/bash', 'Linux', 'x86_64', { AGENTOP_INSTALL_START: 'yes', AGENTOP_INSTALL_AUTOSTART: 'yes' })
    try {
      const r = t.exec()
      expect(r.exitCode).toBe(0)
      expect(calls(t.home)).toEqual(['setup --defaults', 'autostart server enable'])
      expect(r.stdout.toString()).toContain('http://localhost:59999')
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  test.skipIf(root)('yes + no boot: starts once in the background, no autostart', async () => {
    const t = run('sh', '/bin/bash', 'Linux', 'x86_64', { AGENTOP_INSTALL_START: 'yes', AGENTOP_INSTALL_AUTOSTART: 'no' })
    try {
      expect(t.exec().exitCode).toBe(0)
      for (let i = 0; i < 50 && calls(t.home).length < 2; i++) await sleep(100)
      expect(calls(t.home)).toEqual(['setup --defaults', 'server'])
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  test.skipIf(root)('terminal answers: Enter means yes to both, "n" declines the boot offer', async () => {
    const yes = run('sh', '/bin/bash')
    writeFileSync(join(yes.root, 'tty'), '\n\n')
    yes.env.AGENTOP_INSTALL_TTY = join(yes.root, 'tty')
    const no = run('sh', '/bin/bash')
    writeFileSync(join(no.root, 'tty'), '\nn\n')
    no.env.AGENTOP_INSTALL_TTY = join(no.root, 'tty')
    try {
      expect(yes.exec().exitCode).toBe(0)
      expect(calls(yes.home)).toEqual(['setup --defaults', 'autostart server enable'])
      expect(no.exec().exitCode).toBe(0)
      for (let i = 0; i < 50 && calls(no.home).length < 2; i++) await sleep(100)
      expect(calls(no.home)).toEqual(['setup --defaults', 'server'])
    } finally {
      rmSync(yes.root, { recursive: true, force: true })
      rmSync(no.root, { recursive: true, force: true })
    }
  })
})

test('install.sh stays POSIX sh', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  expect(src.startsWith('#!/bin/sh\n')).toBe(true)
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  expect(code).not.toContain('[[')
  expect(code).not.toContain('pipefail')
})
