import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Lint over this package's own source: the vault never prints (a `console.` in here is one refactor
 * from logging a key), and no fixture anywhere in it looks like a real provider credential — tests
 * use random bytes or `TEST-NOT-A-SECRET-…` markers.
 */
const SRC = import.meta.dir

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : [])
}

const KEY_PREFIXES = [/sk-ant-[A-Za-z0-9]/, /\bsk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9]/, /AIza[0-9A-Za-z_-]{20,}/, /xox[bpa]-[0-9A-Za-z]/]

describe('vault package lint', () => {
  it('no console output in non-test source', () => {
    const offenders = files(SRC).filter(f => !f.endsWith('.test.ts')).filter(f => /\bconsole\./.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
  it('no provider-key-shaped literal anywhere in the package (tests included)', () => {
    const offenders: string[] = []
    for (const f of files(SRC)) {
      const t = readFileSync(f, 'utf8')
      for (const re of KEY_PREFIXES) if (f !== import.meta.path && re.test(t)) offenders.push(`${f}: ${re}`)
    }
    expect(offenders).toEqual([])
  })
  it('result types carry no plaintext field besides the open result', () => {
    const t = readFileSync(join(SRC, 'migrate.ts'), 'utf8')
    expect(/MigrationOutcome[\s\S]*?plaintext/.test(t.slice(t.indexOf('export type MigrationOutcome'), t.indexOf('/** Remove crashed')))).toBe(false)
  })
})
