import { describe, expect, test } from 'bun:test'
import {
  buildDiskList, mountContaining, parseMacVolumes, parseProcMounts, parseWindowsDrives,
  parseWslDrives, scanRootsToSave,
} from './disk-picker'

const WSL_MOUNTS = [
  'none /mnt/wsl tmpfs rw,relatime 0 0',
  '/dev/sdc / ext4 rw,relatime,discard 0 0',
  'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\ 0 0',
  'D:\\134 /mnt/d 9p rw,noatime,aname=drvfs;path=D:\\ 0 0',
  'drivers /usr/lib/wsl/drivers 9p ro 0 0',
  'none /mnt/wslg tmpfs rw 0 0',
  'proc /proc proc rw 0 0',
  'sysfs /sys sysfs rw 0 0',
  'cgroup2 /sys/fs/cgroup cgroup2 rw 0 0',
  'tmpfs /tmp tmpfs rw 0 0',
].join('\n')

const LINUX_MOUNTS = [
  '/dev/nvme0n1p2 / ext4 rw 0 0',
  '/dev/nvme0n1p1 /boot/efi vfat rw 0 0',
  '/dev/nvme0n1p3 /home btrfs rw 0 0',
  '/dev/sdb1 /media/ana/USB\\040Drive exfat rw 0 0',
  '/dev/sdc1 /run/media/ana/Backup xfs rw 0 0',
  'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
  '/dev/loop3 /snap/core22/1380 squashfs ro 0 0',
  'tmpfs /run tmpfs rw 0 0',
].join('\n')

describe('parsers', () => {
  test('WSL: Windows drives only, never /mnt/wsl or pseudo filesystems', () => {
    expect(parseWslDrives(WSL_MOUNTS)).toEqual(['/mnt/c', '/mnt/d'])
  })

  test('Linux: real disks under / /home /mnt /media /run/media; boot, overlay, snap, tmpfs filtered', () => {
    expect(parseProcMounts(LINUX_MOUNTS).map(m => m.path))
      .toEqual(['/', '/home', '/media/ana/USB Drive', '/run/media/ana/Backup'])
  })

  test('macOS: system volumes and the boot-volume symlink are dropped', () => {
    expect(parseMacVolumes([
      { name: 'Macintosh HD', symlink: true },
      { name: 'Recovery', symlink: false },
      { name: 'Preboot', symlink: false },
      { name: '.timemachine', symlink: false },
      { name: 'com.apple.TimeMachine.localsnapshots', symlink: false },
      { name: 'Projetos', symlink: false },
      { name: 'Externo', symlink: false },
    ])).toEqual(['/Volumes/Externo', '/Volumes/Projetos'])
  })

  test('Windows: drive letters deduped and sorted', () => {
    expect(parseWindowsDrives('D:\\\nC:\\\nC:\\\n\n')).toEqual(['C:\\', 'D:\\'])
  })

  test('the install disk is the mount holding home', () => {
    expect(mountContaining('/home/ana', ['/', '/home', '/media/ana/USB Drive'])).toBe('/home')
    expect(mountContaining('/home/ana', ['/', '/mnt/d'])).toBe('/')
    expect(mountContaining('/homework', ['/', '/home'])).toBe('/')
  })
})

describe('buildDiskList — the install disk', () => {
  test('is always first and locked, even when discovery found nothing', () => {
    expect(buildDiskList([], '/')).toEqual([{ path: '/', kind: 'root', label: '/', isInstallDisk: true }])
  })

  test('WSL: Linux root locked, C: and D: offered as drives', () => {
    const list = buildDiskList(parseWslDrives(WSL_MOUNTS), '/')
    expect(list.map(d => [d.path, d.isInstallDisk, d.letter])).toEqual([
      ['/', true, undefined], ['/mnt/c', false, 'C'], ['/mnt/d', false, 'D'],
    ])
  })

  test('Windows: the home drive is locked and not repeated', () => {
    const list = buildDiskList(['C:\\', 'D:\\'], 'c:\\')
    expect(list.map(d => [d.path, d.isInstallDisk])).toEqual([['c:\\', true], ['D:\\', false]])
  })

  test('a volume is labelled by its folder name', () => {
    expect(buildDiskList(['/media/ana/USB Drive'], '/')[1]).toMatchObject({ kind: 'volume', label: 'USB Drive' })
  })
})

describe('scanRootsToSave', () => {
  const disks = buildDiskList(['/mnt/c', '/mnt/d'], '/')

  test('never persists the install disk (home is always walked)', () => {
    expect(scanRootsToSave(['/', '/mnt/d'], disks)).toEqual(['/mnt/d'])
  })

  test('keeps previously typed custom roots that are not disks', () => {
    expect(scanRootsToSave(['/srv/code', '/mnt/d', ' /srv/code ', ''], disks)).toEqual(['/srv/code', '/mnt/d'])
  })
})
