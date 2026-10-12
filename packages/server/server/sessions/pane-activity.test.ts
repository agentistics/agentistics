import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activityStamp, parseWchar, processTreeActivity } from './pane-activity'

const root = mkdtempSync(join(tmpdir(), 'pane-activity-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
function proc(pid: number, wchar: number, children: number[] = [], io = true) {
  mkdirSync(join(root, String(pid), 'task', String(pid)), { recursive: true })
  if (io) writeFileSync(join(root, String(pid), 'io'), `rchar: 1\nwchar: ${wchar}\nsyscr: 2\n`)
  writeFileSync(join(root, String(pid), 'task', String(pid), 'children'), children.join(' ') + (children.length ? ' ' : ''))
}

describe('pane-activity', () => {
  it('parses wchar and refuses a stamp with a member unread', () => {
    expect(parseWchar('rchar: 5\nwchar: 42\n')).toBe(42)
    expect(parseWchar('rchar: 5\n')).toBeNull()
    expect(activityStamp([{ pid: 1, wchar: 3 }, { pid: 2, wchar: 4 }])).toBe('1,2|7')
    expect(activityStamp([{ pid: 1, wchar: null }])).toBeNull()
    expect(activityStamp([])).toBeNull()
  })
  it('sums the whole tree, and a write anywhere in it moves the stamp', () => {
    proc(10, 100, [11]); proc(11, 5, [12]); proc(12, 1)
    const a = processTreeActivity(10, root)
    expect(a).toBe('10,11,12|106')
    proc(12, 2)
    expect(processTreeActivity(10, root)).not.toBe(a)
  })
  it('a child that exited is skipped; the root missing, or a member unreadable, is no stamp', () => {
    proc(20, 1, [21]) // 21 does not exist
    expect(processTreeActivity(20, root)).toBe('20|1')
    expect(processTreeActivity(99, root)).toBeNull()
    proc(30, 1, [31]); proc(31, 0, [], false) // 31's io already gone: it exited mid-walk
    expect(processTreeActivity(30, root)).toBe('30|1')
  })
})
