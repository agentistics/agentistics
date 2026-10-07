/**
 * disk-picker.ts — which disks this machine has, so Settings can offer them as ticks instead of a
 * textarea nobody non-technical can fill in.
 *
 * The picked paths are written into the EXISTING `preferences.scanRoots`, which
 * `sessions/project-source.ts` already walks — this module only answers "what could be picked".
 *
 * The INSTALL disk (the one holding the home directory) is always listed and always locked on, and
 * is deliberately NEVER written into `scanRoots`: `project-source.ts` walks `homedir()`
 * unconditionally, and persisting `/` would turn that into a walk of the whole root filesystem
 * (`/proc`, `/usr`, …).
 *
 * Parsers are pure and take fixture text; the IO half is `discoverProjectDisks`, cached a few
 * seconds and bounded per `statfs` so a sleeping network mount cannot hold the settings screen.
 */

import { readFile, readdir, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'

export type DiskKind = 'root' | 'drive' | 'volume'

export interface ProjectDisk {
  /** The path written into `scanRoots` when ticked. */
  path: string
  kind: DiskKind
  /** The Windows drive letter (`D`) for a `drive` — the UI composes "Disco D:" / "Drive D:". */
  letter?: string
  /** A language-neutral name: the volume's folder name, or the path for a root/drive. */
  label: string
  /** Holds the home directory — always on, never removable, never persisted. */
  isInstallDisk: boolean
  freeBytes?: number
  totalBytes?: number
}

export interface Mount { source: string; path: string; fsType: string }

/** Filesystems that live on a real disk (or, `9p`, WSL's view of a Windows drive). Everything
 *  else — proc, sysfs, tmpfs, overlay, squashfs (snap), cgroup, fuse helpers — is not a place
 *  anybody keeps projects. */
const DISK_FILESYSTEMS = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'ntfs', 'ntfs3', 'fuseblk', 'vfat', 'exfat', 'hfs', 'hfsplus', 'apfs', '9p', 'drvfs',
])

/** Where removable and extra disks are mounted. `/boot`, `/boot/efi`, `/var/...` are excluded on
 *  purpose: they are real block devices and no one's project folder. */
function isUserMountPoint(path: string): boolean {
  return path === '/' || path === '/home'
    || path.startsWith('/mnt/') || path.startsWith('/media/') || path.startsWith('/run/media/')
}

function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/** `/proc/mounts` → the mounts worth offering. */
export function parseProcMounts(text: string): Mount[] {
  return text.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3) return []
    const [source, mountPath, fsType] = fields as [string, string, string]
    if (!DISK_FILESYSTEMS.has(fsType.toLowerCase())) return []
    const path = unescapeMountField(mountPath)
    if (!isUserMountPoint(path)) return []
    return [{ source: unescapeMountField(source), path, fsType }]
  })
}

/** WSL: the Windows drives, as `/mnt/<letter>`. `/mnt/wsl`, `/mnt/wslg` are not drives. */
export function parseWslDrives(text: string): string[] {
  const drives = new Set<string>()
  for (const mount of parseProcMounts(text)) {
    const match = /^\/mnt\/([a-z])$/i.exec(mount.path)
    if (match) drives.add(`/mnt/${match[1]!.toLowerCase()}`)
  }
  return [...drives].sort()
}

/** Windows: the drive roots that answered a `statfs` with a non-zero size, deduped. */
export function parseWindowsDrives(text: string): string[] {
  const letters = text.split(/\r?\n/).map(line => line.trim().match(/^([a-z]):[\\/]*$/i)?.[1]?.toUpperCase())
  return [...new Set(letters)]
    .filter((letter): letter is string => Boolean(letter))
    .sort()
    .map(letter => `${letter}:\\`)
}

/**
 * macOS: `/Volumes/*` minus the system volumes. The boot volume appears there as a SYMLINK to `/`
 * ("Macintosh HD") — it is the install disk, already listed as `/`, so a symlink is never a second
 * row.
 */
export function parseMacVolumes(entries: { name: string; symlink: boolean }[]): string[] {
  const system = /^(system|recovery|preboot|update|vm|data|xarts|iscpreboot|hardware)$/i
  return entries
    .filter(e => e.name && !e.symlink && !e.name.startsWith('.') && !e.name.startsWith('com.apple.') && !system.test(e.name))
    .map(e => `/Volumes/${e.name}`)
    .sort()
}

/** The mount that holds `path` — the longest mount point that is a prefix of it. */
export function mountContaining(path: string, mountPoints: string[]): string {
  let best = '/'
  for (const mp of mountPoints) {
    const inside = mp === '/' || path === mp || path.startsWith(mp.endsWith('/') ? mp : `${mp}/`)
    if (inside && mp.length > best.length) best = mp
  }
  return best
}

