/**
 * StagedSessionCompose — write (or edit) a subtask/group's staged session draft (t-918cc82233).
 *
 * A dialog, not an inline row: composing a prompt plus attachments needs room a table cell cannot
 * give it, and the same shape serves both "new draft" and "edit the existing one" (`initial`).
 *
 * THE ASSISTANT/FOLDER/MODEL/EFFORT FIELDS ARE THE NEW-SESSION WIZARD'S OWN PICKERS
 * (`HarnessPicker`, `ProjectPicker`, `ModelSelect`, `EffortPicker`), not a second, hand-rolled set —
 * this dialog shipped with a native `<select>` for the harness and raw free-text `<input>`s for the
 * folder/model/effort, which is exactly the anti-pattern `formBits.tsx`'s own header warns about: a
 * second dialog that restates a control instead of importing it reads as a different product one
 * click away from the one that got it right, and a typed model/effort id the harness does not
 * recognise fails at spawn with nothing on screen explaining why. `useFleetNewOptions` is the same
 * fetch `NewSessionModal` runs, shared rather than duplicated. What is DELIBERATELY skipped from the
 * wizard: the delivery/task-picker step and the title question — this dialog is already scoped to
 * one exact subtask/group of one exact delivery, so there is nothing to ask about either.
 *
 * Model and effort are ABSENT (not merely disabled) until a harness is chosen and that harness
 * actually names some — `visibleQuestions`, the same gate `NewSessionModal` renders its own step 1
 * through — because a free-text field a person can type garbage into is worse than no field at all.
 *
 * Attachments reuse the board's own file store — never a second one. Picking "Attach" uploads a
 * fresh file exactly the way `TaskFiles.tsx`'s own picker does (`onUpload`, which the caller wires to
 * `uploadFile()`), and the result is referenced by id; "Add an existing file" lets the draft point at
 * something already on the delivery (a spec somebody else attached) without uploading it twice. Only
 * the harness/model/effort/cwd fields are optional here (unlike `SessionPreset`, whose harness is
 * required) — see `@agentistics/core`'s `stagedSession.ts` for why: firing a draft missing one of
 * these falls back to the ordinary wizard, pre-filled, rather than demanding everything up front —
 * which is also why nothing here validates model/effort against the harness's closed set: that check
 * belongs to launch time, exactly as `stagedSession.ts`'s own header states.
 */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, Plus, Trash2, X } from 'lucide-react'
import { validateStagedSessionDraft, type StagedSessionDraft } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleetNewOptions } from '../../hooks/useFleetNewOptions'
import { HarnessPicker } from '../sessions/HarnessPicker'
import { ProjectPicker } from '../sessions/ProjectPicker'
import { ModelSelect } from '../sessions/ModelSelect'
import { EffortPicker } from '../sessions/EffortPicker'
import { toWizardHarness, unsetText, visibleQuestions } from '../../lib/wizardSteps'
import { type TaskFile } from '../../lib/tasks'
import { button, field, microLabel, pill, surface } from './board'
import { boardCopy, type Lang } from './copy'

export interface StagedSessionComposeProps {
  lang: Lang
  subtaskTitle: string
  initial?: StagedSessionDraft
  /** Every file already on this delivery, so the draft can point at one without re-uploading it. */
  taskFiles: readonly TaskFile[]
  /** Uploads a fresh file to the delivery's own store — returns its new `TaskFile` id. */
  onUpload: (file: File) => Promise<string | null>
  onSave: (draft: StagedSessionDraft) => void | Promise<void>
  /** Absent when there is nothing to discard yet (a brand-new draft). */
  onDiscard?: () => void | Promise<void>
  onClose: () => void
}

