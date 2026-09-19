import { describe, expect, test } from 'bun:test'
import {
  isSafeRelativePath, MAX_DRAG_PATH_LENGTH, readRepoDrag, REPO_DRAG_MIME, writeRepoDrag,
  type RepoDragPayload,
} from './repoDrag'

/**
 * A minimal `DataTransfer` stand-in — this repo has no DOM (no jsdom), and the real interface is a
 * thin key/value store for exactly the two methods this module calls. A `Map` is the actual store,
 * so a hostile test can write directly into it without going through the writer at all.
 */
function fakeDataTransfer(entries: Record<string, string> = {}): DataTransfer {
  const store = new Map(Object.entries(entries))
  return {
    setData: (type: string, value: string) => { store.set(type, value) },
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer
}

describe('writeRepoDrag', () => {
  test('sets both the structured MIME and text/plain to the relative path', () => {
    const dt = fakeDataTransfer()
    const payload: RepoDragPayload = { sessionId: 's1', path: 'src/a.ts', kind: 'file' }
    writeRepoDrag(dt, payload)
    expect(JSON.parse(dt.getData(REPO_DRAG_MIME))).toEqual(payload)
    expect(dt.getData('text/plain')).toBe('src/a.ts')
  })
})

describe('readRepoDrag', () => {
  test('round-trips exactly what the writer wrote, for the same session', () => {
    const dt = fakeDataTransfer()
    writeRepoDrag(dt, { sessionId: 's1', path: 'src/a.ts', kind: 'file' })
    expect(readRepoDrag(dt, 's1')).toEqual({ sessionId: 's1', path: 'src/a.ts', kind: 'file' })
  })

  test('a directory payload round-trips too', () => {
    const dt = fakeDataTransfer()
    writeRepoDrag(dt, { sessionId: 's1', path: 'src', kind: 'dir' })
    expect(readRepoDrag(dt, 's1')).toEqual({ sessionId: 's1', path: 'src', kind: 'dir' })
  })

  test('a payload for ANOTHER session is refused, even though it is well-formed', () => {
    const dt = fakeDataTransfer()
    writeRepoDrag(dt, { sessionId: 'other-session', path: 'src/a.ts', kind: 'file' })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  test('nothing of ours on the transfer at all', () => {
    const dt = fakeDataTransfer({ 'text/plain': 'just some text' })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  test('a getData that throws (a browser refusing a read outside drop) is treated as absent', () => {
    const dt = {
      getData: () => { throw new Error('not readable here') },
      setData: () => {},
    } as unknown as DataTransfer
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  test('malformed JSON', () => {
    const dt = fakeDataTransfer({ [REPO_DRAG_MIME]: '{not json' })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  test('JSON that is not an object (an array, a bare string, a number)', () => {
    for (const raw of ['[]', '"x"', '42', 'null']) {
      const dt = fakeDataTransfer({ [REPO_DRAG_MIME]: raw })
      expect(readRepoDrag(dt, 's1')).toBeNull()
    }
  })

  test('missing fields, one at a time', () => {
    const base = { sessionId: 's1', path: 'a.ts', kind: 'file' }
    for (const key of ['sessionId', 'path', 'kind']) {
      const broken = { ...base }
      delete (broken as Record<string, unknown>)[key]
      const dt = fakeDataTransfer({ [REPO_DRAG_MIME]: JSON.stringify(broken) })
      expect(readRepoDrag(dt, 's1')).toBeNull()
    }
  })

  test('an unrecognised kind is refused rather than passed through', () => {
    const dt = fakeDataTransfer({
      [REPO_DRAG_MIME]: JSON.stringify({ sessionId: 's1', path: 'a.ts', kind: 'symlink' }),
    })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  test('an empty path is refused', () => {
    const dt = fakeDataTransfer({
      [REPO_DRAG_MIME]: JSON.stringify({ sessionId: 's1', path: '', kind: 'file' }),
    })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  test('wrong-typed fields (a number where a string belongs) are refused, never coerced', () => {
    const dt = fakeDataTransfer({
      [REPO_DRAG_MIME]: JSON.stringify({ sessionId: 's1', path: 42, kind: 'file' }),
    })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  /**
   * A review minor (`session-w1c-tree-ops-review.md`): `path` used to pass through completely
   * unvalidated — `..`, an absolute path and a 1 MB string all round-tripped. Not itself a hole (the
   * server refuses escapes), but this reader is the ONE place every consumer of the MIME shares, and
   * it is meant to be trustworthy on its own rather than relying on every future caller to be careful.
   */
  test('a `..` segment anywhere in the path is refused', () => {
    for (const path of ['..', '../a.ts', 'src/../../etc/passwd', 'src/..', 'a/../b']) {
      const dt = fakeDataTransfer({ [REPO_DRAG_MIME]: JSON.stringify({ sessionId: 's1', path, kind: 'file' }) })
      expect(readRepoDrag(dt, 's1')).toBeNull()
    }
  })

  test('an absolute path is refused', () => {
    for (const path of ['/etc/passwd', '\\Windows\\System32']) {
      const dt = fakeDataTransfer({ [REPO_DRAG_MIME]: JSON.stringify({ sessionId: 's1', path, kind: 'file' }) })
      expect(readRepoDrag(dt, 's1')).toBeNull()
    }
  })

  test('a path far longer than any real repository path is refused', () => {
    const huge = `${'a/'.repeat(600_000)}x.ts` // well past 1 MB before this check existed
    const dt = fakeDataTransfer({ [REPO_DRAG_MIME]: JSON.stringify({ sessionId: 's1', path: huge, kind: 'file' }) })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })

  test('a `.` segment is refused too — this tree only ever joins listed names, never a normalised path', () => {
    const dt = fakeDataTransfer({
      [REPO_DRAG_MIME]: JSON.stringify({ sessionId: 's1', path: 'src/./a.ts', kind: 'file' }),
    })
    expect(readRepoDrag(dt, 's1')).toBeNull()
  })
})

describe('isSafeRelativePath', () => {
  test('ordinary relative paths, nested or not, are safe', () => {
    expect(isSafeRelativePath('a.ts')).toBe(true)
    expect(isSafeRelativePath('src/components/Foo.tsx')).toBe(true)
  })

  test('empty, absolute, traversal and overlong paths are all unsafe', () => {
    expect(isSafeRelativePath('')).toBe(false)
    expect(isSafeRelativePath('/a.ts')).toBe(false)
    expect(isSafeRelativePath('\\a.ts')).toBe(false)
    expect(isSafeRelativePath('../a.ts')).toBe(false)
    expect(isSafeRelativePath('a/./b')).toBe(false)
    expect(isSafeRelativePath('a'.repeat(MAX_DRAG_PATH_LENGTH + 1))).toBe(false)
  })

  test('exactly at the length ceiling is still safe; one past it is not', () => {
    expect(isSafeRelativePath('a'.repeat(MAX_DRAG_PATH_LENGTH))).toBe(true)
    expect(isSafeRelativePath('a'.repeat(MAX_DRAG_PATH_LENGTH + 1))).toBe(false)
  })

  test('a doubled separator is an empty segment, and is refused', () => {
    expect(isSafeRelativePath('src//a.ts')).toBe(false)
  })
})
