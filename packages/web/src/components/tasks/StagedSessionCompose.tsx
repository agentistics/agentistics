/**
 * StagedSessionCompose — write (or edit) a subtask/group's staged session draft (t-918cc82233), as
 * a THREE-STEP WIZARD.
 *
 * It shipped as one long scrolling form and grew past what a single column can hold without
 * cramming: message, attachments, assistant, model, effort, folder, all fighting for one narrow
 * dialog. Direct product feedback — "tem mt info no mesmo modal e ele ta mt fino" — is the same
 * complaint `NewSessionModal`'s own header records for the ordinary new-session form, so this
 * dialog now follows that ESTABLISHED wizard's own chrome (a numbered step track, one question's
 * worth of fields per screen, Back/Continue in the footer) rather than inventing a second one — see
 * `NewSessionModal.tsx` and `wizardSteps.ts`. The steps here are NOT `wizardSteps.ts`'s own
 * `StepId`s: that module's gating is built around the ordinary wizard's shape (a REQUIRED title, a
 * REQUIRED folder, a task-picker step) which does not describe this draft at all — see
 * `stagedSession.ts`'s own header on why every field but `prompt` is optional here. What is shared
 * is the visual language and the harness-shape helpers (`toWizardHarness`/`unsetText`/
 * `visibleQuestions`), never the step enum itself.
 *
 * THE THREE STEPS, in the order a person actually decides them: what to say (message +
 * attachments), who should do it (assistant/model/effort), where (folder). The dialog widened from
 * 560px to 640px alongside the split — a wizard with one question per screen still needs room for
 * that question's own controls (the harness cards, the folder picker's search field) not to wrap
 * awkwardly, the same "grid blowout" class of bug this file's own history already recorded once.
 *
 * ATTACHMENTS reuse the board's own file store — never a second one. Picking "Attach" uploads a
 * fresh file exactly the way `TaskFiles.tsx`'s own picker does (`onUpload`, which the caller wires to
 * `uploadFile()`), and the result is referenced by id; "Add an existing file" lets the draft point at
 * something already on the delivery (a spec somebody else attached) without uploading it twice.
 * PASTING works the same way the session composer's own prompt field does (`SessionChat.tsx`'s
 * `onPaste`, sharing `pastePlan.ts`): a clipboard FILE uploads directly, and pasted TEXT past
 * `PASTE_TEXT_LIMIT` becomes a `.txt` attachment instead of being typed inline — a 4.000-character
 * paste is a file somebody had copied, not a message. Every attachment chip OPENS
 * (`AttachmentLightbox`, shared with the chat and the gallery) rather than only naming itself, since
 * a chip is unreadable once enough time has passed that nobody remembers what it held.
 *
 * Only the harness/model/effort/cwd fields are optional here (unlike `SessionPreset`, whose harness is
 * required) — see `@agentistics/core`'s `stagedSession.ts` for why: firing a draft missing one of
 * these falls back to the ordinary wizard, pre-filled, rather than demanding everything up front —
 * which is also why nothing here validates model/effort against the harness's closed set: that check
 * belongs to launch time, exactly as `stagedSession.ts`'s own header states.
 */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, Paperclip, Plus, Trash2, X } from 'lucide-react'
import { validateStagedSessionDraft, type StagedSessionDraft } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleetNewOptions } from '../../hooks/useFleetNewOptions'
import { useDismissOverlay } from '../../lib/dismissOverlay'
import { overlayPadding } from '../../lib/mobileOverlay'
import { attachmentRoom, MAX_ATTACHMENTS, planPaste } from '../../lib/pastePlan'
import { HarnessPicker } from '../sessions/HarnessPicker'
import { ProjectPicker } from '../sessions/ProjectPicker'
import { ModelSelect } from '../sessions/ModelSelect'
import { EffortPicker } from '../sessions/EffortPicker'
import { AttachmentLightbox } from '../sessions/AttachmentLightbox'
import { toWizardHarness, unsetText, visibleQuestions } from '../../lib/wizardSteps'
import { fileIdFromLightboxPath, fileLightboxPath, fileUrl, type TaskFile } from '../../lib/tasks'
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

type ComposeStep = 'message' | 'assistant' | 'folder'

