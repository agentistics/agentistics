import { describe, expect, test } from 'bun:test'
import { breadcrumbs, diskLabel, rootLabels, shortPath } from './folderBrowser'

describe('breadcrumbs', () => {
  test('top only for the disk list', () => {
    expect(breadcrumbs('', ['/home/a'], 'Discos')).toEqual([{ label: 'Discos', path: '' }])
  })
  test('root then one crumb per segment', () => {
    expect(breadcrumbs('/home/a/x/y', ['/home/a'], 'Discos').map(c => c.label)).toEqual(['Discos', 'a', 'x', 'y'])
    expect(breadcrumbs('/home/a/x/y', ['/home/a'], 'Discos')[3]!.path).toBe('/home/a/x/y')
  })
  test('prefers the longest root', () => {
    expect(breadcrumbs('/mnt/d/p', ['/', '/mnt/d'], 'D').map(c => c.label)).toEqual(['D', 'd', 'p'])
  })
  test('windows paths keep their separator', () => {
    expect(breadcrumbs('D:\\work\\app', ['D:\\'], 'Discos').map(c => c.path)).toEqual(['', 'D:\\', 'D:\\work', 'D:\\work\\app'])
  })
})

describe('shortPath', () => {
  test('short paths are kept', () => {
    expect(shortPath('/home/a/x')).toBe('/home/a/x')
  })
  test('long paths keep the first segment and the last two', () => {
    expect(shortPath('/home/a/work/clientes/acme')).toBe('/home/…/clientes/acme')
  })
  test('windows paths keep their separator', () => {
    expect(shortPath('D:\\work\\clientes\\acme\\app')).toBe('D:\\…\\acme\\app')
  })
})

describe('disk names', () => {
  const disks = [
    { id: '/', label: '/', install: true },
    { id: '/mnt/c', label: 'C:', letter: 'C', install: false },
    { id: '/mnt/d', label: 'D:', letter: 'D', install: false },
  ]
  test('the filter wording', () => {
    expect(diskLabel(disks[0]!, true)).toBe('Este disco')
    expect(diskLabel(disks[1]!, true)).toBe('Disco C:')
    expect(diskLabel(disks[2]!, false)).toBe('Drive D:')
  })
  test('home takes the install label, enabled disks their own', () => {
    expect(rootLabels(['/home/a', '/mnt/c', '/mnt/d'], disks, true)).toEqual({
      '/home/a': 'Este disco', '/mnt/c': 'Disco C:', '/mnt/d': 'Disco D:',
    })
  })
  test('an undiscovered root reads a drive letter, else its folder name', () => {
    const l = rootLabels(['/home/a', '/mnt/e', 'F:\\', '/data/backup'], disks, true)
    expect(l['/mnt/e']).toBe('Disco E:'); expect(l['F:\\']).toBe('Disco F:'); expect(l['/data/backup']).toBe('backup')
  })
  test('the breadcrumb root uses the label', () => {
    const labels = rootLabels(['/home/a', '/mnt/d'], disks, true)
    expect(breadcrumbs('/mnt/d/work', ['/home/a', '/mnt/d'], 'Discos', labels).map(c => c.label)).toEqual(['Discos', 'Disco D:', 'work'])
    expect(breadcrumbs('/home/a/x', ['/home/a', '/mnt/d'], 'Discos', labels).map(c => c.label)).toEqual(['Discos', 'Este disco', 'x'])
  })
})
