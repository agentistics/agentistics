import React, { useState, useEffect, useCallback } from 'react'
import { GitBranch, Plus, Trash2, Copy, CheckCheck, AlertCircle, RefreshCw, Zap, ShieldCheck, ChevronRight } from 'lucide-react'
import { repoShortName } from '@agentistics/core'
import { copyText } from '../lib/clipboard'
import { useIsMobile } from '../hooks/useIsMobile'

export interface RepoInfo {
  remote: string
  createdAt: string
}

const COPY = {
  title:      { en: 'Repositories (GitHub Actions)',  pt: 'Repositórios (GitHub Actions)' },
  sub:        { en: 'Register a repo to track Claude Code Actions usage. Registration mints a repo-bound CI token and generates a ready-to-paste workflow.', pt: 'Registre um repo para acompanhar o uso do Claude Code Actions. O registro gera um token de CI vinculado ao repo e um workflow pronto pra colar.' },
  none:       { en: 'No repositories registered yet.', pt: 'Nenhum repositório registrado ainda.' },
  registered: { en: 'Registered',                     pt: 'Registrado' },
  urlLabel:   { en: 'Git remote URL',                 pt: 'URL do remote git' },
  urlPlaceholder: { en: 'git@github.com:org/repo.git', pt: 'git@github.com:org/repo.git' },
  register:   { en: 'Register repository',            pt: 'Registrar repositório' },
  registering:{ en: 'Registering…',                   pt: 'Registrando…' },
  regErr:     { en: 'Failed to register repository.', pt: 'Falha ao registrar repositório.' },
  loadErr:    { en: 'Failed to load repositories.',   pt: 'Falha ao carregar repositórios.' },
  remove:     { en: 'Remove',                         pt: 'Remover' },
  removing:   { en: 'Removing…',                      pt: 'Removendo…' },
  removeConfirm: { en: 'Remove this repo? Its CI token is revoked and all its Actions data is deleted.', pt: 'Remover este repo? O token de CI é revogado e todos os dados de Actions dele são apagados.' },
  registeredOk: { en: 'Registered — keyless (GitHub OIDC), no secret to store or leak.', pt: 'Registrado — keyless (GitHub OIDC), sem secret pra guardar ou vazar.' },
  keylessDesc: { en: 'Add the 3 blocks below to the workflow that already runs Claude Code. No secret needed.', pt: 'Adicione os 3 blocos abaixo no workflow que já roda o Claude Code. Nenhum secret necessário.' },
  stepA:      { en: '1 · Set this repo variable (Settings → Variables)', pt: '1 · Crie esta variável no repo (Settings → Variables)' },
  stepANote:  { en: 'On the central, set AGENTISTICS_OIDC_AUDIENCE to this SAME URL.', pt: 'Na central, defina AGENTISTICS_OIDC_AUDIENCE com esta MESMA URL.' },
  stepPerm:   { en: "2 · Add this line under the job's  permissions:", pt: '2 · Adicione esta linha no  permissions:  do job' },
  stepPermNote: { en: 'Alongside the permissions Claude already uses (contents, pull-requests…).', pt: 'Junto das permissões que o Claude já usa (contents, pull-requests…).' },
  stepB:      { en: '3 · Add as the LAST step of that job',        pt: '3 · Adicione como ÚLTIMO step desse job' },
  centralUrl: { en: 'Central URL (reachable from the runner)',    pt: 'URL da central (acessível pelo runner)' },
  fallbackTitle: { en: 'No OIDC? Use a static token instead',      pt: 'Sem OIDC? Use um token estático' },
  tokenNote:  { en: 'Copy this CI token now — it is shown only once.', pt: 'Copie este token de CI agora — ele só aparece uma vez.' },
  copyToken:  { en: 'Copy token',                     pt: 'Copiar token' },
  copySetup:  { en: 'Copy command',                   pt: 'Copiar comando' },
  copyLine:   { en: 'Copy line',                      pt: 'Copiar linha' },
  copyYaml:   { en: 'Copy step',                      pt: 'Copiar step' },
  copied:     { en: 'Copied!',                        pt: 'Copiado!' },
  refresh:    { en: 'Refresh',                        pt: 'Atualizar' },
}
const t = (k: keyof typeof COPY, lang: 'en' | 'pt') => COPY[k][lang]

/** The one permission line to add to the existing job's `permissions:` (enables keyless OIDC). */
const OIDC_PERM_LINE = `      id-token: write`

/** Keyless step (RECOMMENDED) — GitHub OIDC, no stored secret. Just the step; the permission and
 *  the repo variable are shown as separate blocks so it's obvious what to add where. */
