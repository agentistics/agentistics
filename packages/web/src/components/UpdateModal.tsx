import React, { useEffect, useCallback, useState } from 'react'
import { X, ArrowUpCircle, Terminal, Download, Copy, Check, Loader2 } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { copyText } from '../lib/clipboard'
import {
  UPGRADE_POLL_MS, UPGRADE_WAIT_MS, browserReloadEnv, clearAppCaches, upgradeArrived,
} from '../lib/appReload'

interface Props {
  current: string
  latest: string
  lang: Lang
  /** true when this instance runs in central (hub) mode → rebuild the central. */
  isCentral?: boolean
  /** true when this instance is a team member pushing to a central. */
  isMember?: boolean
  onClose: () => void
}

export function UpdateModal({ current, latest, lang, isCentral, isMember, onClose }: Props) {
  /**
   * `idle → confirm → running → (reload | timeout | refused)`.
   *
   * There is no `done`: the machine coming back IS the end, and what announces it is the page
   * reloading. A modal that said "updated" and left the old bundle on screen would be the exact
   * lie this control exists to remove.
   */
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'running' | 'refused' | 'timeout'>('idle')
  const [note, setNote] = useState('')
  // Set when the modal closes mid-flight, so the poll stops rather than reloading a page the
  // reader has moved on from.
  const goneRef = React.useRef(false)
  useEffect(() => () => { goneRef.current = true }, [])

  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() },
    [onClose],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const t = lang === 'pt'
    ? {
        title: 'Nova versão disponível',
        subtitle: 'Há uma atualização do agentistics disponível.',
        current: 'Versão atual',
        latest: 'Versão mais recente',
        howTo: 'Como atualizar',
        centralTitle: 'Central — recompilar e reiniciar',
        centralDesc: 'Nesta máquina central, atualize o código e reconstrua o serviço:',
        memberTitle: 'Atualizar e reiniciar',
        memberDesc: 'Baixe o binário mais recente e reinicie o serviço:',
        restartNote: 'Se você não usa o autostart (systemd), basta rodar novamente:',
        binaryTitle: 'Ou baixe o binário manualmente',
        binaryDesc: 'Acesse a página de releases e substitua seu binário atual.',
        releasePage: 'Página de releases',
        close: 'Fechar',
        copy: 'Copiar',
        copied: 'Copiado',
        now: 'Atualizar agora',
        confirmTitle: 'Atualizar agora?',
        confirmBody: (v: string) =>
          `Isto baixa a versão ${v} nesta máquina, substitui o binário e reinicia o serviço. A página recarrega sozinha quando ele voltar. As sessões em tmux não são afetadas.`,
        confirmYes: 'Sim, atualizar',
        confirmNo: 'Cancelar',
        working: 'Atualizando — o servidor vai reiniciar…',
        waiting: 'Esperando a máquina voltar…',
        reloading: 'Recarregando com a versão nova…',
        timedOut: 'A máquina não voltou a tempo. Ela pode ainda estar atualizando — recarregue em um minuto, ou use o comando abaixo.',
        orByHand: 'Ou faça no terminal',
      }
    : {
        title: 'New version available',
        subtitle: 'A new version of agentistics is available.',
        current: 'Current version',
        latest: 'Latest version',
        howTo: 'How to update',
        centralTitle: 'Central — rebuild & restart',
        centralDesc: 'On this central machine, pull the update and rebuild the service:',
        memberTitle: 'Upgrade & restart',
        memberDesc: 'Download the latest binary and restart the service:',
        restartNote: 'If you are not using autostart (systemd), just re-run:',
        binaryTitle: 'Or download the binary manually',
        binaryDesc: 'Go to the releases page and replace your current binary.',
        releasePage: 'Releases page',
        close: 'Close',
        copy: 'Copy',
        copied: 'Copied',
        now: 'Update now',
        confirmTitle: 'Update now?',
        confirmBody: (v: string) =>
          `This downloads version ${v} on this machine, replaces the binary and restarts the service. The page reloads itself once it is back. Your tmux sessions are not affected.`,
        confirmYes: 'Yes, update',
        confirmNo: 'Cancel',
        working: 'Updating — the server is about to restart…',
        waiting: 'Waiting for the machine to come back…',
        reloading: 'Reloading on the new version…',
        timedOut: 'The machine did not come back in time. It may still be upgrading — reload in a minute, or use the command below.',
        orByHand: 'Or do it in a terminal',
      }

  /**
   * Ask the machine to upgrade itself, then WATCH for it to come back.
   *
   * The route answers `started` and nothing else, because the process that would say "done" is the
   * one the upgrade restarts — so every failed poll from here is the ordinary case and is ignored
   * until the ceiling. When the version it names is the one we asked for, the service worker and
   * its caches are emptied and the page reloads: the programmatic form of the ctrl+shift+R this
   * release flow has needed every single time.
   */
  const start = useCallback(async () => {
    setPhase('running')
    setNote(t.working)
    try {
      const res = await fetch(`/api/upgrade?lang=${lang === 'pt' ? 'pt' : 'en'}`, { method: 'POST' })
      const body = await res.json().catch(() => ({})) as { ok?: boolean; message?: string }
      if (!res.ok || !body.ok) {
        // The server's OWN sentence: it knows which of the four refusals this is.
        setPhase('refused')
        setNote(body.message ?? t.timedOut)
        return
      }
    } catch {
      setPhase('refused')
      setNote(t.timedOut)
      return
    }

    setNote(t.waiting)
    const until = Date.now() + UPGRADE_WAIT_MS
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, UPGRADE_POLL_MS))
      if (goneRef.current) return
      // `no-store`: the one request that must not be answered by the very cache being replaced.
      const info = await fetch('/api/version', { cache: 'no-store' })
        .then(r => r.ok ? r.json() as Promise<{ current?: string }> : null)
        .catch(() => null)
      if (!upgradeArrived(info, latest)) continue
      setNote(t.reloading)
      await clearAppCaches(browserReloadEnv())
      window.location.reload()
      return
    }
    setPhase('timeout')
    setNote(t.timedOut)
  }, [lang, latest, t])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 16,
          boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
          maxWidth: 520,
          width: '100%',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'var(--anthropic-orange-dim)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <ArrowUpCircle size={18} color="var(--anthropic-orange)" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {t.title}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t.subtitle}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', padding: 4, borderRadius: 6,
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Version pills */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '20px 24px', flexWrap: 'wrap',
        }}>
          <VersionPill label={t.current} version={current} accent="var(--text-tertiary)" dim />
          <div style={{ color: 'var(--text-tertiary)', fontSize: 18 }}>→</div>
          <VersionPill label={t.latest} version={latest} accent="var(--accent-green)" />
        </div>

        {/* UPDATE NOW — the whole point is that nobody has to open a terminal for this. It is
            ABSENT on a central (its upgrade is a compose rebuild, and `upgrade-gate.ts` refuses the
            route there anyway) and it ASKS before running: this downloads and executes a binary and
            restarts the service serving the page. */}
        {!isCentral && (
          <div style={{ padding: '0 24px 16px' }}>
            {phase === 'idle' && (
              <button
                onClick={() => setPhase('confirm')}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  width: '100%', minHeight: 44, borderRadius: 10, border: 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13.5, fontWeight: 700,
                  background: 'var(--anthropic-orange)', color: '#fff',
                }}
              >
                <ArrowUpCircle size={16} />
                {t.now}
              </button>
            )}

            {phase === 'confirm' && (
              <div style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '14px 16px',
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
                  {t.confirmTitle}
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.6 }}>
                  {t.confirmBody(latest)}
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    onClick={start}
                    style={{
                      minHeight: 44, padding: '0 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
                      background: 'var(--anthropic-orange)', color: '#fff',
                    }}
                  >
                    {t.confirmYes}
                  </button>
                  <button
                    onClick={() => setPhase('idle')}
                    style={{
                      minHeight: 44, padding: '0 16px', borderRadius: 8, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {t.confirmNo}
                  </button>
                </div>
              </div>
            )}

            {/* A REFUSAL IS THE SERVER'S OWN SENTENCE, shown verbatim — the route knows whether this
                profile has host power, whether this is a central and whether one is already
                running, and a generic "could not update" would name none of them. */}
            {(phase === 'running' || phase === 'refused' || phase === 'timeout') && (
              <div
                role="status"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12, lineHeight: 1.6,
                  color: phase === 'running' ? 'var(--text-secondary)' : 'var(--accent-red)',
                }}
              >
                {phase === 'running' && <Loader2 size={14} className="ag-spin" />}
                <span>{note}</span>
              </div>
            )}
          </div>
        )}

        {/* How to update */}
        <div style={{ padding: '0 24px 24px' }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)',
            letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 14,
          }}>
            {isCentral ? t.howTo : t.orByHand}
          </div>

          {isCentral ? (
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 10, padding: '14px 16px',
            }}>
              <SectionHeader icon={<Terminal size={14} color="var(--accent-blue, #60a5fa)" />} label={t.centralTitle} />
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.6 }}>
                {t.centralDesc}
              </p>
              <CommandLine command="bun run up:central" copyLabel={t.copy} copiedLabel={t.copied} />
            </div>
          ) : (
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 10, padding: '14px 16px',
            }}>
              <SectionHeader icon={<Terminal size={14} color="var(--accent-blue, #60a5fa)" />} label={t.memberTitle} />
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.6 }}>
                {t.memberDesc}
              </p>
              <CommandLine command="agentop upgrade" copyLabel={t.copy} copiedLabel={t.copied} />
              <div style={{ height: 8 }} />
              <CommandLine command="systemctl --user restart agentop-server" copyLabel={t.copy} copiedLabel={t.copied} />
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '10px 0 8px', lineHeight: 1.6 }}>
                {t.restartNote}
              </p>
              <CommandLine command="agentop server" copyLabel={t.copy} copiedLabel={t.copied} />
            </div>
          )}

          {/* Download binary (secondary) */}
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 10, padding: '14px 16px', marginTop: 10,
          }}>
            <SectionHeader icon={<Download size={14} color="var(--anthropic-orange)" />} label={t.binaryTitle} />
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.6 }}>
              {t.binaryDesc}
            </p>
            <a
              href="https://github.com/blpsoares/agentistics/releases/latest"
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 8,
                background: 'var(--anthropic-orange-dim)',
                border: '1px solid var(--anthropic-orange-dim)',
                color: 'var(--anthropic-orange-light)',
                fontSize: 12, fontWeight: 600, textDecoration: 'none',
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              <Download size={12} />
              {t.releasePage} — v{latest}
            </a>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 24px',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px', borderRadius: 8,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover, var(--border))')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-card)')}
          >
            {t.close}
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
        {label}
      </span>
    </div>
  )
}