function sameDisk(a: string, b: string): boolean {
  return /^[a-z]:/i.test(a) ? a.toUpperCase() === b.toUpperCase() : a === b
}

export function describeDisk(path: string, isInstallDisk: boolean): ProjectDisk {
  const letter = /^\/mnt\/([a-z])$/i.exec(path)?.[1] ?? /^([a-z]):[\\/]?$/i.exec(path)?.[1]
  if (letter) return { path, kind: 'drive', letter: letter.toUpperCase(), label: `${letter.toUpperCase()}:`, isInstallDisk }
  if (path === '/') return { path, kind: 'root', label: '/', isInstallDisk }
  return { path, kind: 'volume', label: path.split('/').filter(Boolean).pop() ?? path, isInstallDisk }
}

/**
 * The list Settings draws: deduped, the install disk FIRST and locked, present even when discovery
 * found nothing (an empty or unreadable `/proc/mounts` must still leave the screen something true
 * to say).
 */
export function buildDiskList(paths: string[], installPath: string): ProjectDisk[] {
  const unique: string[] = []
  for (const p of paths) if (!unique.some(u => sameDisk(u, p))) unique.push(p)
  const rest = unique.filter(p => !sameDisk(p, installPath))
  return [describeDisk(installPath, true), ...rest.map(p => describeDisk(p, false))]
}

/**
 * The `scanRoots` a save should write: the ticked disks, plus every previously saved root that is
 * still ticked, and NEVER the install disk (see the header). Order is kept, duplicates dropped.
 */
export function scanRootsToSave(ticked: string[], disks: Pick<ProjectDisk, 'path' | 'isInstallDisk'>[]): string[] {
  const out: string[] = []
  for (const raw of ticked) {
    const root = raw.trim()
    if (!root) continue
    if (disks.some(d => d.isInstallDisk && sameDisk(d.path, root))) continue
    if (!out.some(o => sameDisk(o, root))) out.push(root)
  }
  return out
}

// ── IO ────────────────────────────────────────────────────────────────────────────────────────

const CACHE_MS = 5_000
const STATFS_BUDGET_MS = 150
let cached: { at: number; disks: ProjectDisk[] } | null = null

function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>(r => setTimeout(() => r(null), ms))])
}

async function sizes(path: string): Promise<Pick<ProjectDisk, 'freeBytes' | 'totalBytes'>> {
  const info = await withBudget(statfs(path), STATFS_BUDGET_MS)
  if (!info || Number(info.blocks) <= 0) return {}
  return { freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) }
}

async function linuxDisks(): Promise<{ paths: string[]; install: string }> {
  const text = await readFile('/proc/mounts', 'utf8').catch(() => '')
  const isWsl = /microsoft/i.test(await readFile('/proc/sys/kernel/osrelease', 'utf8').catch(() => ''))
  if (isWsl) return { paths: parseWslDrives(text), install: '/' }
  const mounts = [...new Set(parseProcMounts(text).map(m => m.path))]
  return { paths: mounts, install: mountContaining(homedir(), mounts) }
}

async function windowsDisks(): Promise<{ paths: string[]; install: string }> {
  // A: and B: are floppy letters; probing them can stall on old hardware.
  const probes = await Promise.all(Array.from({ length: 24 }, (_, i) => `${String.fromCharCode(67 + i)}:\\`)
    .map(async path => {
      const info = await withBudget(statfs(path), STATFS_BUDGET_MS)
      return info && Number(info.blocks) > 0 ? path : null // empty card reader / optical: no size
    }))
  const install = `${(/^[a-z]:/i.exec(homedir())?.[0] ?? 'C:').toUpperCase()}\\`
  return { paths: parseWindowsDrives(probes.filter(Boolean).join('\n')), install }
}

async function macDisks(): Promise<{ paths: string[]; install: string }> {
  const entries = await readdir('/Volumes', { withFileTypes: true }).catch(() => [])
  return {
    paths: parseMacVolumes(entries.map(e => ({ name: e.name, symlink: e.isSymbolicLink() }))),
    install: '/',
  }
}

export function resetDiskCacheForTests(): void {
  cached = null
}

export async function discoverProjectDisks(): Promise<ProjectDisk[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.disks
  const found = process.platform === 'win32' ? await windowsDisks()
    : process.platform === 'darwin' ? await macDisks()
    : await linuxDisks()
  const disks = await Promise.all(buildDiskList(found.paths, found.install)
    .map(async d => ({ ...d, ...(await sizes(d.path)) })))
  cached = { at: Date.now(), disks }
  return disks
}
