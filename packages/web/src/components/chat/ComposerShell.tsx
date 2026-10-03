/**
 * ComposerShell — the PRESENTATION of the session chat's composer, shared.
 *
 * Extracted from `SessionChat.tsx` so a second composer (the Agentask comment field) wears exactly
 * the same box: the rounded `--bg-input` field, the attachments row INSIDE it (64px thumbnails and
 * file chips), the toolbar row under the text, and the three controls both composers have — attach,
 * microphone and send. Nothing here owns state or behaviour: values, uploads, dictation and sending
 * stay with the caller, which passes them in. Every style below is moved verbatim from SessionChat,
 * so the session chat looks and behaves as it did.
 */

import type { ReactNode } from 'react'
import { Loader, Mic, Paperclip, Send, X } from 'lucide-react'

/** The box: field column + attachments + text + toolbar. `hidden` keeps the caller's reopen state. */
export function ComposerShell({ hidden, dimmed, children }: {
  hidden?: boolean
  dimmed?: boolean
  children: ReactNode
}) {
  return (
    <div style={{
      // NEVER hidden while the field has the caret — the caller decides (`showReopen`).
      display: hidden ? 'none' : 'flex',
      // A COLUMN: the text gets the whole width, the controls sit under it.
      flexDirection: 'column', alignItems: 'stretch', gap: 2,
      // THE FIELD. A rounded, bordered, inset box — the shape a person recognises as somewhere to type.
      background: 'var(--bg-input)',
      border: '1px solid var(--border)',
      borderRadius: 14,
      padding: '5px 6px 5px 8px',
      opacity: dimmed ? 0.55 : 1,
      transition: 'border-color 0.15s',
    }}>
      {children}
    </div>
  )
}

/** The controls, on their own line under the text. */
export function ComposerToolbar({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
}

export interface ComposerAttachment { path: string; name: string }

/**
 * THE ATTACHMENTS LIVE INSIDE THE FIELD — its first row, above the text. Images are the same square
 * the sent message wears; anything else is a chip with the name.
 */
export function ComposerAttachments({ items, pt, isImage, imageSrc, onOpenImage, onRemove }: {
  items: readonly ComposerAttachment[]
  pt: boolean
  isImage: (path: string) => boolean
  imageSrc: (path: string) => string
  onOpenImage: (path: string) => void
  onRemove: (path: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div
      aria-label={pt ? 'Anexos desta mensagem' : 'Attachments for this message'}
      title={pt
        ? 'Gravados nesta máquina; o caminho vai na mensagem'
        : 'Stored on this machine; the path goes in the message'}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '6px 4px 4px' }}
    >
      {items.map(a => isImage(a.path) ? (
        <span key={a.path} title={a.name} style={{
          position: 'relative', display: 'block', width: 64, height: 64,
          borderRadius: 10, overflow: 'hidden', flexShrink: 0,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
        }}>
          {/* The picture OPENS. A button, reachable by keyboard, and a SIBLING of the remove
              control rather than its parent — a button inside a button is invalid. */}
          <button
            type="button"
            onClick={() => onOpenImage(a.path)}
            aria-label={pt ? `Ver ${a.name}` : `View ${a.name}`}
            style={{
              display: 'block', width: '100%', height: '100%', padding: 0,
              border: 'none', background: 'transparent', cursor: 'zoom-in',
            }}
          >
            <img src={imageSrc(a.path)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </button>
          <button
            onClick={() => onRemove(a.path)}
            aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
            title={pt ? 'Remover' : 'Remove'}
            className="ag-tap-icon"
            style={{
              position: 'absolute', top: 4, right: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, borderRadius: '50%', padding: 0,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(0,0,0,0.7)', color: '#fff', cursor: 'pointer',
            }}
          >
            <X size={11} />
          </button>
        </span>
      ) : (
        <span key={a.path} title={a.path} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
          height: 32, padding: '0 8px', borderRadius: 10, minWidth: 0, alignSelf: 'flex-end',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          fontSize: 11.5, color: 'var(--text-secondary)',
        }}>
          <Paperclip size={11} style={{ flexShrink: 0 }} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
          <button
            onClick={() => onRemove(a.path)}
            aria-label={pt ? `Remover ${a.name}` : `Remove ${a.name}`}
            className="ag-tap-icon"
            style={{
              display: 'flex', border: 'none', background: 'transparent', padding: 0,
              color: 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}

export function ComposerAttachButton({ onClick, disabled, uploading, label }: {
  onClick: () => void; disabled: boolean; uploading: boolean; label: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || uploading}
      aria-label={label}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
        background: 'transparent', color: 'var(--text-tertiary)',
        cursor: !disabled && !uploading ? 'pointer' : 'default',
      }}
    >
      {uploading ? <Loader size={15} className="ag-working-spin" /> : <Paperclip size={15} />}
    </button>
  )
}

export function ComposerMicButton({ onClick, disabled, listening, label }: {
  onClick: () => void; disabled: boolean; listening: boolean; label: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={label}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
        background: listening ? 'color-mix(in srgb, var(--accent-red) 14%, transparent)' : 'transparent',
        color: listening ? 'var(--accent-red)' : 'var(--text-tertiary)',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {/* PULSING WHILE IT LISTENS: the ring is the state, a tint alone looks like a dead button. */}
      <span style={{ position: 'relative', display: 'flex' }}>
        {listening && (
          <span
            aria-hidden
            className="ag-mic-pulse"
            style={{
              position: 'absolute', inset: -5, borderRadius: 12,
              border: '1.5px solid var(--accent-red)', pointerEvents: 'none',
            }}
          />
        )}
        <Mic size={15} />
      </span>
    </button>
  )
}

export function ComposerSendButton({ onClick, disabled, sending, active, label }: {
  onClick: () => void
  /** The button cannot be pressed. */
  disabled: boolean
  sending: boolean
  /** Something to send and permission to send it — the orange state. */
  active: boolean
  label: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 34, height: 34, borderRadius: 9, border: 'none', flexShrink: 0,
        background: active ? 'var(--anthropic-orange)' : 'transparent',
        color: active ? '#fff' : 'var(--text-tertiary)',
        cursor: active ? 'pointer' : 'default',
      }}
    >
      {sending ? <Loader size={15} className="ag-working-spin" /> : <Send size={15} />}
    </button>
  )
}

/** The textarea's own typography — one place, so the two composers type in the same voice. */
export const composerFieldStyle = {
  width: '100%', display: 'block', boxSizing: 'border-box' as const,
  resize: 'none' as const, border: 'none', outline: 'none', background: 'transparent',
  caretColor: 'var(--anthropic-orange)', fontFamily: 'inherit', fontSize: 13.5,
  lineHeight: 1.5, overflowY: 'auto' as const, padding: '6px 6px',
}
