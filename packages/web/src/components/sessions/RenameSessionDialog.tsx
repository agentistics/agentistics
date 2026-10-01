/**
 * RenameSessionDialog — the small "new name" prompt for a session row.
 *
 * Shared by the Sessions aside's row menu and the Nay dock's row menu, so renaming a session looks
 * and behaves the same wherever its row is drawn. It only collects the text: the caller sends it as
 * the fleet's own `rename` verb (`rename.ts` on the server), which also renames the session inside
 * its harness where that harness supports it — nothing here re-implements that.
 */

import { useState } from 'react'

export interface RenameSessionDialogProps {
  lang: 'pt' | 'en'
  /** The row's current title — what the field opens holding. */
  title: string
  onCancel: () => void
  /** Sends the rename; the dialog stays up (Save disabled) until it settles. */
  onSubmit: (text: string) => Promise<unknown>
}

export function RenameSessionDialog({ lang, title, onCancel, onSubmit }: RenameSessionDialogProps) {
  const pt = lang === 'pt'
  const [draft, setDraft] = useState(title)
  const [busy, setBusy] = useState(false)
  return (
    <div
      role="dialog"
      aria-label={pt ? 'Renomear sessão' : 'Rename session'}
      style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={onCancel}
        style={{ position: 'absolute', inset: 0, background: 'var(--ag-scrim, rgba(0,0,0,0.4))' }}
      />
      <form
        onSubmit={e => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          void onSubmit(draft.trim()).finally(() => setBusy(false))
        }}
        style={{
          position: 'relative', zIndex: 1, minWidth: 260, maxWidth: 340,
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
          boxShadow: 'var(--ag-shadow-menu)',
        }}
      >
        <label style={{
          fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', color: 'var(--text-tertiary)',
        }}>
          {pt ? 'Novo nome' : 'New name'}
        </label>
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onCancel() }}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
            color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button
            type="button" onClick={onCancel}
            style={{
              padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'transparent',
              color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
            }}
          >
            {pt ? 'Cancelar' : 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: '6px 12px', borderRadius: 8, cursor: busy ? 'default' : 'pointer', border: 'none',
              background: 'var(--anthropic-orange)', color: '#fff', opacity: busy ? 0.6 : 1,
              fontFamily: 'inherit', fontSize: 12, fontWeight: 650,
            }}
          >
            {pt ? 'Salvar' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
