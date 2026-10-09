import { describe, expect, test } from 'bun:test'
import { runSetup, SETUP_USAGE } from './cli-setup'

describe('runSetup --help', () => {
  for (const flag of ['--help', '-h']) {
    test(`${flag} prints the usage and exits 0 without a TTY`, async () => {
      const chunks: string[] = []
      const orig = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true }) as typeof process.stdout.write
      try {
        expect(await runSetup([flag])).toBe(0)
      } finally {
        process.stdout.write = orig
      }
      expect(chunks.join('')).toBe(SETUP_USAGE)
    })
  }
})
