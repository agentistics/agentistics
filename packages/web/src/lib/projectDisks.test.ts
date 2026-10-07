import { describe, expect, test } from 'bun:test'
import { diskSub, diskTitle, formatDiskSize, legacyRoots, toggleRoot, type ProjectDisk } from './projectDisks'

const ROOT: ProjectDisk = { path: '/', kind: 'root', label: '/', isInstallDisk: true, freeBytes: 200 * 1024 ** 3, totalBytes: 1024 ** 4 }
const C: ProjectDisk = { path: '/mnt/c', kind: 'drive', letter: 'C', label: 'C:', isInstallDisk: false }
const USB: ProjectDisk = { path: '/media/ana/USB', kind: 'volume', label: 'USB', isInstallDisk: false }
const DISKS = [ROOT, C, USB]

describe('labels', () => {
  test('drives, the main disk and volumes read naturally in both languages', () => {
    expect(diskTitle(C, true)).toBe('Disco C:')
    expect(diskTitle(C, false)).toBe('Drive C:')
    expect(diskTitle(ROOT, true)).toBe('Disco principal')
    expect(diskTitle(USB, true)).toBe('USB')
  })

  test('size line, with the install hint, and nothing invented when sizes are unknown', () => {
    expect(diskSub(ROOT, true)).toBe('onde o agentistics está instalado · 200 GB livres de 1.0 TB')
    expect(diskSub(C, false)).toBe('')
    expect(formatDiskSize(undefined)).toBe('')
    expect(formatDiskSize(5.5 * 1024 ** 3)).toBe('5.5 GB')
  })
})

describe('scanRoots', () => {
  test('old typed roots that are not disks survive as their own rows', () => {
    expect(legacyRoots(['/srv/code', '/mnt/c'], DISKS)).toEqual(['/srv/code'])
  })

  test('toggling adds/removes one disk and never persists the install disk', () => {
    expect(toggleRoot(['/srv/code'], '/mnt/c', true, DISKS)).toEqual(['/srv/code', '/mnt/c'])
    expect(toggleRoot(['/srv/code', '/mnt/c'], '/mnt/c', false, DISKS)).toEqual(['/srv/code'])
    expect(toggleRoot(['/', '/srv/code'], '/media/ana/USB', true, DISKS)).toEqual(['/srv/code', '/media/ana/USB'])
  })

  test('drive letters compare case-insensitively', () => {
    const d: ProjectDisk = { path: 'D:\\', kind: 'drive', letter: 'D', label: 'D:', isInstallDisk: false }
    expect(toggleRoot(['d:\\'], 'D:\\', false, [d])).toEqual([])
  })
})
