/**
 * projectDisks.ts — the pure half of Settings' disk picker (`ProjectDisksSection.tsx`).
 *
 * The server (`/api/project-disks`, `server/disk-picker.ts`) says which disks exist; the picked ones
 * are written into the existing `preferences.scanRoots`. Two rules mirror the server's:
 *  - the INSTALL disk is always on and is never written (home is always walked; persisting `/`
 *    would walk the whole root filesystem);
 *  - a root saved before this picker existed (typed into the old textarea) is never dropped by a
 *    save — it is shown as its own row and only leaves when somebody switches it off.
 */

export interface ProjectDisk {
  path: string
  kind: 'root' | 'drive' | 'volume'
  letter?: string
  label: string
  isInstallDisk: boolean
  freeBytes?: number
  totalBytes?: number
}

function samePath(a: string, b: string): boolean {
  return /^[a-z]:/i.test(a) ? a.toUpperCase() === b.toUpperCase() : a === b
}

/** "Disco D:" / "Disco principal" / the volume's own name. */
export function diskTitle(disk: ProjectDisk, pt: boolean): string {
  if (disk.kind === 'drive' && disk.letter) return `${pt ? 'Disco' : 'Drive'} ${disk.letter}:`
  if (disk.kind === 'root') return pt ? 'Disco principal' : 'Main disk'
  return disk.label
}

/** GB/TB, one decimal where it matters. A size the server could not read is the empty string —
 *  never `0 GB`, which would be a confident wrong measurement. */
export function formatDiskSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  const gb = bytes / 1024 ** 3
  if (gb < 1) return `${Math.round(bytes / 1024 ** 2)} MB`
  if (gb < 1024) return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
  return `${(gb / 1024).toFixed(1)} TB`
}

/** The small line under a disk: the install hint FIRST (the row truncates at 390px, and the hint is
 *  why the switch cannot move), then free of total. */
export function diskSub(disk: ProjectDisk, pt: boolean): string {
  const free = formatDiskSize(disk.freeBytes)
  const total = formatDiskSize(disk.totalBytes)
  const parts: string[] = []
  if (disk.isInstallDisk) parts.push(pt ? 'onde o agentistics está instalado' : 'where agentistics is installed')
  if (free && total) parts.push(pt ? `${free} livres de ${total}` : `${free} free of ${total}`)
  return parts.join(' · ')
}

/** Saved roots that are not one of the discovered disks — the old textarea's folders. */
export function legacyRoots(saved: string[], disks: ProjectDisk[]): string[] {
  return saved.filter(root => !disks.some(d => samePath(d.path, root)))
}

export function isRootOn(roots: string[], path: string): boolean {
  return roots.some(r => samePath(r, path))
}

/** The `scanRoots` after one switch flips. Never contains the install disk. */
export function toggleRoot(roots: string[], path: string, on: boolean, disks: ProjectDisk[]): string[] {
  const next = on
    ? (isRootOn(roots, path) ? roots : [...roots, path])
    : roots.filter(r => !samePath(r, path))
  return next.filter(r => r.trim() && !disks.some(d => d.isInstallDisk && samePath(d.path, r)))
}

/** Keep the explicit all-disks tab; it is not a missing disk id. */
export function projectDiskAfterResponse(current: string, disks: Pick<ProjectDisk, 'path' | 'isInstallDisk'>[]): string {
  if (current === 'all') return 'all'
  if (current && disks.some(d => d.path === current)) return current
  return disks.find(d => d.isInstallDisk)?.path ?? disks[0]?.path ?? current
}
