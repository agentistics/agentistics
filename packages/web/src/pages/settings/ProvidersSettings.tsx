/**
 * Settings → Providers — the credential store for the native runtime's model providers
 * (`GET/PUT/DELETE /api/provider*`). Always all 7 providers, in the server's own order; never
 * anything about a key beyond its fingerprint and last 4 characters.
 *
 * Host-only, same as Chat/Connection/Live: a central has no local runtime, so the whole section
 * is absent there (`settingsSections.ts`) and the server itself refuses with 403 `central` should
 * this page somehow be reached — rendered here as the very same sentence.
 *
 * SECURITY: the API key field is an UNCONTROLLED input, read through a ref only at submit time.
 * It never enters React state, never touches localStorage/sessionStorage, and is cleared
 * (`ref.value = ''`) the instant submit is pressed — before the request even goes out — whether
 * that submit succeeds or fails.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { NativeGate } from '../../components/NativeGate'
import { useOutletContext } from 'react-router-dom'
import { Beaker, Check, CheckCheck, Copy, Cpu, Loader2, Pencil, Search, Trash2 } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { RevealButton, REVEAL_PAD } from '../../components/PasswordReveal'
import { copyText } from '../../lib/clipboard'
import {
  type AiProviderId, type ProviderEntry, type ProviderModel, type Refusal, type TestResult,
  providerStateLabel, providerStateDot, providerCredentialMask, refusalMessage, testResultSentence,
  validateProviderForm, buildProviderPutBody, filterModels, modelsFetchedSentence, clearTestState, providerOffGuide,
} from '../../lib/providerSettings'
import {
  Checkbox, ConfirmModal, RecordCard, RecordCardAction, Select, StatusDot,
} from './primitives'
import { Drawer } from './Drawer'

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px',
  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
  fontSize: 13, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
}
const fieldLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }
const fieldSub: React.CSSProperties = { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }
const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 7, border: '1px solid var(--anthropic-orange)',
  background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
  fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const ghostBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7,
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
  fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)',
  letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 10px 8px', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontSize: 12.5, color: 'var(--text-secondary)', padding: '9px 10px',
  borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle',
}

interface FetchState {
  loading: boolean
  refusal: Refusal | null
  providers: ProviderEntry[] | null
}

async function readJson(r: Response): Promise<any> {
  try { return await r.json() } catch { return null }
}

/** Experimental (owner decision 2026-10-03): the page only where the native runtime may be shown. */
export default function ProvidersSettings() {
  const { lang } = useOutletContext<AppContext>()
  return <NativeGate lang={lang}><ProvidersSettingsBody /></NativeGate>
}