function buildStepOidc(): string {
  return `      - name: Push agentistics metrics
        if: always()
        env:
          AGENTISTICS_CENTRAL_URL: \${{ vars.AGENTISTICS_CENTRAL_URL }}
        run: |
          curl -fsSL "https://github.com/agentistics/agentistics/releases/latest/download/agentop" -o agentop
          chmod +x agentop
          ./agentop ci-push`
}

/** Static-token fallback step (when OIDC can't be used, e.g. non-GitHub CI). */
function buildStepToken(): string {
  return `# Fallback (no OIDC): add as the LAST step of the job that runs Claude Code.
- name: Push agentistics metrics
  if: always()
  env:
    AGENTISTICS_CENTRAL_URL: \${{ vars.AGENTISTICS_CENTRAL_URL }}
    AGENTISTICS_CI_TOKEN: \${{ secrets.AGENTISTICS_CI_TOKEN }}
  run: |
    curl -fsSL "https://github.com/agentistics/agentistics/releases/latest/download/agentop" -o agentop
    chmod +x agentop
    ./agentop ci-push`
}

/** Keyless setup: only a repo variable (the central URL). No secret is stored. */
function buildSetupOidc(remote: string, centralUrl: string): string {
  return `gh variable set AGENTISTICS_CENTRAL_URL --repo ${repoShortName(remote)} --body '${centralUrl}'`
}

/** Fallback setup: store the static token as a secret + the central URL as a variable. */
function buildSetupToken(remote: string, token: string, centralUrl: string): string {
  const slug = repoShortName(remote)
  return `gh secret set AGENTISTICS_CI_TOKEN --repo ${slug} --body '${token}'
gh variable set AGENTISTICS_CENTRAL_URL --repo ${slug} --body '${centralUrl}'`
}

interface Props { lang: 'en' | 'pt' }

