import { useEffect, useState } from 'react'
import { FolderOpen, HardDrive } from 'lucide-react'
import { SectionHeader, RowSwitch } from './primitives'
import {
  diskSub, diskTitle, isRootOn, legacyRoots, toggleRoot, type ProjectDisk,
} from '../../lib/projectDisks'

/**
 * Settings → Preferences: which disks agentistics searches for projects. The user TICKS disks the
 * server discovered — nobody types a path. Each switch saves at once into `preferences.scanRoots`
 * (the same preference the project search already reads), and a failed save puts the switch back.
 */
export default function ProjectDisksSection({ pt }: { pt: boolean }) {
  const [disks, setDisks] = useState<ProjectDisk[] | null>(null)
  const [roots, setRoots] = useState<string[]>([])
  // Roots saved before this picker existed, captured once so switching one OFF keeps its row
  // (and lets it be switched back on) instead of making it vanish mid-edit.
  const [extras, setExtras] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([
      fetch('/api/preferences').then(r => r.ok ? r.json() as Promise<{ scanRoots?: unknown }> : null).catch(() => null),
      fetch('/api/project-disks').then(r => r.ok ? r.json() as Promise<{ disks?: ProjectDisk[] }> : null).catch(() => null),
    ]).then(([p, d]) => {
      if (!alive) return
      const saved = Array.isArray(p?.scanRoots) ? p.scanRoots.filter((x): x is string => typeof x === 'string') : []
      const found = Array.isArray(d?.disks) ? d.disks : []
      setRoots(saved)
      setDisks(found)
      setExtras(legacyRoots(saved, found))
      if (!d) setMessage(pt ? 'Não foi possível listar os discos agora.' : 'Could not list the disks right now.')
    })
    return () => { alive = false }
  // pt only changes the wording of a message; re-fetching on a language flip would be noise.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function flip(path: string) {
    if (!disks || saving) return
    const before = roots
    const next = toggleRoot(roots, path, !isRootOn(roots, path), disks)
    setRoots(next)
    setSaving(true)
    setMessage('')
    try {
      const res = await fetch('/api/preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanRoots: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setMessage(pt ? 'Salvo.' : 'Saved.')
    } catch {
      setRoots(before)
      setMessage(pt ? 'Não foi possível salvar. Tente de novo.' : 'Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const onlyInstall = disks !== null && disks.length <= 1 && extras.length === 0

  return (
    <>
      <SectionHeader label={pt ? 'Onde procurar projetos' : 'Where to look for projects'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 6px' }}>
        {pt
          ? 'Escolha em quais discos o agentistics procura seus projetos.'
          : 'Choose which disks agentistics searches for your projects.'}
      </p>
      {disks === null ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '8px 0 12px' }}>
          {pt ? 'Procurando discos…' : 'Looking for disks…'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {disks.map(disk => (
            <RowSwitch
              key={disk.path}
              icon={<HardDrive size={16} />}
              label={diskTitle(disk, pt)}
              sub={diskSub(disk, pt) || undefined}
              on={disk.isInstallDisk || isRootOn(roots, disk.path)}
              disabled={disk.isInstallDisk || saving}
              onToggle={() => { void flip(disk.path) }}
            />
          ))}
          {extras.map(root => (
            <RowSwitch
              key={root}
              icon={<FolderOpen size={16} />}
              label={root}
              sub={pt ? 'pasta adicionada antes' : 'folder added earlier'}
              on={isRootOn(roots, root)}
              disabled={saving}
              onToggle={() => { void flip(root) }}
            />
          ))}
        </div>
      )}
      {(onlyInstall || message) && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '6px 0 14px' }} role="status">
          {message || (pt
            ? 'Só encontramos este disco, e ele já está incluído.'
            : 'This is the only disk we found, and it is already included.')}
        </div>
      )}
    </>
  )
}
