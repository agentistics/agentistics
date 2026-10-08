/**
 * The custom-type pieces of the vault: the "Criar tipo…" dialog (opened from every kind selector) and the
 * Settings list that renames and removes them. A type is a LABEL over a base kind (`lib/vaultKinds.ts`);
 * nothing here touches a secret — removing a type only removes the name.
 */
import { useState } from 'react'
import { Pencil, Tag, Trash2 } from 'lucide-react'
import { ConfirmModal, DialogActions, Select, dialogButtonStyle } from '../../pages/settings/primitives'
import { Field } from '../sessions/formBits'
import { Sheet, TextField, VaultRow, iconBtn, pageBtn } from '../../pages/vault/vaultUi'
import { pt_, type PKey } from '../../lib/personalText'
import { PERSONAL_KINDS, type PersonalKind } from '../../lib/vaultPersonal'
import { MAX_TYPES, addVaultType, removeVaultType, renameVaultType, typeNameProblem, useVaultTypes, type VaultType } from '../../lib/vaultKinds'

type Lang = 'en' | 'pt'
const problemKey = { empty: 'typeEmpty', long: 'typeLong', taken: 'typeTaken' } as const

export function CreateTypeDialog({ lang, isMobile, onCreated, onClose, initialBase = 'api-key' }: {
  lang: Lang; isMobile: boolean; onCreated: (t: VaultType) => void; onClose: () => void; initialBase?: PersonalKind
}) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const types = useVaultTypes()
  const [name, setName] = useState('')
  const [base, setBase] = useState<PersonalKind>(initialBase)
  const problem = name.trim() ? typeNameProblem(name, types) : null
  const full = types.length >= MAX_TYPES
  const ok = Boolean(name.trim()) && !problem && !full
  const save = () => { if (!ok) return; const made = addVaultType(name, base); if (made) onCreated(made) }
  return (
    <Sheet closeLabel={t('close')} isMobile={isMobile} title={t('typeDialogTitle')} onClose={onClose}
      footer={(
        <DialogActions>
          <button type="button" onClick={onClose} style={dialogButtonStyle('secondary', isMobile)}>{t('cancel')}</button>
          <button type="submit" form="vault-type-form" disabled={!ok} data-type-save style={dialogButtonStyle('primary', isMobile, !ok)}>{t('typeSave')}</button>
        </DialogActions>
      )}>
      <form id="vault-type-form" onSubmit={e => { e.preventDefault(); save() }}>
        <TextField lang={lang} label={t('typeName')} value={name} onChange={setName} maxLength={40} autoFocus={!isMobile} placeholder={t('typeNamePh')} />
        {problem && <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red, #ef4444)', marginTop: -8, marginBottom: 12 }}>{t(problemKey[problem])}</div>}
        <div style={{ marginBottom: 8 }}>
          <Field label={t('typeBase')}>
            <Select value={base} onChange={v => setBase(v as PersonalKind)} options={PERSONAL_KINDS.map(k => ({ value: k, label: t(`kind_${k}` as PKey) }))} />
          </Field>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{full ? t('typeFull') : t('typeBaseHelp')}</div>
      </form>
    </Sheet>
  )
}

/** Settings → the person's types: rename inline, remove with a confirmation. */
export function CustomTypesRow({ lang, isMobile }: { lang: Lang; isMobile: boolean }) {
  const t = (k: PKey, v?: Record<string, string | number>) => pt_(k, lang, v)
  const types = useVaultTypes()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [removing, setRemoving] = useState<VaultType | null>(null)
  const [creating, setCreating] = useState(false)
  const btn = pageBtn(isMobile)
  const renameProblem = renaming ? typeNameProblem(renaming.name, types, renaming.id) : null
  return (
    <>
      <VaultRow data="types" isMobile={isMobile} icon={<Tag size={16} />} title={t('typesTitle')} desc={t('typesDesc')}
        extra={types.length === 0
          ? <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 10 }}>{t('typesNone')}</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {types.map(ty => (
                <div key={ty.id} data-vault-type={ty.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                  {renaming?.id === ty.id
                    ? (
                      <>
                        <div style={{ flex: 1, minWidth: 140 }}>
                          <TextField lang={lang} label={t('typeRename')} value={renaming.name} onChange={v => setRenaming({ id: ty.id, name: v })} maxLength={40} autoFocus />
                        </div>
                        <button type="button" disabled={Boolean(renameProblem)} style={btn} onClick={() => { renameVaultType(ty.id, renaming.name); setRenaming(null) }}>{t('save')}</button>
                        <button type="button" style={btn} onClick={() => setRenaming(null)}>{t('cancel')}</button>
                      </>
                    )
                    : (
                      <>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>
                          {ty.name} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-tertiary)' }}>· {t(`kind_${ty.base}` as PKey)}</span>
                        </span>
                        <button type="button" className="ag-tap-icon" style={iconBtn} aria-label={`${t('typeRename')}: ${ty.name}`} title={t('typeRename')} onClick={() => setRenaming({ id: ty.id, name: ty.name })}><Pencil size={14} /></button>
                        <button type="button" className="ag-tap-icon" style={iconBtn} aria-label={`${t('typeRemove')}: ${ty.name}`} title={t('typeRemove')} onClick={() => setRemoving(ty)}><Trash2 size={14} /></button>
                      </>
                    )}
                </div>
              ))}
            </div>
          )}>
        <button type="button" style={btn} onClick={() => setCreating(true)}>{t('createTypeRow')}</button>
      </VaultRow>
      {creating && <CreateTypeDialog lang={lang} isMobile={isMobile} onCreated={() => setCreating(false)} onClose={() => setCreating(false)} />}
      <ConfirmModal open={removing !== null} title={t('typeRemove')} message={removing ? t('typeRemoveConfirm', { name: removing.name }) : ''} confirmLabel={t('typeRemove')} cancelLabel={t('cancel')}
        onCancel={() => setRemoving(null)} onConfirm={() => { if (removing) removeVaultType(removing.id); setRemoving(null) }} />
    </>
  )
}