const STEP_ORDER: ComposeStep[] = ['message', 'assistant', 'folder']

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
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pickingExisting, setPickingExisting] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  /** The model picker's own open state — held here for the same reason `NewSessionModal` holds it:
   *  `esc` must close the popover before it closes the dialog. */
  const [modelOpen, setModelOpen] = useState(false)
  /** Which question is on screen. */
  const [step, setStep] = useState<ComposeStep>('message')
  /** Index into `attached` (not `p.taskFiles`) — `AttachmentLightbox` steps through what THIS
   *  draft holds, not the whole delivery's file store. */
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  const dismiss = useDismissOverlay(() => { if (!saving) p.onClose() })

  // The harnesses/folders THIS machine can start/reach — the SAME `/api/fleet/new` fetch the
  // ordinary new-session wizard runs, so a draft can never name an assistant this machine cannot
  // spawn or a folder it cannot resolve, and the two dialogs can never disagree about either list.
  const { harnesses, projects, projectTotals, projectIndexing, projectIndexProgress, projectDisks, projectDisk, setProjectDisk, query, setQuery, searching, unavailable, retry, retryable } = useFleetNewOptions(p.lang)

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
      if (lightboxIndex !== null) return // AttachmentLightbox handles its own Escape.
      if (modelOpen) setModelOpen(false)
      else if (!saving) p.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modelOpen, saving, lightboxIndex, p])

  const attached = useMemo(
    () => attachmentIds.map(id => p.taskFiles.find(f => f.id === id)).filter((f): f is TaskFile => !!f),
    [attachmentIds, p.taskFiles],
  )
  const pickable = useMemo(
    () => p.taskFiles.filter(f => !attachmentIds.includes(f.id)),
    [p.taskFiles, attachmentIds],
  )

  async function upload(files: readonly File[]) {
    if (files.length === 0) return
    setUploading(true)
    for (const f of files) {
      const id = await p.onUpload(f)
      if (id) setAttachmentIds(ids => [...ids, id])
      else setNotice(copy.attachFailed)
    }
    setUploading(false)
  }

  /** The "Attach" control's own picker — capped the same way the session composer's is, from the
   *  same module, so a wizard here and a composer there cannot silently accept a different count. */
  async function pickNew(list: FileList | null) {
    if (!list || list.length === 0) return
    const room = attachmentRoom(attachmentIds.length)
    const files = Array.from(list).slice(0, room)
    if (files.length < list.length) {
      setNotice(pt ? `No máximo ${MAX_ATTACHMENTS} anexos.` : `At most ${MAX_ATTACHMENTS} attachments.`)
    }
    await upload(files)
  }

  /**
   * A paste is three different things and `planPaste` decides which — see that module. Mirrors
   * `SessionChat.tsx`'s own `onPaste` exactly: files upload directly, ordinary text falls through to
   * the textarea (which handles the caret and the undo stack better than a manual insert), and text
   * too large to type becomes a `.txt` attachment instead.
   */
  function onPastePrompt(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const plan = planPaste({
      files: Array.from(e.clipboardData.files),
      text: e.clipboardData.getData('text/plain'),
      existing: attachmentIds.length,
    })
    if (plan.kind === 'text') return
    e.preventDefault()
    if (plan.kind === 'files') { void upload(plan.files); return }
    if (plan.kind === 'textFile') {
      void upload([new File([plan.text], plan.name, { type: 'text/plain' })])
      setNotice(copy.pasteTooLarge)
    }
  }

  function onDropPrompt(e: React.DragEvent<HTMLTextAreaElement>): void {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    void pickNew(e.dataTransfer.files)
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
      // The only way `issue === 'prompt'` can still fire is going back to step 1 and clearing it
      // after already reaching this one — send the reader back to the field the message names.
      if (check.issue === 'prompt') setStep('message')
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

  const promptEmpty = prompt.trim() === ''
  const stepIndex = STEP_ORDER.indexOf(step)
  const canContinue = step !== 'message' || !promptEmpty
  const blockedBecause = step === 'message' && promptEmpty
    ? (pt ? 'Escreva a primeira mensagem para continuar.' : 'Write the first message to continue.')
    : null

  const STEP_TITLE: Record<ComposeStep, string> = {
    message: pt ? 'Mensagem' : 'Message',
    assistant: pt ? 'Assistente' : 'Assistant',
    folder: pt ? 'Pasta' : 'Folder',
  }

  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-label={p.initial ? copy.edit : copy.compose}
      {...dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 420,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: overlayPadding(isMobile, 20),
      }}
    >
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        ...(isMobile
          ? { width: '100%', height: '100%', borderRadius: 0 }
          : { borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: '90vh' }),
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

        {/* THE STEP TRACK — the same visual language `NewSessionModal` uses for its own four
            questions: a numbered dot per step, filled and checked once passed, the line between two
            dots carrying the state of the passage. A step already visited is clickable (changing an
            earlier answer is ordinary); a step ahead is not, because it may be gated by an answer
            this one has not given yet (`canContinue`). */}
        <nav aria-label={pt ? 'Etapas' : 'Steps'} style={{
          display: 'flex', alignItems: 'flex-start',
          padding: '14px 20px 12px', borderBottom: '1px solid var(--border)',
        }}>
          {STEP_ORDER.map((id, i) => {
            const done = i < stepIndex
            const here = id === step
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'flex-start', flex: i === STEP_ORDER.length - 1 ? '0 0 auto' : 1, minWidth: 0 }}>
                <button
                  onClick={() => { if (done) setStep(id) }}
                  disabled={!done && !here}
                  aria-current={here ? 'step' : undefined}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
                    border: 'none', background: 'transparent', padding: 0, flexShrink: 0,
                    cursor: done ? 'pointer' : 'default', fontFamily: 'inherit',
                  }}
                >
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 24, height: 24, borderRadius: 999, fontSize: 11.5, fontWeight: 700,
                    boxSizing: 'border-box',
                    background: done ? 'var(--anthropic-orange)'
                      : here ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                    border: here ? '1.5px solid var(--anthropic-orange)' : '1.5px solid transparent',
                    color: done ? '#fff' : here ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                    transition: 'background 0.18s, color 0.18s, border-color 0.18s',
                  }}>
                    {done ? <Check size={12} strokeWidth={3} /> : i + 1}
                  </span>
                  <span style={{
                    fontSize: 10.5, whiteSpace: 'nowrap',
                    fontWeight: here ? 700 : 500,
                    color: here ? 'var(--text-primary)' : done ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                  }}>
                    {STEP_TITLE[id]}
                  </span>
                </button>
                {i < STEP_ORDER.length - 1 && (
                  <span aria-hidden style={{
                    flex: 1, height: 2, margin: '11px 8px 0', borderRadius: 2, minWidth: 12,
                    background: done ? 'var(--anthropic-orange)' : 'var(--border)',
                    opacity: done ? 0.55 : 1,
                    transition: 'background 0.18s',
                  }} />
                )}
              </div>
            )
          })}
        </nav>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* STEP 1 — the message and everything attached to it. */}
          {step === 'message' && (<>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {copy.prompt}
            </div>
            <textarea
              value={prompt} onChange={e => setPrompt(e.target.value)}
              onPaste={onPastePrompt}
              onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
              onDrop={onDropPrompt}
              rows={6}
              placeholder={copy.promptPlaceholder}
              style={{ ...field(isMobile), resize: 'vertical', minHeight: 140, fontFamily: 'inherit' }}
            />
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
                  onChange={e => { void pickNew(e.target.files); e.target.value = '' }}
                />
              </label>
            </div>
            {attached.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{copy.noFiles}</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {attached.map((f, i) => (
                  <span key={f.id} style={{ ...pill(), display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <button
                      type="button" onClick={() => setLightboxIndex(i)}
                      title={pt ? 'Abrir' : 'Open'}
                      style={{
                        background: 'none', border: 'none', padding: 0, color: 'inherit',
                        font: 'inherit', cursor: 'pointer',
                        maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >{f.name}</button>
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
          </>)}

          {/* STEP 2 — who should do it. */}
          {step === 'assistant' && (<>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {copy.harness}
            </div>
            <HarnessPicker
              lang={p.lang} harnesses={harnesses} value={harnessId} onChange={selectHarness}
              {...(unavailable ? { notice: unavailable } : {})}
              {...(retryable ? { onRetry: retry } : {})}
            />
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
          </>)}

          {/* STEP 3 — where. */}
          {step === 'folder' && (<>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>
              {copy.cwd}
            </div>
            <ProjectPicker
              lang={p.lang}
              isMobile={isMobile}
              projects={projects}
              projectTotals={projectTotals}
              projectIndexing={projectIndexing}
              projectIndexProgress={projectIndexProgress}
              projectDisks={projectDisks}
              projectDisk={projectDisk}
              onProjectDiskChange={setProjectDisk}
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
          {error && <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--accent-red)' }}>{error}</p>}
          </>)}

          {notice && (
            <p role="status" style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--anthropic-orange)' }}>
              {notice}
            </p>
          )}
        </div>

        <div style={{
          display: 'flex', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border)',
          alignItems: 'center', flexDirection: isMobile ? 'column-reverse' : 'row', flexWrap: 'wrap',
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
          {blockedBecause && (
            <span role="status" style={{
              fontSize: 11.5, color: 'var(--text-tertiary)',
              ...(isMobile ? { width: '100%', textAlign: 'center' } : { marginLeft: p.onDiscard ? 8 : 0 }),
            }}>{blockedBecause}</span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => (stepIndex === 0 ? p.onClose() : setStep(STEP_ORDER[stepIndex - 1]!))}
            disabled={saving}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: isMobile ? '0 14px' : '8px 14px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined,
              borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {stepIndex > 0 && <ChevronLeft size={14} />}
            {stepIndex === 0 ? copy.cancel : (pt ? 'Voltar' : 'Back')}
          </button>
          {step !== 'folder' ? (
            <button
              type="button"
              onClick={() => { if (canContinue) setStep(STEP_ORDER[stepIndex + 1]!) }}
              disabled={!canContinue}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
                width: isMobile ? '100%' : undefined,
                borderRadius: 8, border: 'none',
                background: canContinue ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
                color: canContinue ? '#1a1008' : 'var(--text-tertiary)', fontSize: 13, fontWeight: 700,
                cursor: canContinue ? 'pointer' : 'default', fontFamily: 'inherit',
              }}
            >
              {pt ? 'Continuar' : 'Continue'}
              <ChevronRight size={14} />
            </button>
          ) : (
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
          )}
        </div>
      </div>

      {lightboxIndex !== null && attached.length > 0 && (
        <AttachmentLightbox
          paths={attached.map(fileLightboxPath)}
          index={Math.min(lightboxIndex, attached.length - 1)}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          lang={p.lang}
          srcFor={path => fileUrl(fileIdFromLightboxPath(path))}
        />
      )}

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
