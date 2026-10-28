import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, '../../../install.sh')
const MARKER = '# agentop: add ~/.local/bin to PATH'

const have = (sh: string): boolean => Bun.spawnSync(['sh', '-c', `command -v ${sh}`]).exitCode === 0

/** Runs install.sh under `interp` in a throwaway HOME with a fake release (a local dir). */
function run(interp: string, shellVar: string, os = 'Linux', arch = 'x86_64') {
  const root = mkdtempSync(join(tmpdir(), 'install-sh-'))
  const home = join(root, 'home')
  const rel = join(root, 'release')
  mkdirSync(home)
  mkdirSync(rel)
  const asset = os === 'Darwin' ? (arch === 'arm64' ? 'agentop-darwin-arm64' : 'agentop-darwin-x64') : 'agentop'
  writeFileSync(join(rel, asset), '#!/bin/sh\necho fake\n')
  chmodSync(join(rel, asset), 0o755)
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    SHELL: shellVar,
    AGENTOP_INSTALL_BASE_URL: `file://${rel}`,
    AGENTOP_INSTALL_OS: os,
    AGENTOP_INSTALL_ARCH: arch,
    AGENTOP_INSTALL_SKIP_TMUX: '1',
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

test('install.sh stays POSIX sh', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  expect(src.startsWith('#!/bin/sh\n')).toBe(true)
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  expect(code).not.toContain('[[')
  expect(code).not.toContain('pipefail')
})
