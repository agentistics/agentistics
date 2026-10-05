import React, { useState } from 'react'
import { Server, Copy, CheckCheck, AlertTriangle, Terminal, RefreshCw } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import { AgentisticsLoader } from './AgentisticsLoader'

// Types

interface DeployResult {
  env: string
  command: string
}

type OsPlatform = 'linux' | 'macos' | 'windows'

// Static autostart snippets (member-side, keep local agentop running)
// NOTE: The server-side counterpart is autostartSnippet() in
// packages/server/server/deploy.ts — keep them in sync when content changes.

const AUTOSTART_SNIPPETS: Record<OsPlatform, (execPath: string) => string> = {
  linux: (execPath) => `# Linux — systemd user service (runs without sudo)
# Place this file at: ~/.config/systemd/user/agentop.service

[Unit]
Description=Agentistics analytics server
After=network.target

[Service]
ExecStart=${execPath} server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target

# Then enable + start:
# systemctl --user daemon-reload
# systemctl --user enable --now agentop`,

  macos: (execPath) => `# macOS — launchd user agent (runs at login)
# Place this file at: ~/Library/LaunchAgents/io.agentistics.agentop.plist

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.agentistics.agentop</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>

# Then load:
# launchctl load ~/Library/LaunchAgents/io.agentistics.agentop.plist`,

  windows: (_execPath) => `# Windows — Task Scheduler (runs at logon)
# Run this command once in an elevated PowerShell:

schtasks /create /tn "Agentistics" /tr "agentop server" /sc onlogon /rl limited /f

# Or use the Task Scheduler GUI:
# Action → Create Basic Task → "Agentistics" → Trigger: At log on
# Action: Start a program → agentop → Arguments: server`,
}

const DEFAULT_EXEC_PATH: Record<OsPlatform, string> = {
  linux: '/usr/local/bin/agentop',
  macos: '/usr/local/bin/agentop',
  windows: 'agentop',
}

// Small helpers

function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const isMobile = useIsMobile()

  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div>
      {label && (
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
          marginBottom: 4, letterSpacing: '0.04em', textTransform: 'uppercase',
        }}>
          {label}
        </div>
      )}
      <div style={{
        position: 'relative',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}>
        <pre style={{
          margin: 0,
          // No room for a floating button on a phone — the copy control moves below the block.
          padding: isMobile ? '10px 12px' : '10px 44px 10px 12px',
          fontSize: 11.5,
          fontFamily: 'monospace',
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          lineHeight: 1.55,
          overflowX: 'auto',
        }}>
          {text}
        </pre>
        <button
          onClick={copy}
          title={copied ? 'Copied!' : 'Copy'}
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            color: copied ? 'var(--accent-green)' : 'var(--text-tertiary)',
            display: 'flex', alignItems: 'center',
            transition: 'color 0.15s',
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600, gap: 6,
            ...(isMobile
              // Full-width control under the block: copying is the actual task on a phone, and a
              // 19px floating icon is unhittable.
              ? { width: '100%', minHeight: 44, justifyContent: 'center', borderRadius: '0 0 8px 8px', borderWidth: '1px 0 0' }
              : { position: 'absolute' as const, top: 8, right: 8, borderRadius: 6, padding: '3px 5px' }),
          }}
        >
          {copied ? <CheckCheck size={13} /> : <Copy size={13} />}
          {isMobile && (copied ? 'Copied' : 'Copy')}
        </button>
      </div>
    </div>
  )
}

function InputField({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  const isMobile = useIsMobile()
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 4 }}>
        {label}
      </div>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: isMobile ? '10px 10px' : '7px 10px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 7,
          // 16px minimum on mobile: below it, iOS Safari auto-zooms the viewport on focus.
          fontSize: isMobile ? 16 : 13, fontFamily: 'monospace',
          color: 'var(--text-primary)',
          outline: 'none',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
      />
    </div>
  )
}

// Main component