export function StagedSessionCompose(p: StagedSessionComposeProps) {
  const pt = p.lang === 'pt'
  const copy = boardCopy(p.lang).staged
  const isMobile = useIsMobile()

  const [prompt, setPrompt] = useState(p.initial?.prompt ?? '')
  const [attachmentIds, setAttachmentIds] = useState<string[]>(p.initial?.attachmentIds ?? [])
  const [harnessId, setHarnessId] = useState(p.initial?.harness ?? '')
  const [model, setModel] = useState(p.initial?.model ?? '')
  const [effort, setEffort] = useState(p.initial?.effort ?? '')
  const [cwd, setCwd] = useState(p.initial?.cwd ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pickingExisting, setPickingExisting] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  /** The model picker's own open state — held here for the same reason `NewSessionModal` holds it:
   *  `esc` must close the popover before it closes the dialog. */
  const [modelOpen, setModelOpen] = useState(false)

  // The harnesses/folders THIS machine can start/reach — the SAME `/api/fleet/new` fetch the
  // ordinary new-session wizard runs, so a draft can never name an assistant this machine cannot
  // spawn or a folder it cannot resolve, and the two dialogs can never disagree about either list.
  const { harnesses, projects, projectTotals, query, setQuery, searching } = useFleetNewOptions(p.lang)

  const harness = useMemo(() => harnesses?.find(h => h.id === harnessId) ?? null, [harnesses, harnessId])
  const wizardHarness = useMemo(() => harness ? toWizardHarness(harness) : null, [harness])
  const questions = visibleQuestions(wizardHarness)
  const modelUnset = unsetText(harness?.defaultModel, pt)
  const effortUnset = unsetText(harness?.defaultEffort, pt)

  /**
   * Switching assistants: keep a model/effort the NEW one also names, drop anything it cannot
   * accept — the same rule `NewSessionModal` applies on a harness change, applied only to a
   * deliberate PICK rather than to every render, so an initial draft's model/effort survives while
   * `harnesses` is still loading rather than being wiped before the fetch can even resolve it.
   */
  function selectHarness(id: string) {
    const next = harnesses?.find(h => h.id === id) ?? null
    const nextWizard = next ? toWizardHarness(next) : null
    setHarnessId(id)
    setModel(m => (nextWizard && nextWizard.models.some(x => x.id === m)) ? m : '')
    setEffort(e => (nextWizard && nextWizard.efforts.includes(e)) ? e : '')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (modelOpen) setModelOpen(false)
      else if (!saving) p.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modelOpen, saving, p])

  const attached = useMemo(
    () => attachmentIds.map(id => p.taskFiles.find(f => f.id === id)).filter((f): f is TaskFile => !!f),
    [attachmentIds, p.taskFiles],
  )
  const pickable = useMemo(
    () => p.taskFiles.filter(f => !attachmentIds.includes(f.id)),
    [p.taskFiles, attachmentIds],
  )

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    for (const f of Array.from(files)) {
      const id = await p.onUpload(f)
      if (id) setAttachmentIds(ids => [...ids, id])
    }
    setUploading(false)
  }

  async function save() {
    const draft: StagedSessionDraft = {
      prompt,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(harnessId ? { harness: harnessId } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(effort.trim() ? { effort: effort.trim() } : {}),
      ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
    }
    const check = validateStagedSessionDraft(draft)
    if (!check.ok) {
      setError(check.issue === 'prompt' ? copy.promptRequired : copy.cwdInvalid)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await p.onSave(draft)
      p.onClose()
    } catch {
      setError(copy.networkError)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-label={p.initial ? copy.edit : copy.compose}
      onClick={e => { if (e.target === e.currentTarget && !saving) p.onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 420,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{
            margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1,
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {p.initial ? copy.edit : copy.compose} — {p.subtaskTitle}
          </h2>
          <button
            onClick={p.onClose} disabled={saving} aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: saving ? 'not-allowed' : 'pointer', flexShrink: 0,
            }}
          ><X size={16} /></button>
        </header>

        {/*
          * `display: 'flex', flexDirection: 'column'` — the same shape `NewSessionModal`'s own step
          * content uses, and NOT `display: 'grid'` (what this div used to be). A grid item's
          * `min-width` defaults to `auto`, so a flex-wrap row nested inside one (the harness cards,
          * the folder picker's tab strip) is measured at its UNWRAPPED width and is allowed to
          * overflow its track rather than shrink — "grid blowout". Measured at 390px: the harness
          * row rendered 459px wide inside a 348px column, `Gemini CLI`'s right edge at x=430, cut
          * off by the dialog's own `overflow: hidden` rather than wrapping onto a second line. A
          * flex COLUMN container does not have this failure mode — its children are stretched to
          * the container's own width on the cross axis by `align-items: stretch`, which the nested
          * flex-wrap row then genuinely wraps inside.
          */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {copy.prompt}
            </div>
            <textarea
              value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
              placeholder={copy.promptPlaceholder}
              style={{ ...field(isMobile), resize: 'vertical', minHeight: 84, fontFamily: 'inherit' }}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {copy.harness}
            </div>
            <HarnessPicker lang={p.lang} harnesses={harnesses} value={harnessId} onChange={selectHarness} />
            {!harnessId && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>{copy.harnessAsk}</div>
            )}
          </div>

          {/* ABSENT, not disabled, until the harness names some — a closed dropdown whose only
              entry is "the assistant's default" is a control nobody can use, and a raw text field
              here is the exact bug this dialog is being fixed for. */}
          {questions.model && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
                {copy.model}
              </div>
              <ModelSelect
                lang={p.lang}
                open={modelOpen}
                onOpenChange={setModelOpen}
                value={model}
                onChange={setModel}
                options={wizardHarness!.models}
                unsetLabel={modelUnset}
              />
            </div>
          )}

          {questions.effort && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
                {copy.effort}
              </div>
              <EffortPicker efforts={wizardHarness!.efforts} value={effort} onChange={setEffort} />
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
                {pt ? `Sem escolha: ${effortUnset}.` : `Left unset: ${effortUnset}.`}
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {copy.cwd}
            </div>
            <ProjectPicker
              lang={p.lang}
              isMobile={isMobile}
              projects={projects}
              projectTotals={projectTotals}
              query={query}
              onQueryChange={setQuery}
              searching={searching}
              value={cwd}
              onChange={setCwd}
            />
            {!cwd.trim() && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>{copy.cwdAsk}</div>
            )}
          </div>

          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7,
            }}>
              <span style={microLabel}>{copy.attachments}</span>
              <span style={{ flex: 1 }} />
              {pickable.length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button
                    type="button" onClick={() => setPickingExisting(v => !v)}
                    style={{ ...button(isMobile), height: isMobile ? 36 : 26, fontSize: 11 }}
                  ><Plus size={12} /> {copy.existing}</button>
                  {pickingExisting && (
                    <>
                      <div onClick={() => setPickingExisting(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                      <div style={{
                        position: 'absolute', top: '100%', right: 0, zIndex: 31, marginTop: 4,
                        minWidth: 200, maxHeight: 220, overflowY: 'auto',
                        ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
                        boxShadow: 'var(--shadow-elevated)',
                      }}>
                        {pickable.map(f => (
                          <button
                            key={f.id} type="button"
                            onClick={() => { setAttachmentIds(ids => [...ids, f.id]); setPickingExisting(false) }}
                            style={{
                              border: 'none', cursor: 'pointer', textAlign: 'left', padding: '6px 9px',
                              minHeight: isMobile ? 44 : undefined, borderRadius: 5, background: 'transparent',
                              color: 'var(--text-secondary)', fontSize: 11.5,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                          >{f.name}</button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <label style={{ ...button(isMobile), height: isMobile ? 36 : 26, fontSize: 11, cursor: uploading ? 'not-allowed' : 'pointer' }}>
                <Paperclip size={12} /> {copy.attach}
                <input
                  type="file" multiple disabled={uploading} style={{ display: 'none' }}
                  onChange={e => { void upload(e.target.files); e.target.value = '' }}
                />
              </label>
            </div>
            {attached.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{copy.noFiles}</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {attached.map(f => (
                  <span key={f.id} style={{ ...pill(), display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    {f.name}
                    <button
                      type="button" onClick={() => setAttachmentIds(ids => ids.filter(id => id !== f.id))}
                      aria-label={pt ? 'Remover' : 'Remove'}
                      style={{ background: 'none', border: 'none', padding: 0, display: 'flex', color: 'inherit', cursor: 'pointer' }}
                    ><X size={10} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{error}</p>}
        </div>

        <div style={{
          display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border)',
          alignItems: 'center', flexDirection: isMobile ? 'column-reverse' : 'row',
        }}>
          {p.onDiscard && (
            <button
              type="button" onClick={() => setConfirmDiscard(true)} disabled={saving}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: isMobile ? '0 14px' : '8px 12px', minHeight: isMobile ? 44 : undefined,
                width: isMobile ? '100%' : undefined,
                borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--accent-red)', fontSize: 12.5, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            ><Trash2 size={13} /> {copy.discard}</button>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button" onClick={p.onClose} disabled={saving}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined,
              borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >{copy.cancel}</button>
          <button
            type="button" onClick={() => void save()} disabled={saving}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined,
              borderRadius: 8, border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
              color: '#1a1008', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', opacity: saving ? 0.75 : 1,
            }}
          >{copy.save}</button>
        </div>
      </div>

      {confirmDiscard && p.onDiscard && (
        <div
          role="alertdialog" aria-modal="true"
          onClick={e => { if (e.target === e.currentTarget) setConfirmDiscard(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 430, background: 'var(--ag-scrim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14,
            width: '100%', maxWidth: 380, padding: 18, display: 'grid', gap: 12,
          }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              {copy.discardTitle}
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {copy.discardMessage}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexDirection: isMobile ? 'column-reverse' : 'row' }}>
              <button
                type="button" onClick={() => setConfirmDiscard(false)}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: isMobile ? '0 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined,
                  borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >{copy.cancel}</button>
              <button
                type="button"
                onClick={() => { setConfirmDiscard(false); void p.onDiscard!(); p.onClose() }}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: isMobile ? '0 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined,
                  borderRadius: 7, border: '1px solid var(--accent-red)', background: 'var(--accent-red)',
                  color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >{copy.discard}</button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
