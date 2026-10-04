/**
 * NativeExtraDirs — H20 (`/add-dir`) in the native chat: the folders outside the workspace this
 * session may read (writes and commands there ask), and a field to add one. The path is resolved and
 * judged by the engine (`~`, relative to the session's cwd; the floor, `/` and the home refuse it);
 * its sentence is shown on a refusal. Disabled while a run is in flight.
 */
import { useState } from 'react'
import { FolderPlus } from 'lucide-react'

export function NativeExtraDirs({ dirs, running, lang, onAdd }: {
  dirs: readonly string[]
  running: boolean
  lang: 'pt' | 'en'
  onAdd: (path: string) => Promise<string | null>
}) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (path.trim() === '') return
    const e = await onAdd(path.trim())
    setError(e)
    if (e === null) { setPath(''); setOpen(false) }
  }
  return (
    <div data-testid="native-extra-dirs" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0 }}>
      {dirs.map(d => (
        <span key={d} title={pt ? 'Leitura liberada; escritas e comandos ali perguntam.' : 'Readable; writes and commands there ask.'}
          style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '1px 6px', overflowWrap: 'anywhere', maxWidth: '100%' }}>{d}</span>
      ))}
      {!open && (
        <button type="button" disabled={running} onClick={() => setOpen(true)}
          aria-label={pt ? 'Adicionar uma pasta fora do workspace' : 'Add a folder outside the workspace'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'inherit', cursor: running ? 'default' : 'pointer', padding: 0, fontSize: 11.5 }}>
          <FolderPlus size={12} /> {pt ? 'pasta' : 'folder'}
        </button>
      )}
      {open && (
        <form onSubmit={e => { e.preventDefault(); void submit() }} style={{ display: 'inline-flex', gap: 4, minWidth: 0, flex: '1 1 200px' }}>
          <input autoFocus value={path} onChange={e => setPath(e.target.value)} placeholder={pt ? '~/outro-repo' : '~/other-repo'}
            aria-label={pt ? 'Caminho da pasta' : 'Folder path'}
            style={{ flex: 1, minWidth: 0, fontSize: 11.5, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px' }} />
          <button type="submit" disabled={running || path.trim() === ''} style={{ fontSize: 11.5 }}>{pt ? 'Adicionar' : 'Add'}</button>
          <button type="button" onClick={() => { setOpen(false); setError(null) }} style={{ fontSize: 11.5 }}>{pt ? 'Cancelar' : 'Cancel'}</button>
        </form>
      )}
      {error && <span role="alert" style={{ color: 'var(--accent-red)', overflowWrap: 'anywhere' }}>{error}</span>}
    </div>
  )
}