export function TeamRepos({ lang }: Props) {
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [registering, setRegistering] = useState(false)
  const [regErr, setRegErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ token: string; remote: string } | null>(null)
  const [centralUrl, setCentralUrl] = useState('')
  const [showFallback, setShowFallback] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const isMobile = useIsMobile()
  const [removing, setRemoving] = useState<Record<string, boolean>>({})

  useEffect(() => { setCentralUrl(window.location.origin) }, [])

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      const res = await fetch('/api/team/repos')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { repos: RepoInfo[] }
      setRepos(data.repos)
    } catch (e) { setLoadErr(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim() || registering) return
    setRegistering(true); setRegErr(null); setResult(null)
    try {
      const res = await fetch('/api/team/repos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const body = (await res.json()) as { token?: string; remote?: string; error?: string }
      if (!res.ok || !body.token || !body.remote) throw new Error(body.error || `HTTP ${res.status}`)
      setResult({ token: body.token, remote: body.remote })
      setUrl('')
      void load()
    } catch (e) { setRegErr(e instanceof Error ? e.message : t('regErr', lang)) }
    finally { setRegistering(false) }
  }

  async function handleRemove(remote: string) {
    if (!window.confirm(t('removeConfirm', lang))) return
    setRemoving(r => ({ ...r, [remote]: true }))
    try {
      await fetch('/api/team/repos', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote }),
      })
      void load()
    } finally { setRemoving(r => ({ ...r, [remote]: false })) }
  }

  async function doCopy(key: string, text: string) {
    if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied(null), 1500) }
  }

  const input: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', fontSize: 13, fontFamily: 'inherit',
    color: 'var(--text-primary)', background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 7, padding: '8px 10px', outline: 'none',
  }
  // Wrapping is deliberately avoided: YAML and shell commands break when wrapped, and copying —
  // not reading — is the real task on a phone. Cap the height instead so a 40-line workflow
  // snippet cannot push the rest of the panel off screen.
  const codeBox: React.CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: isMobile ? 11 : 11.5, lineHeight: 1.55,
    color: 'var(--text-secondary)', background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderRadius: 7, padding: '10px 12px', whiteSpace: 'pre', overflowX: 'auto', margin: 0,
    ...(isMobile ? { maxHeight: 240, overflowY: 'auto' as const } : {}),
  }
  const copyBtn = (key: string, text: string, label: string): React.ReactNode => (
    <button onClick={() => doCopy(key, text)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
      color: copied === key ? '#22c55e' : 'var(--anthropic-orange)', background: 'transparent',
      border: '1px solid var(--border)', borderRadius: 6, padding: isMobile ? '0 9px' : '4px 9px', cursor: 'pointer',
      ...(isMobile ? { width: '100%', minHeight: 44, justifyContent: 'center' } : {}),
    }}>
      {copied === key ? <CheckCheck size={12} /> : <Copy size={12} />} {copied === key ? t('copied', lang) : label}
    </button>
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <GitBranch size={15} color="var(--anthropic-orange)" />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{t('title', lang)}</span>
        <button onClick={() => load()} title={t('refresh', lang)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex' }}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 12 }}>{t('sub', lang)}</div>

      {/* Registered repos */}
      {loadErr && <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 8 }}>{t('loadErr', lang)}</div>}
      {repos.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '10px 0' }}>{t('none', lang)}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {repos.map(r => (
            <div key={r.remote} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
              <GitBranch size={13} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repoShortName(r.remote)}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.remote}</div>
              </div>
              <button onClick={() => handleRemove(r.remote)} disabled={removing[r.remote]} title={t('remove', lang)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontFamily: 'inherit',
                color: 'var(--text-tertiary)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
                padding: '4px 8px', cursor: removing[r.remote] ? 'default' : 'pointer', flexShrink: 0,
              }}>
                <Trash2 size={12} /> {removing[r.remote] ? t('removing', lang) : t('remove', lang)}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Register form */}
      <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 9 }}>
        <div>
          <label style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('urlLabel', lang)}</label>
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder={t('urlPlaceholder', lang)} style={{ ...input, marginTop: 4 }} />
        </div>
        {regErr && <div style={{ fontSize: 12, color: '#ef4444' }}>{regErr}</div>}
        <button type="submit" disabled={registering || !url.trim()} style={{
          alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
          color: '#fff', background: 'var(--anthropic-orange)', border: 'none', borderRadius: 7, padding: '8px 14px',
          cursor: registering || !url.trim() ? 'default' : 'pointer', opacity: registering || !url.trim() ? 0.6 : 1,
        }}>
          <Plus size={13} /> {registering ? t('registering', lang) : t('register', lang)}
        </button>
      </form>

      {/* Result: keyless (OIDC) primary + static-token fallback */}
      {result && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 9, background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 11.5, fontWeight: 700, color: 'var(--anthropic-orange)' }}>
            <Zap size={13} /> {repoShortName(result.remote)} <span style={{ color: 'var(--text-tertiary)', fontWeight: 500 }}>· {result.remote}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <ShieldCheck size={13} color="#22c55e" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#22c55e' }}>{t('registeredOk', lang)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 14 }}>{t('keylessDesc', lang)}</div>

          {/* Block 1 — repo variable (the central URL) */}
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>{t('stepA', lang)}</div>
          <label style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{t('centralUrl', lang)}</label>
          <input value={centralUrl} onChange={e => setCentralUrl(e.target.value)} style={{ ...input, marginTop: 4, marginBottom: 6 }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>{copyBtn('setupOidc', buildSetupOidc(result.remote, centralUrl), t('copySetup', lang))}</div>
          <pre style={{ ...codeBox, marginBottom: 6 }}>{buildSetupOidc(result.remote, centralUrl)}</pre>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
            <AlertCircle size={11} color="var(--anthropic-orange)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 10.5, color: 'var(--anthropic-orange)' }}>{t('stepANote', lang)}</span>
          </div>

          {/* Block 2 — the one permission line */}
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>{t('stepPerm', lang)}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>{copyBtn('perm', OIDC_PERM_LINE.trim(), t('copyLine', lang))}</div>
          <pre style={codeBox}>{`jobs:
  <your-job>:
    permissions:
${OIDC_PERM_LINE}        # ← add this line`}</pre>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 16 }}>
            <AlertCircle size={11} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{t('stepPermNote', lang)}</span>
          </div>

          {/* Block 3 — the step */}
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>{t('stepB', lang)}</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>{copyBtn('stepOidc', buildStepOidc(), t('copyYaml', lang))}</div>
          <pre style={codeBox}>{buildStepOidc()}</pre>

          {/* Fallback — static token (collapsible) */}
          <button onClick={() => setShowFallback(v => !v)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
            color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
          }}>
            <ChevronRight size={13} style={{ transform: showFallback ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} /> {t('fallbackTitle', lang)}
          </button>
          <div style={{ display: 'grid', gridTemplateRows: showFallback ? '1fr' : '0fr', transition: 'grid-template-rows 0.25s cubic-bezier(0.22,1,0.36,1)' }}>
            <div style={{ overflow: 'hidden', minHeight: 0 }}>
              <div style={{ paddingTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <AlertCircle size={12} color="var(--anthropic-orange)" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: 'var(--anthropic-orange)' }}>{t('tokenNote', lang)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                  <code style={{ ...codeBox, flex: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', padding: '8px 10px' }}>{result.token}</code>
                  {copyBtn('token', result.token, t('copyToken', lang))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>{copyBtn('setupTok', buildSetupToken(result.remote, result.token, centralUrl), t('copySetup', lang))}</div>
                <pre style={{ ...codeBox, marginBottom: 10 }}>{buildSetupToken(result.remote, result.token, centralUrl)}</pre>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>{copyBtn('stepTok', buildStepToken(), t('copyYaml', lang))}</div>
                <pre style={codeBox}>{buildStepToken()}</pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