function ProvidersSettingsBody() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const isMobile = useIsMobile()

  const [state, setState] = useState<FetchState>({ loading: true, refusal: null, providers: null })

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true }))
    try {
      const r = await fetch('/api/provider')
      const json = await readJson(r)
      if (json && json.enabled === true && Array.isArray(json.providers)) {
        setState({ loading: false, refusal: null, providers: json.providers })
        return
      }
      if (json && typeof json.code === 'string') {
        setState({ loading: false, refusal: { code: json.code, sentence: json.sentence ?? '' }, providers: null })
        return
      }
      setState({ loading: false, refusal: { code: 'http-error', sentence: `HTTP ${r.status}` }, providers: null })
    } catch (e) {
      setState({ loading: false, refusal: { code: 'network', sentence: e instanceof Error ? e.message : String(e) }, providers: null })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // ---- configure drawer ----------------------------------------------------------------------
  const [configureId, setConfigureId] = useState<AiProviderId | null>(null)
  const [lockType, setLockType] = useState(false)
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [noKeyDraft, setNoKeyDraft] = useState(false)
  const [keyShown, setKeyShown] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<Refusal | null>(null)
  // Never the key's VALUE — only whether the field currently holds anything, so the drawer's
  // unsaved-changes guard can fire without the key ever leaving the input as a piece of state.
  const [keyTouched, setKeyTouched] = useState(false)
  const [initialBaseUrl, setInitialBaseUrl] = useState('')
  const [initialNoKey, setInitialNoKey] = useState(false)
  const keyRef = useRef<HTMLInputElement>(null)

  const configuring = state.providers?.find(p => p.id === configureId) ?? null
  const dirty = keyTouched || baseUrlDraft !== initialBaseUrl || noKeyDraft !== initialNoKey

  const openConfigure = (entry: ProviderEntry, locked: boolean) => {
    const baseUrl = entry.baseUrl ?? entry.defaultBaseUrl ?? ''
    const noKey = entry.keyless === true
    setConfigureId(entry.id)
    setLockType(locked)
    setBaseUrlDraft(baseUrl)
    setInitialBaseUrl(baseUrl)
    setNoKeyDraft(noKey)
    setInitialNoKey(noKey)
    setKeyShown(false)
    setKeyTouched(false)
    setFormErr(null)
  }
  const closeConfigure = () => { if (!saving) setConfigureId(null) }

  const switchConfigureTarget = (id: string) => {
    const entry = state.providers?.find(p => p.id === id)
    if (!entry) return
    const baseUrl = entry.baseUrl ?? entry.defaultBaseUrl ?? ''
    const noKey = entry.keyless === true
    setConfigureId(entry.id)
    setBaseUrlDraft(baseUrl)
    setInitialBaseUrl(baseUrl)
    setNoKeyDraft(noKey)
    setInitialNoKey(noKey)
    setKeyTouched(false)
    setFormErr(null)
  }

  const submitConfigure = async () => {
    if (!configuring || !configureId) return
    // Read once, then clear the field immediately — before validation, before the request, and
    // regardless of the outcome. This local variable is the ONLY place the key ever exists in
    // this component; it is never assigned to state.
    const inputEl = keyRef.current
    const keyTyped = inputEl?.value ?? ''
    if (inputEl) inputEl.value = ''
    setKeyTouched(false)

    const validation = validateProviderForm(
      { baseUrl: baseUrlDraft, hasKeyTyped: keyTyped.length > 0, noKey: noKeyDraft },
      configuring,
    )
    if (!validation.ok) {
      setFormErr({ code: validation.code, sentence: '' })
      return
    }

    setSaving(true)
    setFormErr(null)
    try {
      const body = buildProviderPutBody({
        baseUrl: baseUrlDraft, baseUrlEditable: configuring.baseUrlEditable,
        keyTyped, noKey: noKeyDraft, keyOptional: configuring.keyOptional,
      })
      const r = await fetch(`/api/provider/${configureId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await readJson(r)
      if (r.ok && json?.provider) {
        setState(s => ({
          ...s,
          providers: s.providers ? s.providers.map(p => (p.id === json.provider.id ? json.provider : p)) : s.providers,
        }))
        // A changed credential (or base URL) invalidates whatever the last "test connection" run
        // proved — a stale "Connected — N models" reading must not linger beside the new one.
        setTestState(s => clearTestState(s, configureId))
        setConfigureId(null)
      } else {
        setFormErr({ code: json?.code ?? 'http-error', sentence: json?.sentence ?? `HTTP ${r.status}` })
      }
    } catch (e) {
      setFormErr({ code: 'network', sentence: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  // ---- test connection ------------------------------------------------------------------------
  const [testState, setTestState] = useState<Partial<Record<AiProviderId, { loading: boolean; result?: TestResult }>>>({})

  const runTest = async (id: AiProviderId) => {
    setTestState(s => ({ ...s, [id]: { loading: true } }))
    try {
      const r = await fetch(`/api/provider/${id}/test`, { method: 'POST' })
      const json = await readJson(r)
      if (json && typeof json.ok === 'boolean') {
        setTestState(s => ({ ...s, [id]: { loading: false, result: json as TestResult } }))
      } else {
        setTestState(s => ({ ...s, [id]: { loading: false, result: { ok: false, code: 'not-json', sentence: `HTTP ${r.status}` } } }))
      }
    } catch (e) {
      setTestState(s => ({ ...s, [id]: { loading: false, result: { ok: false, code: 'network', sentence: e instanceof Error ? e.message : String(e) } } }))
    }
  }

  // ---- models drawer ---------------------------------------------------------------------------
  const [modelsFor, setModelsFor] = useState<ProviderEntry | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsErr, setModelsErr] = useState<Refusal | null>(null)
  const [modelsList, setModelsList] = useState<ProviderModel[]>([])
  const [modelsMeta, setModelsMeta] = useState<{ fetchedAt: string; fromCache: boolean } | null>(null)
  const [modelsQuery, setModelsQuery] = useState('')

  const openModels = async (entry: ProviderEntry) => {
    setModelsFor(entry)
    setModelsLoading(true)
    setModelsErr(null)
    setModelsList([])
    setModelsMeta(null)
    setModelsQuery('')
    try {
      const r = await fetch(`/api/provider/${entry.id}/models`)
      const json = await readJson(r)
      if (json?.ok) {
        setModelsList(Array.isArray(json.models) ? json.models : [])
        setModelsMeta({ fetchedAt: json.fetchedAt, fromCache: Boolean(json.fromCache) })
      } else {
        setModelsErr({ code: json?.code ?? 'http-error', sentence: json?.sentence ?? `HTTP ${r.status}` })
      }
    } catch (e) {
      setModelsErr({ code: 'network', sentence: e instanceof Error ? e.message : String(e) })
    } finally {
      setModelsLoading(false)
    }
  }

  // ---- remove -----------------------------------------------------------------------------------
  const [removeTarget, setRemoveTarget] = useState<ProviderEntry | null>(null)
  const [removing, setRemoving] = useState(false)

  const confirmRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      const r = await fetch(`/api/provider/${removeTarget.id}`, { method: 'DELETE' })
      const json = await readJson(r)
      if (r.ok && json?.provider) {
        setState(s => ({
          ...s,
          providers: s.providers ? s.providers.map(p => (p.id === json.provider.id ? json.provider : p)) : s.providers,
        }))
        // A "Connected — N models" reading must not survive the credential it described.
        setTestState(s => clearTestState(s, removeTarget.id))
      }
    } finally {
      setRemoving(false)
      setRemoveTarget(null)
    }
  }

  // -----------------------------------------------------------------------------------------------

  if (state.loading) {
    return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? 'Carregando…' : 'Loading…'}</div>
  }

  if (state.refusal?.code === 'flag-off') {
    return <FlagOffGuide pt={pt} isMobile={isMobile} />
  }

  if (state.refusal) {
    return (
      <div style={{
        fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6,
        padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
      }}>
        {refusalMessage(state.refusal, pt)}
      </div>
    )
  }

  const providers = state.providers ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
          {pt ? 'Provedores de modelo' : 'Model providers'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, marginTop: 4 }}>
          {pt
            ? 'Credenciais para os provedores que o runtime nativo desta máquina pode usar. A chave nunca é mostrada de volta — apenas a impressão digital e os últimos 4 caracteres.'
            : "Credentials for the providers this machine's native runtime can call. The key is never shown back — only its fingerprint and last 4 characters."}
        </div>
      </div>

      {providers.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '20px 0' }}>
          {pt ? 'Nenhum provedor disponível.' : 'No providers available.'}
        </div>
      ) : isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {providers.map(entry => (
            <ProviderCard
              key={entry.id}
              entry={entry}
              pt={pt}
              test={testState[entry.id]}
              onConfigure={() => openConfigure(entry, true)}
              onTest={() => void runTest(entry.id)}
              onModels={() => void openModels(entry)}
              onRemove={() => setRemoveTarget(entry)}
            />
          ))}
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 640 }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)' }}>
                <th style={th}>{pt ? 'Provedor' : 'Provider'}</th>
                <th style={th}>{pt ? 'Estado' : 'State'}</th>
                <th style={th}>{pt ? 'URL base' : 'Base URL'}</th>
                <th style={th}>{pt ? 'Credencial' : 'Credential'}</th>
                <th style={th}>{pt ? 'Salvo em' : 'Stored at'}</th>
                <th style={th}>{pt ? 'Ações' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody>
              {providers.map(entry => {
                const mask = providerCredentialMask(entry)
                const t = testState[entry.id]
                return (
                  <tr key={entry.id}>
                    <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>{entry.label}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <StatusDot state={providerStateDot(entry.state)} />
                        {providerStateLabel(entry.state, pt)}
                      </div>
                      {t?.result && (
                        <div style={{ fontSize: 11, marginTop: 3, color: t.result.ok ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                          {testResultSentence(t.result, pt)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, maxWidth: 220, wordBreak: 'break-all' }}>
                      {entry.baseUrlEditable ? (entry.baseUrl ?? entry.defaultBaseUrl ?? '—') : '—'}
                    </td>
                    <td style={td}>
                      {entry.keyless ? (pt ? 'sem chave' : 'no key') : (mask ? <code style={{ fontSize: 11.5 }}>{mask}</code> : '—')}
                    </td>
                    <td style={td}>{entry.storedAt ? new Date(entry.storedAt).toLocaleString() : '—'}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button style={{ ...ghostBtn, padding: '4px 8px' }} title={pt ? 'Configurar' : 'Configure'} onClick={() => openConfigure(entry, true)}>
                          <Pencil size={12} />
                        </button>
                        {entry.state === 'present' && (
                          <>
                            <button
                              style={{ ...ghostBtn, padding: '4px 8px', cursor: t?.loading ? 'not-allowed' : 'pointer', opacity: t?.loading ? 0.5 : 1 }}
                              title={pt ? 'Testar conexão' : 'Test connection'}
                              disabled={t?.loading}
                              onClick={() => void runTest(entry.id)}
                            >
                              {t?.loading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Beaker size={12} />}
                            </button>
                            <button style={{ ...ghostBtn, padding: '4px 8px' }} title={pt ? 'Modelos' : 'Models'} onClick={() => void openModels(entry)}>
                              <Cpu size={12} />
                            </button>
                            <button style={{ ...ghostBtn, padding: '4px 8px', color: '#ef4444' }} title={pt ? 'Remover' : 'Remove'} onClick={() => setRemoveTarget(entry)}>
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Configure drawer — reused for every row's own "configure this provider" action. The
          Select is locked to the row that opened it: a PUT is scoped to one :id, so letting the
          type change mid-edit would silently retarget a form the user believes still edits the
          provider they clicked. */}
      <Drawer
        open={configureId !== null}
        onClose={closeConfigure}
        title={configuring ? `${pt ? 'Configurar' : 'Configure'} ${configuring.label}` : (pt ? 'Configurar provedor' : 'Configure provider')}
        dirty={dirty}
        lang={pt ? 'pt' : 'en'}
        footer={configuring && (
          <>
            <button type="button" style={ghostBtn} onClick={closeConfigure} disabled={saving}>
              {pt ? 'Cancelar' : 'Cancel'}
            </button>
            <button
              type="button"
              style={{ ...primaryBtn, opacity: saving ? 0.6 : 1, cursor: saving ? 'not-allowed' : 'pointer' }}
              onClick={() => void submitConfigure()}
              disabled={saving}
            >
              {saving
                ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> {pt ? 'Salvando…' : 'Saving…'}</>
                : <><Check size={13} /> {pt ? 'Salvar' : 'Save'}</>}
            </button>
          </>
        )}
      >
        {configuring && (
          <>
            <div>
              <div style={fieldLabel}>{pt ? 'Provedor' : 'Provider'}</div>
              <Select
                value={configuring.id}
                onChange={switchConfigureTarget}
                disabled={lockType}
                options={providers.map(p => ({ value: p.id, label: p.label }))}
              />
            </div>

            {configuring.baseUrlEditable && (
              <div>
                <div style={fieldLabel}>{pt ? 'URL base' : 'Base URL'}</div>
                <input
                  value={baseUrlDraft}
                  onChange={e => setBaseUrlDraft(e.target.value)}
                  placeholder={configuring.defaultBaseUrl ?? (pt ? 'https://…' : 'https://…')}
                  style={inputStyle}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            )}

            <div>
              <div style={fieldLabel}>{pt ? 'Chave de API' : 'API key'}</div>
              <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
                {/* UNCONTROLLED on purpose — see the module doc comment. `key` remounts the node
                    (and so clears any leftover text) whenever the drawer targets a different
                    provider, without this component ever reading the value into state. */}
                <input
                  key={configuring.id}
                  ref={keyRef}
                  type={keyShown ? 'text' : 'password'}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore
                  data-form-type="other"
                  spellCheck={false}
                  defaultValue=""
                  disabled={saving}
                  placeholder={configuring.state === 'present' ? '••••••••' : ''}
                  style={{ ...inputStyle, paddingRight: REVEAL_PAD }}
                  // Only ever reports PRESENCE (for the unsaved-changes guard), never the value.
                  onChange={e => setKeyTouched(e.currentTarget.value.length > 0)}
                />
                <RevealButton shown={keyShown} onToggle={() => setKeyShown(v => !v)} />
              </div>
              {configuring.state === 'present' && (
                <div style={fieldSub}>
                  {pt ? 'Em branco mantém a chave já salva (no mesmo host).' : 'Leave blank to keep the stored key (same host only).'}
                </div>
              )}
            </div>

            {configuring.keyOptional && (
              <Checkbox
                checked={noKeyDraft}
                onChange={setNoKeyDraft}
                label={pt ? 'Sem chave (endpoint local, ex.: Ollama)' : 'No key (local endpoint, e.g. Ollama)'}
              />
            )}

            {formErr && (
              <div style={{
                fontSize: 12, color: 'var(--accent-red)', padding: '8px 10px',
                borderRadius: 7, border: '1px solid color-mix(in srgb, var(--accent-red) 35%, transparent)',
                background: 'color-mix(in srgb, var(--accent-red) 8%, transparent)',
              }}>
                {refusalMessage(formErr, pt)}
              </div>
            )}
          </>
        )}
      </Drawer>

      {/* Models drawer */}
      <Drawer
        open={modelsFor !== null}
        onClose={() => setModelsFor(null)}
        title={modelsFor ? `${pt ? 'Modelos' : 'Models'} — ${modelsFor.label}` : (pt ? 'Modelos' : 'Models')}
        lang={pt ? 'pt' : 'en'}
      >
        {modelsLoading && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? 'Carregando…' : 'Loading…'}</div>}
        {modelsErr && (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {refusalMessage(modelsErr, pt)}
          </div>
        )}
        {!modelsLoading && !modelsErr && (
          <>
            {modelsMeta && (
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                {modelsFetchedSentence(modelsMeta.fetchedAt, modelsMeta.fromCache, pt)}
              </div>
            )}
            {modelsList.length > 8 && (
              <div style={{ position: 'relative' }}>
                <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
                <input
                  value={modelsQuery}
                  onChange={e => setModelsQuery(e.target.value)}
                  placeholder={pt ? 'Buscar modelo…' : 'Search model…'}
                  style={{ ...inputStyle, paddingLeft: 28 }}
                />
              </div>
            )}
            {modelsList.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                {pt ? 'Nenhum modelo retornado.' : 'No models returned.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowX: 'hidden' }}>
                {filterModels(modelsList, modelsQuery).map(m => (
                  <div key={m.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border)',
                    background: 'var(--bg-elevated)', minWidth: 0,
                  }}>
                    <code style={{
                      fontSize: 12, color: 'var(--text-primary)', overflowWrap: 'anywhere', minWidth: 0,
                    }}>{m.id}</code>
                    {m.contextLength != null && (
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {m.contextLength.toLocaleString()} {pt ? 'tokens de contexto' : 'context tokens'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Drawer>

      <ConfirmModal
        open={removeTarget !== null}
        title={pt ? 'Remover credencial?' : 'Remove credential?'}
        message={removeTarget
          ? (pt
            ? `A chave salva para ${removeTarget.label} será apagada desta máquina.`
            : `The stored key for ${removeTarget.label} will be deleted from this machine.`)
          : ''}
        confirmLabel={removing ? (pt ? 'Removendo…' : 'Removing…') : (pt ? 'Remover' : 'Remove')}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  )
}

/** A command in a block of its own: long lines scroll inside it (never the page), and the copy
 *  control is a full-width 44px row under the block on a phone. `copyText` is the shared helper that
 *  also works over plain HTTP — the dashboard is often opened through a LAN/Tailscale address. */
function CommandBlock({ text, pt, isMobile }: { text: string; pt: boolean; isMobile: boolean }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = async () => {
    const ok = await copyText(text)
    setFailed(!ok)
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 1800)
  }
  const label = failed ? (pt ? 'Não copiou' : 'Copy failed') : copied ? (pt ? 'Copiado' : 'Copied') : (pt ? 'Copiar' : 'Copy')
  return (
    <div style={{
      position: 'relative', minWidth: 0, background: 'var(--bg-card)',
      border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
    }}>
      <pre style={{
        margin: 0, padding: isMobile ? '10px 12px' : '10px 84px 10px 12px', fontSize: 12,
        fontFamily: 'monospace', color: 'var(--text-primary)', lineHeight: 1.55,
        whiteSpace: 'pre', overflowX: 'auto',
      }}>{text}</pre>
      <button
        type="button"
        onClick={() => void copy()}
        title={label}
        style={{
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', cursor: 'pointer',
          color: failed ? 'var(--text-secondary)' : copied ? 'var(--accent-green)' : 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
          transition: 'color 0.15s',
          ...(isMobile
            ? { width: '100%', minHeight: 44, justifyContent: 'center', borderWidth: '1px 0 0', borderRadius: 0 }
            : { position: 'absolute' as const, top: 6, right: 6, borderRadius: 6, padding: '3px 8px' }),
        }}
      >
        {copied ? <CheckCheck size={13} /> : <Copy size={13} />}
        {label}
      </button>
    </div>
  )
}

/** Shown instead of the provider list while the runtime flag is off. A notice, not an error: nothing
 *  is broken, the feature is simply not switched on — so no fault colour, only what to do. */
function FlagOffGuide({ pt, isMobile }: { pt: boolean; isMobile: boolean }) {
  const guide = providerOffGuide(pt)
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0,
      padding: isMobile ? 12 : 16, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
    }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{guide.title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 4 }}>{guide.lead}</div>
      </div>
      {guide.sections.map(section => (
        <div key={section.heading} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)',
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>{section.heading}</div>
          {section.note && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{section.note}</div>
          )}
          {section.steps.map(step => (
            <div key={step.text} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{step.text}</div>
              <CommandBlock text={step.command} pt={pt} isMobile={isMobile} />
            </div>
          ))}
        </div>
      ))}
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{guide.after}</div>
    </div>
  )
}

function ProviderCard({ entry, pt, test, onConfigure, onTest, onModels, onRemove }: {
  entry: ProviderEntry
  pt: boolean
  test?: { loading: boolean; result?: TestResult }
  onConfigure: () => void
  onTest: () => void
  onModels: () => void
  onRemove: () => void
}) {
  const mask = providerCredentialMask(entry)
  return (
    <RecordCard
      title={entry.label}
      badge={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
          <StatusDot state={providerStateDot(entry.state)} />
          {providerStateLabel(entry.state, pt)}
        </span>
      }
      subtitle={test?.result ? testResultSentence(test.result, pt) : undefined}
      fields={[
        ...(entry.baseUrlEditable ? [{ label: pt ? 'URL base' : 'Base URL', value: entry.baseUrl ?? entry.defaultBaseUrl ?? '—' }] : []),
        {
          label: pt ? 'Credencial' : 'Credential',
          value: entry.keyless ? (pt ? 'sem chave' : 'no key') : (mask ?? '—'),
        },
        ...(entry.storedAt ? [{ label: pt ? 'Salvo em' : 'Stored at', value: new Date(entry.storedAt).toLocaleString() }] : []),
      ]}
      actions={
        <>
          <RecordCardAction label={pt ? 'Configurar' : 'Configure'} onClick={onConfigure}>
            <Pencil size={14} /> {pt ? 'Configurar' : 'Configure'}
          </RecordCardAction>
          {entry.state === 'present' && (
            <>
              <RecordCardAction label={pt ? 'Testar conexão' : 'Test connection'} disabled={test?.loading} onClick={onTest}>
                {test?.loading
                  ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> {pt ? 'Testando…' : 'Testing…'}</>
                  : <><Beaker size={14} /> {pt ? 'Testar' : 'Test'}</>}
              </RecordCardAction>
              <RecordCardAction label={pt ? 'Modelos' : 'Models'} onClick={onModels}>
                <Cpu size={14} /> {pt ? 'Modelos' : 'Models'}
              </RecordCardAction>
              <RecordCardAction label={pt ? 'Remover' : 'Remove'} danger onClick={onRemove}>
                <Trash2 size={14} /> {pt ? 'Remover' : 'Remove'}
              </RecordCardAction>
            </>
          )}
        </>
      }
    />
  )
}