function VersionPill({ label, version, accent, dim }: { label: string; version: string; accent: string; dim?: boolean }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '10px 14px', borderRadius: 10,
      background: dim ? 'var(--bg-card)' : 'color-mix(in srgb, var(--accent-green) 10%, transparent)',
      border: `1px solid ${dim ? 'var(--border)' : 'color-mix(in srgb, var(--accent-green) 30%, transparent)'}`,
    }}>
      <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span style={{ fontSize: 18, fontWeight: 800, color: accent, letterSpacing: '-0.02em' }}>
        v{version}
      </span>
    </div>
  )
}

function CommandLine({ command, copyLabel, copiedLabel }: { command: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(async () => {
    const ok = await copyText(command)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [command])

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '8px 10px 8px 14px',
    }}>
      <span style={{ color: 'var(--accent-green)', userSelect: 'none', fontFamily: 'monospace', fontSize: 12 }}>$</span>
      <code style={{
        flex: 1, fontFamily: 'monospace', fontSize: 12,
        color: 'var(--text-primary)', overflowX: 'auto', whiteSpace: 'nowrap',
      }}>
        {command}
      </code>
      <button
        onClick={onCopy}
        title={copied ? copiedLabel : copyLabel}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          color: copied ? 'var(--accent-green)' : 'var(--text-secondary)',
          fontSize: 11, fontWeight: 600, flexShrink: 0,
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  )
}
