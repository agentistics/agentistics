import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realContained } from './real-contained'

let root = ''
let inside = ''
let outside = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentistics-real-contained-'))
  inside = join(root, 'inside')
  mkdirSync(inside)
  writeFileSync(join(inside, 'plain.txt'), 'x')
  outside = mkdtempSync(join(tmpdir(), 'agentistics-real-contained-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'outside')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('realContained', () => {
  test('an ordinary path inside the root resolves to itself', async () => {
    const p = join(inside, 'plain.txt')
    expect(await realContained(inside, p)).toBe(p)
  })

  test('the root itself resolves', async () => {
    expect(await realContained(inside, inside)).toBe(inside)
  })

  test('a path outside the root is refused', async () => {
    expect(await realContained(inside, join(outside, 'secret.txt'))).toBeNull()
  })

  test('a symlink INSIDE the root pointing OUTSIDE it is refused, not followed', async () => {
    const link = join(inside, 'escape-link')
    symlinkSync(outside, link)
    expect(await realContained(inside, link)).toBeNull()
  })

  test('a symlink INSIDE the root pointing to another file INSIDE it resolves to the real target', async () => {
    const target = join(inside, 'real-target.txt')
    writeFileSync(target, 'y')
    const link = join(inside, 'inside-link')
    symlinkSync(target, link)
    expect(await realContained(inside, link)).toBe(target)
  })

  test('a path that does not exist refuses', async () => {
    expect(await realContained(inside, join(inside, 'nope.txt'))).toBeNull()
  })
})
