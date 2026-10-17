/**
 * NewProjectForm — "Novo projeto": a name, a place (with a sensible default), and a confirmation.
 * Opened from the "Criar projeto novo" row of the wizard's "Onde" step (t-eab4751cb3).
 *
 * A non-technical person never types a path: the place is a row with "Trocar", which opens the same
 * `FolderBrowser` the picker already uses. The name is checked as it is typed (`checkProjectName`,
 * the rule the server re-applies), the full path that WILL exist is shown before anything happens,
 * and nothing is created until the `ConfirmModal` is accepted. A folder that already exists is not a
 * dead end: the error offers to use it.
 */
import { useMemo, useState } from 'react'
import { Folder, FolderPlus, Loader } from 'lucide-react'
import { checkProjectName, joinProjectPath, projectNameMessage, type ProjectNameRefusal } from '@agentistics/core'
import { Field, inputStyle } from './formBits'
import { FolderBrowser } from './FolderBrowser'
import { shortPath, type DiskInfo } from '../../lib/folderBrowser'
import { createProjectFolder, type CreateFolderRefusal } from '../../lib/newProjectApi'
import { ConfirmModal, dialogButtonStyle } from '../../pages/settings/primitives'

export interface NewProjectFormProps {
  lang: 'pt' | 'en'
  isMobile: boolean
  initialName?: string
  /** `defaultProjectParent`'s answer; `exists: false` means it is created together with the project. */
  defaultParent: { path: string; exists: boolean }
  disks?: readonly DiskInfo[]
  onCreated: (path: string) => void
  /** Back to the search. */
  onCancel: () => void
}

export function NewProjectForm({ lang, isMobile, initialName = '', defaultParent, disks, onCreated, onCancel }: NewProjectFormProps) {
  const pt = lang === 'pt'
  const [name, setName] = useState(initialName)
  const [touched, setTouched] = useState(initialName !== '')
  const [parent, setParent] = useState(defaultParent)
  const [browsing, setBrowsing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<{ reason: CreateFolderRefusal; path?: string } | null>(null)

  const check = useMemo(() => checkProjectName(name), [name])
  const local: ProjectNameRefusal | null = check.ok ? null : check.reason
  const shownError = serverError?.reason ?? (touched && local && local !== 'empty' ? local : null)
  const target = check.ok ? joinProjectPath(parent.path, check.name) : null

  async function create() {
    if (!check.ok) return
    setConfirming(false); setBusy(true); setServerError(null)
    const out = await createProjectFolder(parent.path, check.name, !parent.exists)
    setBusy(false)
    if (out.ok) onCreated(out.path)
    else setServerError({ reason: out.reason, ...(out.path ? { path: out.path } : {}) })
  }

  if (browsing) {
    return (
      <div>
        <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {pt ? 'Escolha a pasta onde o projeto vai ficar.' : 'Choose the folder the project goes in.'}
        </p>
        <FolderBrowser
          lang={lang}
          isMobile={isMobile}
          disks={disks}
          useLabel={pt ? 'Criar aqui' : 'Create here'}
          onUse={p => { setParent({ path: p, exists: true }); setBrowsing(false); setServerError(null) }}
          onCancel={() => setBrowsing(false)}
        />
      </div>
    )
  }

  const btn = dialogButtonStyle('primary', isMobile, !check.ok || busy)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label={pt ? 'Nome' : 'Name'}>
        <input
          autoFocus={!isMobile}
          value={name}
          onChange={e => { setName(e.target.value); setTouched(true); setServerError(null) }}
          onKeyDown={e => { if (e.key === 'Enter' && check.ok) { e.preventDefault(); setConfirming(true) } }}
          placeholder={pt ? 'ex.: meu-projeto' : 'e.g. my-project'}
          aria-invalid={shownError ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          style={{ ...inputStyle, paddingLeft: 12, ...(shownError ? { borderColor: 'var(--accent-red)' } : {}) }}
        />
        {shownError && (
          <span role="alert" style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--accent-red)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {projectNameMessage(shownError, pt)}
            {serverError?.reason === 'exists' && serverError.path && (
              <button type="button" onClick={() => onCreated(serverError.path!)} style={{
                border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 11.5, fontWeight: 650, color: 'var(--anthropic-orange)', textDecoration: 'underline',
              }}>{pt ? 'Usar a pasta que já existe' : 'Use the existing folder'}</button>
            )}
          </span>
        )}
      </Field>

      <Field label={pt ? 'Pasta' : 'Folder'}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 9, minWidth: 0,
          border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
        }}>
          <Folder size={15} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <span title={parent.path} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
              {shortPath(parent.path)}
            </span>
            {!parent.exists && (
              <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                {pt ? 'Esta pasta ainda não existe — será criada junto.' : 'This folder does not exist yet — it is created too.'}
              </span>
            )}
          </span>
          <button type="button" onClick={() => setBrowsing(true)} style={{
            border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
            fontSize: 12, fontWeight: 650, color: 'var(--anthropic-orange)', minHeight: isMobile ? 44 : 28, padding: '0 6px',
          }}>{pt ? 'Trocar' : 'Change'}</button>
        </div>
      </Field>

      <div style={{
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', gap: 10,
        flexDirection: isMobile ? 'column-reverse' : 'row', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {target ? <>{pt ? 'Vai criar: ' : 'Will create: '}<span style={{ color: 'var(--text-secondary)' }}>{shortPath(target)}</span></> : ' '}
        </span>
        <span style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column-reverse' : 'row' }}>
          <button type="button" onClick={onCancel} style={dialogButtonStyle('secondary', isMobile)}>{pt ? 'Voltar à busca' : 'Back to search'}</button>
          <button type="button" disabled={!check.ok || busy} onClick={() => setConfirming(true)} style={btn}>
            {busy ? <Loader size={13} className="ag-working-spin" /> : <FolderPlus size={13} />}
            {pt ? 'Criar projeto' : 'Create project'}
          </button>
        </span>
      </div>

      <ConfirmModal
        open={confirming}
        tone="default"
        icon={<FolderPlus size={17} />}
        title={pt ? `Criar o projeto “${check.ok ? check.name : ''}”?` : `Create the project “${check.ok ? check.name : ''}”?`}
        message={pt
          ? `Vou criar a pasta ${target ? shortPath(target) : ''}${parent.exists ? '' : ' (e a pasta onde ela fica)'} e abrir a sessão dentro dela.`
          : `I will create the folder ${target ? shortPath(target) : ''}${parent.exists ? '' : ' (and the folder it goes in)'} and start the session inside it.`}
        confirmLabel={pt ? 'Criar pasta' : 'Create folder'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => void create()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