export function DeployCentral({ pt }: { pt: boolean }) {
  const [org, setOrg] = useState('default')
  const [port, setPort] = useState('48080')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DeployResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [osPlatform, setOsPlatform] = useState<OsPlatform>('linux')

  const osOptions: { value: OsPlatform; label: string }[] = [
    { value: 'linux',   label: 'Linux' },
    { value: 'macos',   label: 'macOS' },
    { value: 'windows', label: 'Windows' },
  ]

  async function generate() {
    const trimmedOrg = org.trim() || 'default'
    const trimmedPort = port.trim() || '48080'
    setLoading(true)
    setError(null)
    // Do NOT clear result here — keep previous credentials visible until the
    // new response arrives so an in-flight or failed regenerate never destroys
    // already-shown one-time secrets.
    try {
      const params = new URLSearchParams({ org: trimmedOrg, port: trimmedPort })
      const res = await fetch(`/api/team/deploy?${params.toString()}`)
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as DeployResult
      // Only replace the previous result once the new one is ready.
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      padding: '16px 18px', borderRadius: 10,
      border: '1px solid var(--border)', background: 'var(--bg-elevated)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 9, flexShrink: 0,
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Server size={16} color="var(--text-secondary)" />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 3 }}>
            {pt ? 'Implantar um central de equipe' : 'Deploy a team central'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            {pt
              ? 'Gera um central.env com um segredo de sessão único + o comando para subir o Docker. A conta de owner é criada no navegador, no primeiro acesso.'
              : 'Generates a central.env with a one-time session secret and the command to start Docker. The owner account is created in the browser on first access.'}
          </div>
        </div>
      </div>

      {/* Inputs */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <InputField
          label={pt ? 'Organização' : 'Org'}
          value={org}
          onChange={setOrg}
          placeholder="default"
        />
        <InputField
          label={pt ? 'Porta do host' : 'Host port'}
          value={port}
          onChange={setPort}
          placeholder="47291"
          type="number"
        />
      </div>

      {/* Generate button */}
      <button
        onClick={() => { void generate() }}
        disabled={loading}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 16px', borderRadius: 7,
          border: '1px solid var(--anthropic-orange)',
          background: 'var(--anthropic-orange-dim)',
          color: 'var(--anthropic-orange)',
          fontSize: 12, fontWeight: 700,
          cursor: loading ? 'default' : 'pointer',
          opacity: loading ? 0.6 : 1,
          fontFamily: 'inherit', transition: 'opacity 0.15s',
          width: '100%', justifyContent: 'center',
          marginBottom: result || error ? 16 : 0,
        }}
      >
        {loading ? <AgentisticsLoader size={13} /> : <RefreshCw size={13} />}
        {loading
          ? (pt ? 'Gerando…' : 'Generating…')
          : result
            ? (pt ? 'Regenerar (novos segredos)' : 'Regenerate (new secrets)')
            : (pt ? 'Gerar configuração' : 'Generate config')}
      </button>

      {/* Error */}
      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 7,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          fontSize: 12, color: '#ef4444',
        }}>
          {pt ? `Erro: ${error}` : `Error: ${error}`}
        </div>
      )}

      {/* Result */}
      {result && (() => {
        // Derived inside the result block — only computed when credentials exist (FIX 3).
        const snippet = AUTOSTART_SNIPPETS[osPlatform](DEFAULT_EXEC_PATH[osPlatform])
        return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* One-time secret warning */}
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '9px 12px', borderRadius: 8,
            background: 'color-mix(in srgb, #f97316 10%, transparent)',
            border: '1px solid color-mix(in srgb, #f97316 30%, transparent)',
          }}>
            <AlertTriangle size={14} style={{ color: '#f97316', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12, color: '#f97316', lineHeight: 1.5, fontWeight: 500 }}>
              {pt
                ? 'Este central.env contém um segredo de sessão gerado uma única vez. Salve-o agora — ele não será exibido novamente. Ao subir, o central imprime no log um token de setup de uso único: use-o no navegador para criar a conta de owner.'
                : 'This central.env contains a one-time generated session secret. Save it now — it will not be shown again. On first boot the central prints a one-time setup token to its log: use it in the browser to create the owner account.'}
            </div>
          </div>

          {/* .env block */}
          <CopyBlock
            label={pt ? 'Arquivo central.env' : 'central.env file'}
            text={result.env}
          />

          {/* Command block */}
          <div>
            <div style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
              marginBottom: 4, letterSpacing: '0.04em', textTransform: 'uppercase',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <Terminal size={11} />
              {pt ? 'Comando para iniciar' : 'Start command'}
            </div>
            <CopyBlock text={result.command} />
          </div>

          {/* OS autostart section */}
          <div style={{ height: 1, background: 'var(--border)' }} />
          <div>
            <div style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
              letterSpacing: '0.04em', textTransform: 'uppercase',
              marginBottom: 8,
            }}>
              {pt
                ? 'Autostart para membros (opcional)'
                : 'Autostart for members (optional)'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 10 }}>
              {pt
                ? 'Cada membro da equipe pode configurar o agentop para iniciar automaticamente com o sistema (mantém o servidor local rodando para envio de métricas).'
                : 'Each team member can configure agentop to start automatically with the OS (keeps the local server running to push metrics).'}
            </div>

            {/* OS picker */}
            <div style={{
              display: 'flex', border: '1px solid var(--border)',
              borderRadius: 6, overflow: 'hidden', marginBottom: 10,
            }}>
              {osOptions.map((opt, i) => {
                const active = opt.value === osPlatform
                return (
                  <button
                    key={opt.value}
                    onClick={() => setOsPlatform(opt.value)}
                    style={{
                      flex: 1,
                      padding: '5px 10px',
                      fontSize: 12, fontWeight: active ? 700 : 500,
                      background: active
                        ? 'color-mix(in srgb, var(--anthropic-orange) 18%, transparent)'
                        : 'transparent',
                      color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                      border: 'none',
                      borderRight: i < osOptions.length - 1 ? '1px solid var(--border)' : 'none',
                      cursor: active ? 'default' : 'pointer',
                      fontFamily: 'inherit',
                      transition: 'background 0.15s, color 0.15s',
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>

            <CopyBlock text={snippet} />

            <div style={{
              marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5,
            }}>
              {pt
                ? 'Substitua o caminho do executável conforme necessário. O agentop deve estar instalado na máquina de cada membro.'
                : "Replace the executable path as needed. agentop must be installed on each member's machine."}
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
