/**
 * LeaveChangesDialog — "Sair sem salvar?" (CONTAS.AGENDA-SALVAR). Closing a drawer that holds
 * unsaved edits lists WHAT changed, in words, and offers two exits: Discard or Save. Esc (or the
 * backdrop) goes back to editing. The list comes from the caller (`lib/agentUseDraft.ts` for the
 * account drawer) — this component draws it and decides nothing.
 */
import { useIsMobile } from '../hooks/useIsMobile'
import { ConfirmModal, dialogButtonStyle } from '../pages/settings/primitives'

export function LeaveChangesDialog({ open, lang, who, changes, onKeep, onDiscard, onSave }: {
  open: boolean
  lang: 'pt' | 'en'
  /** The thing being edited, named in the sentence above the list. */
  who?: string
  changes: readonly string[]
  /** Esc / backdrop: back to the edit. */
  onKeep: () => void
  onDiscard: () => void
  onSave: () => void
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  return <ConfirmModal
    open={open} tone="default" noIcon mobileSheet focusCancel placement="top" maxWidth={440}
    footerHint={pt ? 'Esc volta para a edição.' : 'Esc goes back to editing.'}
    title={pt ? 'Sair sem salvar?' : 'Leave without saving?'}
    message={who ? (pt ? `Você alterou isto em ${who}:` : `You changed this in ${who}:`) : (pt ? 'Você alterou isto:' : 'You changed this:')}
    confirmLabel={pt ? 'Salvar' : 'Save'} cancelLabel={pt ? 'Descartar' : 'Discard'}
    onConfirm={onSave} onCancel={onKeep}
    footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexDirection: isMobile ? 'column-reverse' : 'row' }}>
      <button type="button" data-leave-discard onClick={onDiscard} style={dialogButtonStyle('secondary', isMobile)}>{pt ? 'Descartar' : 'Discard'}</button>
      <button type="button" data-leave-save onClick={onSave} style={dialogButtonStyle('primary', isMobile)}>{pt ? 'Salvar' : 'Save'}</button>
    </div>}
  >
    <ul data-leave-changes style={{ margin: 0, padding: 0, listStyle: 'none', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      {changes.map((c, i) => <li key={i} style={{ position: 'relative', padding: '9px 12px 9px 26px', fontSize: 13, borderTop: i ? '1px solid var(--border)' : undefined }}>
        <span aria-hidden style={{ position: 'absolute', left: 12, color: 'var(--anthropic-orange-light)' }}>•</span>{c}
      </li>)}
    </ul>
  </ConfirmModal>
}
