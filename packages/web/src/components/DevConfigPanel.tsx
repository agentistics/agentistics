import React, { useState, useEffect, useCallback } from 'react'
import { X, Code2 } from 'lucide-react'
import { useEscapeOwner } from '../lib/overlayStack'

interface ConfigField {
  key: string
  default: string
  description: string
}

interface ConfigResponse {
  config: Record<string, string>
  backup: Record<string, string> | null
  active: Record<string, string>
}

// Mirror the server-side CONFIG_FIELDS for display ordering / descriptions
const CONFIG_FIELDS: ConfigField[] = [
  { key: 'PORT', default: '47291', description: 'API server port' },
  { key: 'VITE_PORT', default: '47292', description: 'Vite dev server port' },
]

export function DevConfigPanel({ onClose }: { onClose: () => void }) {
  const [configData, setConfigData] = useState<ConfigResponse | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ConfigResponse
      setConfigData(data)
      setDraft({ ...data.config })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEscapeOwner(true, onClose)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: draft }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const updated = (await res.json()) as { ok: boolean; config: Record<string, string> }
      setConfigData(prev => prev ? { ...prev, config: updated.config, backup: prev.config } : null)
      setDraft({ ...updated.config })
      setSavedMsg(true)
      setTimeout(() => setSavedMsg(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRestore = async () => {
    setError(null)
    try {
      const res = await fetch('/api/config/restore', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const result = (await res.json()) as { ok: boolean; config: Record<string, string> }
      if (result.ok) {
        await loadConfig()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const hasBackup = configData?.backup !== null && configData?.backup !== undefined

  const backupSummary = hasBackup && configData?.backup
    ? CONFIG_FIELDS.map(f => `${f.key}=${configData.backup?.[f.key] ?? f.default}`).join(', ')
    : ''

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: 24,
          width: 400,
          boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Code2 size={14} style={{ color: 'var(--text-secondary)' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Dev Config</span>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 28, height: 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 7,
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
            }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Description */}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 20, lineHeight: 1.5 }}>
          Changes take effect after restarting the server
        </div>

        {/* Error */}
        {error && (
          <div style={{
            padding: '8px 12px',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 8,
            fontSize: 12,
            color: '#ef4444',
            marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 20 }}>
          {CONFIG_FIELDS.map(field => {
            const fileValue = configData?.config[field.key] ?? field.default
            const activeValue = configData?.active[field.key] ?? field.default
            const restartNeeded = fileValue !== activeValue
            const currentDraft = draft[field.key] ?? field.default

            return (
              <div key={field.key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                    {field.key}
                  </span>
                  {restartNeeded && (
                    <span
                      title={`Running: ${activeValue} — file has: ${fileValue}`}
                      style={{
                        width: 7, height: 7,
                        borderRadius: '50%',
                        background: '#f97316',
                        flexShrink: 0,
                        display: 'inline-block',
                      }}
                    />
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 }}>
                  {field.description}
                  {restartNeeded && (
                    <span style={{ color: '#f97316', marginLeft: 6 }}>
                      (running: {activeValue})
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  value={currentDraft}
                  onChange={e => setDraft(prev => ({ ...prev, [field.key]: e.target.value }))}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '7px 10px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 7,
                    fontSize: 13,
                    fontFamily: 'monospace',
                    color: 'var(--text-primary)',
                    outline: 'none',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                />
              </div>
            )
          })}
        </div>

        {/* Saved message */}
        {savedMsg && (
          <div style={{
            fontSize: 12,
            color: 'var(--anthropic-orange)',
            marginBottom: 16,
            textAlign: 'center',
            fontWeight: 500,
          }}>
            Saved — restart to apply
          </div>
        )}

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--border)', marginBottom: 16 }} />

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {/* Restore backup */}
          <button
            onClick={handleRestore}
            disabled={!hasBackup}
            title={hasBackup ? `Restore: ${backupSummary}` : 'No backup available'}
            style={{
              padding: '6px 12px',
              borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: hasBackup ? 'var(--text-secondary)' : 'var(--text-tertiary)',
              fontSize: 12,
              cursor: hasBackup ? 'pointer' : 'default',
              opacity: hasBackup ? 1 : 0.45,
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              if (hasBackup) e.currentTarget.style.color = 'var(--text-primary)'
            }}
            onMouseLeave={e => {
              if (hasBackup) e.currentTarget.style.color = 'var(--text-secondary)'
            }}
          >
            Restore backup
          </button>

          {/* Save */}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '6px 16px',
              borderRadius: 7,
              border: '1px solid var(--anthropic-orange)60',
              background: 'var(--anthropic-orange-dim)',
              color: 'var(--anthropic-orange)',
              fontSize: 12,
              fontWeight: 600,
              cursor: saving ? 'default' : 'pointer',
              opacity: saving ? 0.6 : 1,
              fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { if (!saving) e.currentTarget.style.opacity = '0.8' }}
            onMouseLeave={e => { if (!saving) e.currentTarget.style.opacity = '1' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* Backup hint */}
        {hasBackup && configData?.backup && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)' }}>
            Backup: {backupSummary}
          </div>
        )}
      </div>
    </div>
  )
}
