/**
 * folderBrowser.ts — PURE: the breadcrumb of the "Procurar pasta…" browser, and its fetch.
 *
 * The server (`GET /api/fs/folders`) answers one level of DIRECTORIES at a time and is the only
 * authority on what may be browsed; this module only decides how a path READS as a trail
 * (disks → folder → subfolder) so the component holds no path arithmetic.
 */
export interface FolderEntry { name: string; path: string; hasChildren: boolean }
export interface FolderListing { path: string; parent: string | null; folders: FolderEntry[]; partial: boolean }
export interface DiskInfo { id: string; label: string; letter?: string; install: boolean }

/** The disk filter's own wording — the ONE place it is composed, so the browser and the filter agree. */
export function diskLabel(d: DiskInfo, pt: boolean): string {
  return d.install ? (pt ? 'Este disco' : 'This disk') : `${pt ? 'Disco' : 'Drive'} ${d.letter ?? d.label}:`
}

/** The browser follows the picker's disk filter; the install disk starts at the home listing. */
export function startFolderPath(startDisk: { path: string; install: boolean } | null | undefined, home?: string): string {
  return startDisk && !startDisk.install ? startDisk.path : (home ?? '')
}

/**
 * What each browsable root is called: an enabled disk by the filter's label, and the home (the first
 * root, which is not a disk's path) by the install disk's label. A root no disk names keeps `undefined`.
 */
export function rootLabels(roots: readonly string[], disks: readonly DiskInfo[], pt: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  const install = disks.find(d => d.install)
  roots.forEach((r, i) => {
    const d = disks.find(x => norm(x.id).toLowerCase() === norm(r).toLowerCase())
    if (d) out[r] = diskLabel(d, pt)
    else if (i === 0 && install) out[r] = diskLabel(install, pt)
    else {
      // A root no discovered disk names (a hand-saved scan root): read a drive letter off the path, or
      // fall back to the folder's own name — never the raw path.
      const letter = /^\/mnt\/([a-z])$/i.exec(norm(r))?.[1] ?? /^([a-z]):$/i.exec(norm(r))?.[1]
      out[r] = letter ? diskLabel({ id: r, label: `${letter.toUpperCase()}:`, letter: letter.toUpperCase(), install: false }, pt)
        : norm(r).split('/').filter(Boolean).pop() ?? r
    }
  })
  return out
}

export interface Crumb { label: string; path: string }

const sep = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/')
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * The trail for `path` under the browsable `roots`. The first crumb is always the top (`path: ''`,
 * the disk list); then the root that contains the path, then one crumb per segment below it.
 */
export function breadcrumbs(path: string, roots: readonly string[], topLabel: string, labels: Record<string, string> = {}): Crumb[] {
  const out: Crumb[] = [{ label: topLabel, path: '' }]
  if (!path) return out
  const p = norm(path)
  const root = [...roots].sort((a, b) => norm(b).length - norm(a).length)
    .find(r => { const n = norm(r); return p.toLowerCase() === n.toLowerCase() || p.toLowerCase().startsWith(`${n.toLowerCase()}/`) })
  if (!root) return [...out, { label: p.split('/').pop() || p, path }]
  const base = norm(root)
  out.push({ label: labels[root] ?? (base.split('/').filter(Boolean).pop() || base || '/'), path: root })
  let acc = root
  const s = sep(path)
  for (const seg of p.slice(base.length).split('/').filter(Boolean)) {
    acc = `${acc.replace(/[\\/]+$/, "")}${s}${seg}`
    out.push({ label: seg, path: acc })
  }
  return out
}

export async function fetchFolders(path: string, signal?: AbortSignal): Promise<FolderListing> {
  const res = await fetch(`/api/fs/folders?path=${encodeURIComponent(path)}`, { signal })
  if (!res.ok) throw new Error(res.status === 403 ? 'forbidden' : res.status === 404 ? 'not-found' : 'failed')
  return res.json() as Promise<FolderListing>
}

/**
 * A path short enough for one row: the first segment, an ellipsis, the last two. A path of three
 * segments or fewer is returned as written — shortening it would only hide what it says.
 */
export function shortPath(path: string): string {
  const s = sep(path)
  const parts = norm(path).split('/').filter(Boolean)
  const lead = /^[a-z]:$/i.test(parts[0] ?? '') || !norm(path).startsWith('/') ? '' : s
  if (parts.length <= 3) return `${lead}${parts.join(s)}`
  return `${lead}${parts[0]}${s}…${s}${parts.slice(-2).join(s)}`
}
