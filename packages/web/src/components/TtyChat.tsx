import { versionedAsset } from '../lib/brand'
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { findChatSound } from '../lib/chatSounds'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  MessageSquare, X, Send, Loader, AlertCircle, Trash2,
  Maximize2, Minimize2, Terminal, Play, ChevronRight,
  Wrench, ChevronDown, ChevronUp, ArrowRight, Filter, History, Plus,
  ShieldAlert, Check, ExternalLink, Paperclip, FileText as FileTextIcon, Minus, Brain,
  AlertTriangle, Copy,
} from 'lucide-react'

// Attachment type (Nay only handles images + text files)
type NayAttachment = {
  id: string
  name: string
  mimeType: string
  data: string
  isImage: boolean
  preview?: string
}
import { CHAT_MODELS, type ChatModelId, DEFAULT_CHAT_MODEL } from '../lib/chatModels'
import type { HarnessId } from '@agentistics/core'
import { HARNESS_LABELS, HARNESS_COLORS } from '../lib/harness'
import { formatToolName, fmtTime, NAV_LINK_RE, PDF_LINK_RE } from '@agentistics/core'
import { t } from '@agentistics/core'
import type { Filters } from '@agentistics/core'
import { useChatHarnesses, type HarnessChatStatus } from '../hooks/useChatHarnesses'

type Lang = 'pt' | 'en'

type ThinkingBudget = false | 8000 | 16000 | 32000
const THINKING_CYCLE: ThinkingBudget[] = [false, 8000, 16000, 32000]
function nextThinkingBudget(cur: ThinkingBudget): ThinkingBudget {
  return THINKING_CYCLE[(THINKING_CYCLE.indexOf(cur) + 1) % THINKING_CYCLE.length]!
}
function thinkingLabel(b: ThinkingBudget): string {
  if (!b) return ''
  if (b === 8000) return '8K'
  if (b === 16000) return '16K'
  return '32K'
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  terminal?: boolean
  exitCode?: number
  timestamp: number
  tools?: string[]
  images?: string[]   // data URLs – shown as thumbnails in the bubble
  files?: string[]    // file names – shown as chips in the bubble
}

type RawSessionMessage = {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  tools?: string[]
  images?: string[]
  files?: string[]
}

// Detect sessions stored with the old inline-history format ("User: ...\nAssistant: ...") and
// parse them into individual message bubbles for display.
function expandHistoryBlob(msgs: RawSessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const msg of msgs) {
    const isBlob =
      msg.role === 'user' &&
      (msg.content.startsWith('User: ') || msg.content.startsWith('Assistant: ')) &&
      (msg.content.includes('\nUser: ') || msg.content.includes('\nAssistant: '))
    if (!isBlob) { out.push({ ...msg, terminal: false }); continue }

    let currentRole: 'user' | 'assistant' | null = null
    let currentLines: string[] = []
    const flush = () => {
      if (!currentRole) return
      const content = currentLines.join('\n').trim()
      if (content) out.push({ role: currentRole, content, timestamp: msg.timestamp, terminal: false })
      currentLines = []
    }
    for (const line of msg.content.split('\n')) {
      if (line.startsWith('User: '))       { flush(); currentRole = 'user';      currentLines = [line.slice(6)] }
      else if (line.startsWith('Assistant: ')) { flush(); currentRole = 'assistant'; currentLines = [line.slice(11)] }
      else currentLines.push(line)
    }
    flush()
  }
  return out
}

type NaySessionSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  model: string
}

// Detect assistant messages that are asking the user for confirmation/permission
const CONFIRM_PATTERNS = [
  /confirme?\b/i, /please confirm/i, /por favor confirm/i,
  /preciso de sua permiss/i, /need(s)? your (permission|approval)/i,
  /você (pode|pode) confirmar/i, /can you (confirm|approve)/i,
  /deseja (prosseguir|continuar)/i, /do you (want|wish) (to )?proceed/i,
  /quer (que eu|continuar|prosseguir)/i,
]
function looksLikeConfirmRequest(text: string): boolean {
  return CONFIRM_PATTERNS.some(re => re.test(text))
}

function ConfirmBar({ pt, onConfirm, onCancel }: { pt: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{
      margin: '6px 0 10px',
      padding: '10px 14px',
      borderRadius: 10,
      border: '1px solid color-mix(in srgb, var(--accent-purple) 40%, transparent)',
      background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)',
      display: 'flex', alignItems: 'center', gap: 10,
      animation: 'ttyChatFadeIn 0.15s ease-out',
    }}>
      <ShieldAlert size={14} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />
      <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
        {pt ? 'Aguardando confirmação' : 'Awaiting confirmation'}
      </span>
      <button
        onClick={onCancel}
        style={{
          padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        {pt ? 'Cancelar' : 'Cancel'}
      </button>
      <button
        onClick={onConfirm}
        style={{
          padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700,
          border: '1px solid var(--accent-purple)',
          background: 'color-mix(in srgb, var(--accent-purple) 20%, transparent)',
          color: 'var(--accent-purple)', cursor: 'pointer', fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 5,
        }}
      >
        <Check size={11} />
        {pt ? 'Confirmar' : 'Confirm'}
      </button>
    </div>
  )
}

const BADGE_COLORS: Record<string, string> = {
  Fast:     'var(--accent-green)',
  Balanced: 'var(--anthropic-orange)',
  Powerful: 'var(--accent-purple)',
}

// Audio

function createPlayFn(ctxRef: React.MutableRefObject<AudioContext | null>) {
  return function playNotification() {
    const ctx = ctxRef.current
    if (!ctx) return
    ctx.resume().then(() => {
      const now = ctx.currentTime
      const playTone = (freq: number, start: number, dur: number) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.18, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, start + dur)
        osc.start(start)
        osc.stop(start + dur)
      }
      playTone(880,  now,        0.25)
      playTone(1100, now + 0.12, 0.25)
    }).catch(() => {/* ignore */})
  }
}

// Markdown renderer

interface CodeBlockProps { lang: string; code: string; onRun?: (c: string) => void }

function CodeBlock({ lang: codeLang, code, onRun }: CodeBlockProps) {
  const isRunnable = ['bash', 'sh', 'shell', 'zsh'].includes(codeLang.toLowerCase())
  return (
    <div style={{ position: 'relative', margin: '6px 0' }}>
      <pre style={{
        background: 'var(--bg-base)', border: '1px solid var(--border)',
        borderRadius: 6, padding: isRunnable ? '8px 12px 30px' : '10px 12px',
        fontSize: 12, overflowX: 'auto', whiteSpace: 'pre',
        fontFamily: 'monospace', color: 'var(--text-secondary)', margin: 0,
      }}>
        {codeLang && (
          <span style={{ display: 'block', fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 6 }}>
            {codeLang}
          </span>
        )}
        {code.trimEnd()}
      </pre>
      {isRunnable && onRun && (
        <button
          onClick={() => onRun(code.trim())}
          style={{
            position: 'absolute', bottom: 6, right: 8,
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 700,
            border: '1px solid var(--accent-green)40',
            background: 'color-mix(in srgb, var(--accent-green) 12%, transparent)',
            color: 'var(--accent-green)', cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <Play size={9} /> Run
        </button>
      )}
    </div>
  )
}

// Split text by both nav links and pdf links into typed segments
type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'nav'; label: string; path: string }
  | { kind: 'pdf'; label: string; url: string }

function parseSegments(text: string): Segment[] {
  const combined = new RegExp(
    `${PDF_LINK_RE.source}|${NAV_LINK_RE.source}`,
    'g',
  )
  const segments: Segment[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = combined.exec(text)) !== null) {
    if (match.index > last) segments.push({ kind: 'text', value: text.slice(last, match.index) })
    if (match[1] !== undefined && match[2] !== undefined && match[3] === undefined) {
      // pdf: match — groups 1=label, 2=url
      segments.push({ kind: 'pdf', label: match[1], url: match[2] })
    } else if (match[3] !== undefined && match[4] !== undefined) {
      // nav: match — groups 3=label, 4=path
      segments.push({ kind: 'nav', label: match[3], path: match[4] })
    }
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', value: text.slice(last) })
  return segments
}

function renderContent(
  text: string,
  onRun?: (c: string) => void,
  onNavigate?: (path: string) => void,
  onPdfExport?: (range: string) => void,
): React.ReactNode {
  const segments = parseSegments(text)
  if (segments.length === 1 && segments[0]!.kind === 'text') {
    return <MarkdownContent text={text} onRun={onRun} onNavigate={onNavigate} />
  }

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return seg.value
            ? <MarkdownContent key={i} text={seg.value} onRun={onRun} onNavigate={onNavigate} />
            : null
        }
        if (seg.kind === 'pdf') {
          const range = (() => {
            try { return new URL(seg.url).searchParams.get('range') ?? 'all' } catch { return 'all' }
          })()
          return (
            <button
              key={i}
              onClick={() => onPdfExport?.(range)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700,
                border: '1px solid color-mix(in srgb, var(--accent-orange) 50%, transparent)',
                background: 'color-mix(in srgb, var(--accent-orange) 14%, transparent)',
                color: 'var(--accent-orange)',
                margin: '8px 0', transition: 'all 0.15s',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <FileTextIcon size={13} />
              {seg.label.replace(/^⬇\s*/, '')}
            </button>
          )
        }
        // nav
        return (
          <button
            key={i}
            onClick={() => onNavigate?.(seg.path)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600,
              border: '1px solid color-mix(in srgb, var(--accent-purple) 50%, transparent)',
              background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', color: 'var(--accent-purple)',
              cursor: 'pointer', fontFamily: 'inherit',
              margin: '6px 0', transition: 'all 0.15s',
            }}
          >
            <ArrowRight size={11} />
            {seg.label.replace(/^→\s*/, '')}
          </button>
        )
      })}
    </>
  )
}

function MarkdownContent({
  text,
  onRun,
  onNavigate,
}: {
  text: string
  onRun?: (c: string) => void
  onNavigate?: (path: string) => void
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className ?? '')
          const inline = !match && !String(children).includes('\n')
          if (inline) {
            return (
              <code
                style={{
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: 3, padding: '1px 5px', fontSize: 12,
                  fontFamily: 'monospace', color: 'var(--text-primary)',
                }}
                {...props}
              >
                {children}
              </code>
            )
          }
          const lang = match?.[1] ?? ''
          const code = String(children).replace(/\n$/, '')
          return <CodeBlock lang={lang} code={code} onRun={onRun} />
        },
        a({ href, children }) {
          if (href && onNavigate && !href.startsWith('http')) {
            return (
              <button
                onClick={() => onNavigate(href)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'none', border: 'none', padding: 0,
                  color: 'var(--accent-purple)', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 'inherit', textDecoration: 'underline',
                }}
              >
                {children}
              </button>
            )
          }
          return (
            <a href={href} target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent-purple)' }}>
              {children}
            </a>
          )
        },
        p({ children }) {
          return <p style={{ margin: '4px 0', lineHeight: 1.58 }}>{children}</p>
        },
        h1({ children }) {
          return <h1 style={{ fontSize: 16, fontWeight: 700, margin: '10px 0 4px', color: 'var(--text-primary)' }}>{children}</h1>
        },
        h2({ children }) {
          return <h2 style={{ fontSize: 14, fontWeight: 700, margin: '8px 0 4px', color: 'var(--text-primary)' }}>{children}</h2>
        },
        h3({ children }) {
          return <h3 style={{ fontSize: 13, fontWeight: 700, margin: '6px 0 2px', color: 'var(--text-primary)' }}>{children}</h3>
        },
        ul({ children }) {
          return <ul style={{ margin: '4px 0', paddingLeft: 18, lineHeight: 1.7 }}>{children}</ul>
        },
        ol({ children }) {
          return <ol style={{ margin: '4px 0', paddingLeft: 18, lineHeight: 1.7 }}>{children}</ol>
        },
        li({ children }) {
          return <li style={{ marginBottom: 2 }}>{children}</li>
        },
        blockquote({ children }) {
          return (
            <blockquote style={{
              borderLeft: '3px solid color-mix(in srgb, var(--accent-purple) 60%, transparent)',
              margin: '6px 0', paddingLeft: 10,
              color: 'var(--text-secondary)', fontStyle: 'italic',
            }}>
              {children}
            </blockquote>
          )
        },
        strong({ children }) {
          return <strong style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{children}</strong>
        },
        em({ children }) {
          return <em style={{ fontStyle: 'italic' }}>{children}</em>
        },
        hr() {
          return <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '8px 0' }} />
        },
        table({ children }) {
          return (
            <div style={{ overflowX: 'auto', margin: '6px 0' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>{children}</table>
            </div>
          )
        },
        th({ children }) {
          return (
            <th style={{
              border: '1px solid var(--border)', padding: '4px 8px',
              background: 'var(--bg-elevated)', fontWeight: 700, textAlign: 'left',
            }}>
              {children}
            </th>
          )
        },
        td({ children }) {
          return (
            <td style={{ border: '1px solid var(--border)', padding: '4px 8px' }}>
              {children}
            </td>
          )
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

// Tool activity bubble

function ToolActivity({ tools, live, pt }: { tools: string[]; live: boolean; pt: boolean }) {
  const [expanded, setExpanded] = useState(false)
  if (tools.length === 0) return null
  const label = live
    ? formatToolName(tools[tools.length - 1]!)
    : pt ? `${tools.length} ação${tools.length > 1 ? 'ões' : ''} tomada${tools.length > 1 ? 's' : ''}` : `${tools.length} action${tools.length > 1 ? 's' : ''} taken`

  return (
    <div style={{
      marginBottom: 6,
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--bg-elevated)',
      overflow: 'hidden',
      fontSize: 11,
    }}>
      <button
        onClick={() => !live && setExpanded(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 9px', background: 'transparent', border: 'none',
          cursor: live ? 'default' : 'pointer', fontFamily: 'inherit', color: 'var(--text-tertiary)',
          textAlign: 'left',
        }}
      >
        {live
          ? <Loader size={10} style={{ animation: 'ttyChatSpin 1s linear infinite', flexShrink: 0, color: 'var(--accent-purple)' }} />
          : <Wrench size={10} style={{ flexShrink: 0 }} />
        }
        <span style={{ flex: 1, color: live ? 'var(--accent-purple)' : 'var(--text-tertiary)' }}>{label}</span>
        {!live && (expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
      </button>
      {!live && expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '4px 9px 6px' }}>
          {tools.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 0', color: 'var(--text-tertiary)' }}>
              <span style={{ fontSize: 9, opacity: 0.5 }}>✓</span>
              <span>{formatToolName(t)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Message component

function Message({
  msg, isLiveStreaming, currentTools, onRun, onNavigate, onPdfExport, pt,
}: {
  msg: ChatMessage
  isLiveStreaming?: boolean
  currentTools?: string[]
  onRun: (cmd: string) => void
  onNavigate: (path: string) => void
  onPdfExport?: (range: string) => void
  pt: boolean
}) {
  const isUser = msg.role === 'user'

  const timeEl = (
    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4, display: 'block', textAlign: isUser ? 'right' : 'left' }}>
      {fmtTime(msg.timestamp)}
    </span>
  )

  if (msg.terminal) {
    return (
      <div style={{ marginBottom: 14, animation: 'ttyChatFadeIn 0.15s ease-out' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
          <Terminal size={11} color="var(--accent-green)" />
          <span style={{ fontSize: 10, color: 'var(--accent-green)', fontWeight: 700 }}>
            {msg.exitCode === 0 ? 'done' : msg.exitCode !== undefined ? `exit ${msg.exitCode}` : 'running…'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{fmtTime(msg.timestamp)}</span>
        </div>
        <pre style={{
          background: 'var(--bg-base)',
          border: `1px solid ${msg.exitCode !== undefined && msg.exitCode !== 0 ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
          borderRadius: 6, padding: '8px 12px', fontSize: 12,
          fontFamily: 'monospace', color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          margin: 0, maxHeight: 280, overflowY: 'auto',
        }}>
          {msg.content || (isLiveStreaming ? '' : '(no output)')}
        </pre>
      </div>
    )
  }

  if (isUser) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        marginBottom: 14, animation: 'ttyChatFadeIn 0.15s ease-out',
      }}>
        {/* Image thumbnails above the bubble */}
        {msg.images && msg.images.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', marginBottom: 5, maxWidth: '90%' }}>
            {msg.images.map((src, i) => (
              <img key={i} src={src} alt="attachment"
                style={{ maxWidth: 130, maxHeight: 100, borderRadius: 8, objectFit: 'cover',
                  border: '1px solid color-mix(in srgb, var(--accent-purple) 40%, transparent)' }} />
            ))}
          </div>
        )}
        {/* File chips above the bubble */}
        {msg.files && msg.files.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', marginBottom: 5, maxWidth: '90%' }}>
            {msg.files.map((name, i) => (
              <span key={i} style={{
                fontSize: 10, padding: '2px 7px', borderRadius: 6,
                background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-purple) 30%, transparent)',
                color: 'var(--accent-purple)',
              }}>{name}</span>
            ))}
          </div>
        )}
        {msg.content && (
          <div style={{
            maxWidth: '90%', padding: '8px 14px',
            borderRadius: '14px 14px 4px 14px',
            background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent-purple) 30%, transparent)',
            fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.58, wordBreak: 'break-word',
          }}>
            {renderContent(msg.content)}
          </div>
        )}
        {timeEl}
      </div>
    )
  }

  // Assistant message — with avatar
  const toolsToShow = isLiveStreaming ? currentTools : msg.tools
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      marginBottom: 14, animation: 'ttyChatFadeIn 0.15s ease-out',
    }}>
      {/* Avatar */}
      <div style={{
        width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', marginTop: 2,
      }}>
        <img src={versionedAsset('/minimalistLogo.png')} alt="Nay" style={{ width: 26, height: 26, objectFit: 'contain' }} />
      </div>

      {/* Content column */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {toolsToShow && toolsToShow.length > 0 && (
          <ToolActivity
            tools={toolsToShow}
            live={!!isLiveStreaming}
            pt={pt}
          />
        )}
        <div style={{
          padding: '10px 14px',
          borderRadius: '4px 14px 14px 14px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.58, wordBreak: 'break-word',
        }}>
          {msg.content
            ? renderContent(msg.content, onRun, onNavigate, onPdfExport)
            : isLiveStreaming
              ? <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', fontSize: 12 }}>
                  <Loader size={11} style={{ animation: 'ttyChatSpin 1s linear infinite' }} />
                  {pt ? 'Escrevendo...' : 'Writing...'}
                </span>
              : null
          }
        </div>
        {timeEl}
      </div>
    </div>
  )
}

// Model picker

function ModelPicker({ lang, onPick }: { lang: Lang; onPick: (id: ChatModelId) => void }) {
  const [selected, setSelected] = useState<ChatModelId>(DEFAULT_CHAT_MODEL)
  const pt = lang === 'pt'
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 10,
      background: 'var(--bg-surface)', borderRadius: 'inherit',
      display: 'flex', flexDirection: 'column',
      padding: '20px 16px 16px',
      animation: 'ttyChatFadeIn 0.2s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <img src={versionedAsset('/minimalistLogo.png')} alt="Nay" style={{ width: 32, height: 32, borderRadius: 9, objectFit: 'cover' }} />
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Olá! Sou Nay 👋' : 'Hi! I\'m Nay 👋'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {pt ? 'Escolha o modelo para começar' : 'Choose a model to get started'}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {CHAT_MODELS.map(m => {
          const active = selected === m.id
          const badgeColor = BADGE_COLORS[m.badge] ?? 'var(--text-tertiary)'
          return (
            <button
              key={m.id}
              onClick={() => setSelected(m.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', borderRadius: 10, textAlign: 'left',
                border: active ? '1.5px solid var(--accent-purple)' : '1px solid var(--border)',
                background: active ? 'color-mix(in srgb, var(--accent-purple) 12%, transparent)' : 'var(--bg-elevated)',
                cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit',
              }}
            >
              <div style={{
                width: 36, height: 36, borderRadius: 9, flexShrink: 0,
                background: active ? 'color-mix(in srgb, var(--accent-purple) 15%, transparent)' : 'var(--bg-card)',
                border: `1px solid ${active ? 'color-mix(in srgb, var(--accent-purple) 40%, transparent)' : 'var(--border)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
              }}>
                <img src={versionedAsset('/minimalistLogo.png')} alt="" style={{ width: 22, height: 22, objectFit: 'contain', opacity: active ? 1 : 0.5 }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: active ? 'var(--accent-purple)' : 'var(--text-primary)' }}>
                    {m.label}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: badgeColor,
                    background: `color-mix(in srgb, ${badgeColor} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${badgeColor} 30%, transparent)`,
                    padding: '1px 6px', borderRadius: 4,
                  }}>
                    {m.badge}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{m.desc}</div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'right', flexShrink: 0, lineHeight: 1.7 }}>
                <div>${m.inputPer1M}/1M in</div>
                <div>${m.outputPer1M}/1M out</div>
              </div>
            </button>
          )
        })}
      </div>

      <button
        onClick={() => onPick(selected)}
        style={{
          marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
          border: '1px solid var(--accent-purple)',
          background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', color: 'var(--accent-purple)',
          cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
        }}
      >
        {pt ? 'Começar a conversar' : 'Start chatting'}
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

// Harness setup guidance panel

function CopyableCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* ignore */ })
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
      <code style={{
        flex: 1, fontSize: 10, background: 'var(--bg-base)', border: '1px solid var(--border)',
        borderRadius: 4, padding: '2px 6px', fontFamily: 'monospace', color: 'var(--text-secondary)',
        whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{text}</code>
      <button
        onClick={copy}
        title="Copy"
        style={{
          flexShrink: 0, width: 20, height: 20, borderRadius: 4,
          border: '1px solid var(--border)', background: 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: copied ? 'var(--accent-green)' : 'var(--text-tertiary)',
          transition: 'color 0.15s',
        }}
      >
        {copied ? <Check size={9} /> : <Copy size={9} />}
      </button>
    </div>
  )
}

function HarnessSetupPanel({ harness }: { harness: HarnessChatStatus }) {
  const { setup, installed, authReady } = harness
  const reason = !installed ? 'not-installed' : !authReady ? 'not-authed' : null
  if (!reason) return null
  return (
    <div style={{
      marginTop: 6, padding: '8px 10px', borderRadius: 8,
      background: 'color-mix(in srgb, var(--accent-orange) 8%, transparent)',
      border: '1px solid color-mix(in srgb, var(--accent-orange) 30%, transparent)',
      fontSize: 11, color: 'var(--text-secondary)',
      animation: 'ttyChatFadeIn 0.15s ease-out',
    }}>
      <div style={{ fontWeight: 700, color: 'var(--accent-orange)', marginBottom: 5, fontSize: 11 }}>
        {reason === 'not-installed' ? `${harness.label} is not installed` : `${harness.label} is not authenticated`}
      </div>
      {reason === 'not-installed' && setup.installCmd && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>Install:</div>
          <CopyableCode text={setup.installCmd} />
        </div>
      )}
      {reason === 'not-authed' && setup.loginCmd && (
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>Login:</div>
          <CopyableCode text={setup.loginCmd} />
        </div>
      )}
      {setup.note && (
        <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {setup.note}
        </div>
      )}
      {setup.docUrl && (
        <a href={setup.docUrl} target="_blank" rel="noopener noreferrer"
          style={{
            marginTop: 5, display: 'inline-flex', alignItems: 'center', gap: 3,
            fontSize: 10, color: 'var(--accent-purple)', textDecoration: 'none',
          }}
        >
          <ExternalLink size={9} /> Learn more
        </a>
      )}
    </div>
  )
}

/** Small inline "How to fix" panel shown inside the error display when a backend errors at runtime */
function HarnessErrorHelp({ harness }: { harness: HarnessChatStatus }) {
  const { setup } = harness
  const hasHelp = setup.installCmd || setup.loginCmd || setup.docUrl || setup.note
  if (!hasHelp) return null
  return (
    <div style={{
      marginTop: 8, padding: '8px 10px', borderRadius: 7,
      background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)',
      fontSize: 11,
    }}>
      <div style={{ fontWeight: 700, color: '#ef4444', marginBottom: 5, fontSize: 11 }}>
        How to fix ({harness.label})
      </div>
      {setup.installCmd && (
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>Install:</div>
          <CopyableCode text={setup.installCmd} />
        </div>
      )}
      {setup.loginCmd && (
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 2 }}>Login:</div>
          <CopyableCode text={setup.loginCmd} />
        </div>
      )}
      {setup.note && (
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', lineHeight: 1.5, marginTop: 3 }}>
          {setup.note}
        </div>
      )}
      {setup.docUrl && (
        <a href={setup.docUrl} target="_blank" rel="noopener noreferrer"
          style={{
            marginTop: 5, display: 'inline-flex', alignItems: 'center', gap: 3,
            fontSize: 10, color: 'var(--accent-purple)', textDecoration: 'none',
          }}
        >
          <ExternalLink size={9} /> Learn more
        </a>
      )}
    </div>
  )
}

// Nay backend harness types + localStorage helpers

const NAY_HARNESS_KEY = 'agentistics-nay-backend-harness'

function loadNayHarnessId(): string | null {
  try { return localStorage.getItem(NAY_HARNESS_KEY) } catch { return null }
}


function saveNayHarnessId(id: string) {
  try { localStorage.setItem(NAY_HARNESS_KEY, id) } catch { /* ignore */ }
}

// Nay floating window localStorage helpers

const NAY_POS_KEY  = 'agentistics-nay-chat-pos'
const NAY_SIZE_KEY = 'agentistics-nay-chat-size'

function loadNayPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(NAY_POS_KEY)
    if (raw) return JSON.parse(raw) as { x: number; y: number }
  } catch { /* ignore */ }
  return {
    x: Math.max(0, window.innerWidth / 2 - 200),
    y: 80,
  }
}

function loadNaySize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(NAY_SIZE_KEY)
    if (raw) return JSON.parse(raw) as { w: number; h: number }
  } catch { /* ignore */ }
  return { w: 420, h: 580 }
}

function saveNayPos(pos: { x: number; y: number }) {
  try { localStorage.setItem(NAY_POS_KEY, JSON.stringify(pos)) } catch { /* ignore */ }
}

function saveNaySize(size: { w: number; h: number }) {
  try { localStorage.setItem(NAY_SIZE_KEY, JSON.stringify(size)) } catch { /* ignore */ }
}

// Main component


interface TtyChatProps {
  lang: Lang
  chatModel: ChatModelId | null
  chatSoundEnabled: boolean
  chatSoundId?: string
  onModelSet: (model: ChatModelId) => void
  filters: Filters
  setFilters: React.Dispatch<React.SetStateAction<Filters>>
  isMobile?: boolean
  onPdfExport?: (range: string) => void
}

/** Parses filter query params from a nav path like /costs?projects=path1|path2 */
function parseNavFilters(path: string): { cleanPath: string; projects: string[] | null } {
  const qIdx = path.indexOf('?')
  if (qIdx === -1) return { cleanPath: path, projects: null }
  const cleanPath = path.slice(0, qIdx)
  const params = new URLSearchParams(path.slice(qIdx + 1))
  const projectsRaw = params.get('projects')
  if (!projectsRaw) return { cleanPath, projects: null }
  const projects = projectsRaw.split('|').map(p => p.trim()).filter(Boolean)
  return { cleanPath, projects: projects.length > 0 ? projects : null }
}

/** Returns true if any filter is non-default */
function hasActiveFilters(filters: Filters): boolean {
  return (
    filters.dateRange !== 'all' ||
    filters.customStart !== '' ||
    filters.customEnd !== '' ||
    filters.projects.length > 0 ||
    filters.models.length > 0
  )
}

interface PendingNavigation {
  cleanPath: string
  newProjects: string[]
}

export function TtyChat({ lang, chatModel, chatSoundEnabled, chatSoundId = 'ping', onModelSet, filters, setFilters, isMobile, onPdfExport }: TtyChatProps) {
  const navigate = useNavigate()
  const [pendingNav, setPendingNav] = useState<PendingNavigation | null>(null)

  const handleNavigate = useCallback((path: string) => {
    const { cleanPath, projects } = parseNavFilters(path)
    if (projects && projects.length > 0) {
      // Filter data in the link — check if current filters would be overwritten
      if (hasActiveFilters(filters)) {
        setPendingNav({ cleanPath, newProjects: projects })
        return
      }
      // No active filters — apply silently and navigate
      setFilters(prev => ({ ...prev, projects }))
      navigate(cleanPath)
      setOpen(false)
      return
    }
    navigate(cleanPath)
    setOpen(false)
  }, [navigate, filters, setFilters])

  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasUnread, setHasUnread] = useState(false)
  const [currentTools, setCurrentTools] = useState<string[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [historyList, setHistoryList] = useState<NaySessionSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [nayThinking, setNayThinking] = useState<ThinkingBudget>(false)
  const [showNayModelPicker, setShowNayModelPicker] = useState(false)
  const { harnesses: nayBackendHarnesses, loading: nayHarnessesLoading } = useChatHarnesses()
  const [nayBackendHarnessId, setNayBackendHarnessId] = useState<string>(() => loadNayHarnessId() ?? 'claude')
  const [showNayHarnessPicker, setShowNayHarnessPicker] = useState(false)
  // Track which harness picker item is hovered for setup panel preview
  const [hoveredHarnessId, setHoveredHarnessId] = useState<string | null>(null)
  // Track which historical Nay session is being viewed (for live polling)
  const [viewedNaySessionId, setViewedNaySessionId] = useState<string | null>(null)

  const [nayAttachments, setNayAttachments] = useState<NayAttachment[]>([])
  const nayFileInputRef = useRef<HTMLInputElement>(null)

  // Nay floating window state
  const [nayDetached, setNayDetached] = useState(false)
  const [nayMinimized, setNayMinimized] = useState(false)
  const [nayFlash, setNayFlash] = useState(false)
  const [nayPos, setNayPos] = useState<{ x: number; y: number }>(() => loadNayPos())
  const [naySize, setNaySize] = useState<{ w: number; h: number }>(() => loadNaySize())
  const NAY_FAB_W = 46
  const NAY_FAB_H = 58
  const [nayFabPos, setNayFabPos] = useState<{ x: number; y: number }>(() => ({
    // Align with main FAB (right: 24) and sit clearly above it
    x: typeof window !== 'undefined' ? window.innerWidth - NAY_FAB_W - 24 : 300,
    y: typeof window !== 'undefined' ? window.innerHeight - NAY_FAB_H - 92 : 500,
  }))

  // Nay floating window refs
  const nayWindowRef = useRef<HTMLDivElement>(null)
  const nayFabRef = useRef<HTMLDivElement>(null)
  const nayDragRef = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 })
  const nayResizeRef = useRef({ active: false, startX: 0, startY: 0, origW: 0, origH: 0 })
  const nayFabDragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, origX: 0, origY: 0 })
  const nayPosRef = useRef(nayPos)
  const naySizeRef = useRef(naySize)
  const nayFabPosRef = useRef(nayFabPos)
  const nayFloatListRef = useRef<HTMLDivElement>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const openRef = useRef(open)
  const soundRef = useRef(chatSoundEnabled)
  const soundIdRef = useRef(chatSoundId)
  const audioCtxRef = useRef<AudioContext | null>(null)

  const playNotification = useCallback(() => {
    const ctx = audioCtxRef.current
    if (!ctx) return
    findChatSound(soundIdRef.current).play(ctx)
  }, [])

  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => { soundRef.current = chatSoundEnabled }, [chatSoundEnabled])
  useEffect(() => { soundIdRef.current = chatSoundId }, [chatSoundId])
  // When harness list loads, default to the best READY harness (prefer claude, else first ready)
  useEffect(() => {
    if (nayHarnessesLoading || nayBackendHarnesses.length === 0) return
    const savedId = loadNayHarnessId()
    const savedEntry = savedId ? nayBackendHarnesses.find(h => h.id === savedId) : null
    // If saved preference exists and is ready, keep it; otherwise pick best ready harness
    if (savedEntry && savedEntry.ready) {
      setNayBackendHarnessId(savedId!)
      return
    }
    const readyHarnesses = nayBackendHarnesses.filter(h => h.ready)
    const preferred = readyHarnesses.find(h => h.id === 'claude') ?? readyHarnesses[0]
    if (preferred) {
      setNayBackendHarnessId(preferred.id)
      saveNayHarnessId(preferred.id)
    }
  }, [nayHarnessesLoading, nayBackendHarnesses])
  useEffect(() => { nayPosRef.current = nayPos }, [nayPos])
  useEffect(() => { naySizeRef.current = naySize }, [naySize])
  useEffect(() => { nayFabPosRef.current = nayFabPos }, [nayFabPos])

  // Track visual viewport (keyboard-aware) for mobile panel positioning
  const [vpRect, setVpRect] = useState({ top: 0, height: typeof window !== 'undefined' ? window.innerHeight : 844 })
  useEffect(() => {
    if (!isMobile) return
    const vv = window.visualViewport
    if (!vv) return
    function update() { setVpRect({ top: Math.round(vv!.offsetTop), height: Math.round(vv!.height) }) }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [isMobile])

  // Scroll messages to bottom when viewport resizes (keyboard appears)
  useEffect(() => {
    if (!isMobile || !open) return
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [vpRect.height, isMobile, open])

  // External open trigger: dispatched by RecentSessions "Open in Nay Chat" button
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetSessionId } = (e as CustomEvent<{ sessionId?: string }>).detail

      setOpen(true)

      if (targetSessionId) {
        // Load the specific Nay session history
        setError(null)
        setHistoryLoading(true)
        fetch(`/api/nay-sessions/${targetSessionId}`)
          .then(r => r.ok ? r.json() : [])
          .then((msgs: RawSessionMessage[]) => {
            setMessages(expandHistoryBlob(msgs))
            setSessionId(targetSessionId)
          })
          .catch(() => {})
          .finally(() => setHistoryLoading(false))
      }
    }
    window.addEventListener('agentistics:open-nay-chat', handler)
    return () => window.removeEventListener('agentistics:open-nay-chat', handler)
  }, [])

  // Update browser tab title to indicate unread Nay message
  useEffect(() => {
    const BASE_TITLE = 'Agentistics'
    if (hasUnread && !open) {
      document.title = `💬 Nay · ${BASE_TITLE}`
    } else {
      document.title = BASE_TITLE
    }
    return () => { document.title = BASE_TITLE }
  }, [hasUnread, open])

  useEffect(() => {
    if (open) { setHasUnread(false); inputRef.current?.focus({ preventScroll: true }) }
  }, [open])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    if (nayFloatListRef.current) nayFloatListRef.current.scrollTop = nayFloatListRef.current.scrollHeight
  }, [messages, streaming, currentTools])

  // Poll for new messages on historical Nay sessions (real-time view)
  useEffect(() => {
    if (!viewedNaySessionId || streaming) return
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/nay-sessions/${viewedNaySessionId}`)
        if (!res.ok) return
        const fresh: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number; tools?: string[] }> = await res.json()
        setMessages(prev => fresh.length > prev.length ? fresh.map(m => ({ ...m, terminal: false })) : prev)
      } catch { /* ignore */ }
    }, 3000)
    return () => clearInterval(id)
  }, [viewedNaySessionId, streaming])

  const openHistory = async () => {
    setShowHistory(true)
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/nay-sessions')
      if (res.ok) setHistoryList(await res.json() as NaySessionSummary[])
    } catch { /* ignore */ }
    finally { setHistoryLoading(false) }
  }

  const restoreConversation = async (id: string) => {
    setShowHistory(false)
    setError(null)
    setHistoryLoading(true)
    try {
      const res = await fetch(`/api/nay-sessions/${id}`)
      if (res.ok) {
        const msgs = await res.json() as RawSessionMessage[]
        setMessages(expandHistoryBlob(msgs))
        setSessionId(id)   // use --resume for next messages to avoid re-sending history as blob
        setViewedNaySessionId(id)
      }
    } catch { /* ignore */ }
    finally { setHistoryLoading(false) }
  }

  const newConversation = () => {
    setMessages([])
    setSessionId(null)
    setError(null)
    setShowHistory(false)
    setViewedNaySessionId(null)
  }

  const initAudio = () => {
    if (!audioCtxRef.current) {
      try { audioCtxRef.current = new AudioContext() } catch { /* ignore */ }
    }
    // Resume during user gesture so background playback works without further gestures
    audioCtxRef.current?.resume().catch(() => { /* ignore */ })
  }

  const handleFabClick = () => {
    initAudio()
    // When Nay is detached: main FAB only manages the panel (Claude tab).
    // Restoring minimized Nay is the mini FAB's job.
    setOpen(v => !v)
  }

  // Nay floating window drag/resize handlers

  const onNayHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    nayDragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: nayPosRef.current.x,
      origY: nayPosRef.current.y,
    }
    const onMouseMove = (ev: MouseEvent) => {
      if (!nayDragRef.current.active) return
      const dx = ev.clientX - nayDragRef.current.startX
      const dy = ev.clientY - nayDragRef.current.startY
      const newX = Math.max(0, Math.min(window.innerWidth - naySizeRef.current.w, nayDragRef.current.origX + dx))
      const newY = Math.max(0, Math.min(window.innerHeight - 60, nayDragRef.current.origY + dy))
      nayPosRef.current = { x: newX, y: newY }
      if (nayWindowRef.current) {
        nayWindowRef.current.style.left = `${newX}px`
        nayWindowRef.current.style.top = `${newY}px`
      }
    }
    const onMouseUp = () => {
      nayDragRef.current.active = false
      setNayPos({ ...nayPosRef.current })
      saveNayPos(nayPosRef.current)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const onNayResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    nayResizeRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origW: naySizeRef.current.w,
      origH: naySizeRef.current.h,
    }
    const onMouseMove = (ev: MouseEvent) => {
      if (!nayResizeRef.current.active) return
      const dx = ev.clientX - nayResizeRef.current.startX
      const dy = ev.clientY - nayResizeRef.current.startY
      const newW = Math.max(360, nayResizeRef.current.origW + dx)
      const newH = Math.max(400, nayResizeRef.current.origH + dy)
      naySizeRef.current = { w: newW, h: newH }
      if (nayWindowRef.current) {
        nayWindowRef.current.style.width = `${newW}px`
        nayWindowRef.current.style.height = `${newH}px`
      }
    }
    const onMouseUp = () => {
      nayResizeRef.current.active = false
      setNaySize({ ...naySizeRef.current })
      saveNaySize(naySizeRef.current)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const onNayFabMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    nayFabDragRef.current = {
      active: true, moved: false,
      startX: e.clientX, startY: e.clientY,
      origX: nayFabPosRef.current.x, origY: nayFabPosRef.current.y,
    }
    const onMouseMove = (ev: MouseEvent) => {
      if (!nayFabDragRef.current.active) return
      const dx = ev.clientX - nayFabDragRef.current.startX
      const dy = ev.clientY - nayFabDragRef.current.startY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) nayFabDragRef.current.moved = true
      const newX = Math.max(0, Math.min(window.innerWidth - NAY_FAB_W, nayFabDragRef.current.origX + dx))
      const newY = Math.max(0, Math.min(window.innerHeight - NAY_FAB_H, nayFabDragRef.current.origY + dy))
      nayFabPosRef.current = { x: newX, y: newY }
      if (nayFabRef.current) {
        nayFabRef.current.style.left = `${newX}px`
        nayFabRef.current.style.top = `${newY}px`
      }
    }
    const onMouseUp = () => {
      nayFabDragRef.current.active = false
      setNayFabPos({ ...nayFabPosRef.current })
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const handleNayPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
    if (!imageItem) return
    e.preventDefault()
    const blob = imageItem.getAsFile()
    if (!blob) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      setNayAttachments(prev => [...prev, {
        id: crypto.randomUUID(),
        name: `screenshot.${imageItem.type.split('/')[1] ?? 'png'}`,
        mimeType: imageItem.type,
        data: dataUrl.split(',')[1]!,
        isImage: true,
        preview: dataUrl,
      }])
    }
    reader.readAsDataURL(blob)
  }, [])

  const handleNayFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    for (const file of Array.from(e.target.files ?? [])) {
      const reader = new FileReader()
      if (file.type.startsWith('image/')) {
        reader.onload = ev => {
          const dataUrl = ev.target?.result as string
          setNayAttachments(prev => [...prev, {
            id: crypto.randomUUID(), name: file.name, mimeType: file.type,
            data: dataUrl.split(',')[1]!, isImage: true, preview: dataUrl,
          }])
        }
        reader.readAsDataURL(file)
      } else {
        reader.onload = ev => {
          setNayAttachments(prev => [...prev, {
            id: crypto.randomUUID(), name: file.name, mimeType: file.type || 'text/plain',
            data: ev.target?.result as string, isImage: false,
          }])
        }
        reader.readAsText(file)
      }
    }
    e.target.value = ''
  }, [])

  const execCmd = useCallback(async (command: string) => {
    const cmdMsg: ChatMessage = { role: 'user', content: `$ ${command}`, terminal: false, timestamp: Date.now() }
    setMessages(prev => {
      const outMsg: ChatMessage = { role: 'assistant', content: '', terminal: true, timestamp: Date.now() }
      return [...prev, cmdMsg, outMsg]
    })
    setStreaming(true)

    let accum = ''

    try {
      const res = await fetch('/api/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const ev = JSON.parse(line) as { text?: string; exitCode?: number; done?: boolean; error?: string }
            if (ev.error) { setError(ev.error); break }
            if (ev.text) {
              accum += ev.text
              setMessages(prev => {
                const copy = [...prev]
                const last = copy[copy.length - 1]
                if (last?.terminal) copy[copy.length - 1] = { ...last, content: accum }
                return copy
              })
            }
            if (ev.done) {
              setMessages(prev => {
                const copy = [...prev]
                const last = copy[copy.length - 1]
                if (last?.terminal) copy[copy.length - 1] = { ...last, content: accum, exitCode: ev.exitCode ?? 0 }
                return copy
              })
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStreaming(false)
    }
  }, [])

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    const hasAttachments = nayAttachments.length > 0
    if ((!text && !hasAttachments) || streaming) return
    if (!overrideText) {
      setInput('')
      if (inputRef.current) inputRef.current.style.height = 'auto'
    }
    setError(null)
    setCurrentTools([])
    setShowHistory(false)
    setViewedNaySessionId(null) // user is now in live chat mode, stop polling historical session

    if (text.startsWith('!') && text.length > 1) {
      await execCmd(text.slice(1).trimStart())
      return
    }

    const pendingAttachments = nayAttachments
    setNayAttachments([])

    // Resolve effective model for the chosen backend harness
    const currentHarness = nayBackendHarnesses.find(h => h.id === nayBackendHarnessId)
    const harnessModels = currentHarness?.models ?? []
    const model = (chatModel && harnessModels.some(m => m.id === chatModel))
      ? chatModel
      : (currentHarness?.defaultModel ?? chatModel ?? DEFAULT_CHAT_MODEL)
    const userMsg: ChatMessage = {
      role: 'user', content: text, timestamp: Date.now(),
      images: pendingAttachments.filter(a => a.isImage).map(a => a.preview!),
      files: pendingAttachments.filter(a => !a.isImage).map(a => a.name),
    }
    const history = messages.filter(m => !m.terminal).map(m => ({ role: m.role, content: m.content }))

    setMessages(prev => [
      ...prev,
      userMsg,
      { role: 'assistant', content: '', timestamp: Date.now() },
    ])
    setStreaming(true)
    const abortCtrl = new AbortController()
    abortRef.current = abortCtrl

    let accum = ''
    let toolsAccum: string[] = []

    try {
      const res = await fetch('/api/chat-tty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          message: text, history, model, sessionId,
          harness: nayBackendHarnessId !== 'claude' ? nayBackendHarnessId : undefined,
          thinkingBudget: nayThinking || undefined,
          attachments: pendingAttachments.length > 0
            ? pendingAttachments.map(a => ({ name: a.name, mimeType: a.mimeType, data: a.data, isImage: a.isImage }))
            : undefined,
        }),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim()
          if (!line) continue
          try {
            const ev = JSON.parse(line) as { text?: string; tool?: string; done?: boolean; error?: string; sessionId?: string }
            if (ev.sessionId) setSessionId(ev.sessionId)
            if (ev.error) { setError(ev.error); setStreaming(false); return }
            if (ev.tool) {
              toolsAccum = [...toolsAccum, ev.tool]
              setCurrentTools(toolsAccum)
            }
            if (ev.text) {
              accum += ev.text
              setMessages(prev => {
                const copy = [...prev]
                const last = copy[copy.length - 1]
                if (last?.role === 'assistant' && !last.terminal) {
                  copy[copy.length - 1] = { ...last, content: accum }
                }
                return copy
              })
            }
            if (ev.done) {
              setMessages(prev => {
                const copy = [...prev]
                const last = copy[copy.length - 1]
                if (last?.role === 'assistant' && !last.terminal) {
                  copy[copy.length - 1] = { ...last, content: accum, tools: toolsAccum.length > 0 ? toolsAccum : undefined }
                }
                return copy
              })
              setCurrentTools([])
              setStreaming(false)
              if (!openRef.current) {
                setHasUnread(true)
                if (soundRef.current) playNotification()
              }
              return
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStreaming(false)
      setCurrentTools([])
    }
  }, [input, streaming, messages, chatModel, sessionId, execCmd, playNotification, nayAttachments, nayBackendHarnessId, nayBackendHarnesses]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mobile: Enter = newline, send button sends. Desktop: Enter sends, Shift+Enter = newline.
    if (!isMobile && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const clearChat = () => { setMessages([]); setSessionId(null); setError(null); setStreaming(false); setHasUnread(false); setCurrentTools([]) }

  const stopStreaming = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setCurrentTools([])
    // Finalise the last assistant message with whatever was accumulated
    setMessages(prev => {
      const copy = [...prev]
      const last = copy[copy.length - 1]
      if (last?.role === 'assistant' && !last.terminal && last.content === '') {
        copy.pop() // remove empty placeholder
      }
      return copy
    })
  }

  const pt = lang === 'pt'
  const effectiveModel = chatModel ?? DEFAULT_CHAT_MODEL
  const modelInfo = CHAT_MODELS.find(m => m.id === effectiveModel)

  // Nay backend harness helpers
  const nayBackendHarness: HarnessChatStatus | null = nayBackendHarnesses.find(h => h.id === nayBackendHarnessId) ?? null
  // When harness info is loaded, use its models; otherwise fall back to CHAT_MODELS (claude)
  const nayHarnessModels = nayBackendHarness?.models ?? CHAT_MODELS.map(m => ({ id: m.id, label: m.label, badge: m.badge }))
  const nayEffectiveModel = (chatModel && nayHarnessModels.some(m => m.id === chatModel)) ? chatModel : (nayBackendHarness?.defaultModel ?? effectiveModel)
  const nayModelInfo = nayHarnessModels.find(m => m.id === nayEffectiveModel) ?? CHAT_MODELS.find(m => m.id === nayEffectiveModel)
  // Total harnesses count (all, not just ready) — show selector when >1 known harness
  const totalHarnessCount = nayBackendHarnesses.length
  // For the error panel: active harness's setup info (for runtime-error "How to fix" guidance)
  const activeHarnessForError: HarnessChatStatus | null = nayBackendHarness

  const panelStyle: React.CSSProperties = isMobile
    ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, width: 'auto', height: 'auto' }
    : fullscreen
      ? { position: 'fixed', inset: 16, width: 'auto', height: 'auto' }
      : { position: 'fixed', bottom: 80, right: 24, width: 400, height: 580, maxHeight: 'calc(100vh - 120px)' }

  // Detect if currently streaming an assistant message (last message is empty assistant waiting)
  const lastMsg = messages[messages.length - 1]
  const isAssistantStreaming = streaming && lastMsg?.role === 'assistant' && !lastMsg.terminal

  // Show confirm buttons if last completed assistant message looks like a permission request
  const lastCompletedAssistant = !streaming
    ? [...messages].reverse().find(m => m.role === 'assistant' && !m.terminal && m.content)
    : undefined
  const showConfirmBar = !!lastCompletedAssistant && looksLikeConfirmRequest(lastCompletedAssistant.content)

  return (
    <>
      <style>{`
        @keyframes ttyChatSpin    { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes ttyChatFadeIn  { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
        @keyframes ttyChatSlideIn { from{opacity:0;transform:translateX(18px)} to{opacity:1;transform:none} }
        @keyframes ttyChatBlink   { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes ttyChatPulse   { 0%,100%{box-shadow:0 4px 18px rgba(0,0,0,0.35),0 0 0 0 rgba(245,158,11,0.5)} 50%{box-shadow:0 4px 18px rgba(0,0,0,0.35),0 0 0 8px rgba(245,158,11,0)} }
        @keyframes ttyChatFlash   { 0%,100%{box-shadow:0 10px 48px rgba(0,0,0,0.45)} 30%{box-shadow:0 0 0 4px rgba(245,158,11,0.6),0 10px 48px rgba(0,0,0,0.45)} }
        @media (hover: hover) {
          .tty-fab:hover { border-color: var(--accent-purple) !important; color: var(--accent-purple) !important; }
          .tty-icon-btn:hover { color: var(--text-primary) !important; border-color: var(--text-secondary) !important; }
          .tty-send-btn:hover:not(:disabled) { background: var(--accent-purple) !important; color: #fff !important; }
        }
        .tty-send-btn:active:not(:disabled) { background: var(--accent-purple) !important; color: #fff !important; }
        .tty-nay-header { cursor: grab; user-select: none; }
        .tty-nay-header:active { cursor: grabbing; }
      `}</style>

      {/* FAB */}
      <button
        className="tty-fab"
        onClick={handleFabClick}
        title={nayDetached
          ? (pt ? 'Abrir painel' : 'Open panel')
          : (pt ? 'Chat com Nay' : 'Chat with Nay')}
        style={{
          // Sits above the mobile nav, whose height grows by the home-indicator inset in a PWA.
          position: 'fixed', bottom: isMobile ? 'calc(12px + var(--mobile-nav-h))' : 24, right: 24, zIndex: 300,
          width: 46, height: 46, borderRadius: '50%',
          border: nayDetached
            ? '1.5px solid var(--border)'
            : (hasUnread && !open) || open ? '1.5px solid var(--accent-purple)' : '1.5px solid var(--border)',
          background: nayDetached
            ? 'var(--bg-card)'
            : (hasUnread && !open) || open ? 'color-mix(in srgb, var(--accent-purple) 12%, transparent)' : 'var(--bg-card)',
          color: (!nayDetached && (hasUnread || open)) ? 'var(--accent-purple)' : 'var(--text-secondary)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: (hasUnread && !open && !nayDetached) ? 'ttyChatPulse 1.8s ease-in-out infinite' : undefined,
          transition: 'all 0.2s',
          overflow: 'hidden',
          padding: 0,
        }}
      >
        {open && !nayDetached ? <X size={17} /> : nayDetached ? <ExternalLink size={15} /> : <MessageSquare size={17} />}
        {!open && hasUnread && !nayDetached && (
          <span style={{
            position: 'absolute', top: 8, right: 8,
            width: 9, height: 9, borderRadius: '50%',
            background: 'var(--accent-purple)',
            border: '1.5px solid var(--bg-base)',
            animation: 'ttyChatBlink 1.8s ease-in-out infinite',
          }} />
        )}
      </button>

      {/* Panel */}
      {open && !nayDetached && (
        <div style={{
          ...panelStyle,
          zIndex: 400,
          position: 'fixed',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-surface)',
          border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 14,
          boxShadow: isMobile ? 'none' : '0 10px 48px rgba(0,0,0,0.45)',
          overflow: 'hidden',
          animation: isMobile ? undefined : 'ttyChatSlideIn 0.18s ease-out',
        }}>

          {chatModel === null && (
            <ModelPicker lang={lang} onPick={onModelSet} />
          )}

          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', borderBottom: '1px solid var(--border)',
            background: 'var(--bg-card)', flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8, overflow: 'hidden', flexShrink: 0,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <img src={versionedAsset('/minimalistLogo.png')} alt="Nay" style={{ width: 22, height: 22, objectFit: 'contain' }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                  Nay
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {streaming ? (
                    <span style={{ color: 'var(--accent-purple)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Loader size={8} style={{ animation: 'ttyChatSpin 1s linear infinite' }} />
                      {currentTools.length > 0
                        ? formatToolName(currentTools[currentTools.length - 1]!)
                        : (pt ? 'pensando...' : 'thinking...')}
                    </span>
                  ) : (
                    <>
                      {nayBackendHarnesses.length > 1 && nayBackendHarness && (
                        <span style={{
                          fontSize: 9, color: nayBackendHarnessId !== 'claude' ? HARNESS_COLORS[nayBackendHarnessId as HarnessId] ?? 'var(--text-tertiary)' : 'var(--anthropic-orange)',
                          fontWeight: 700,
                        }}>
                          {nayBackendHarness.label}·
                        </span>
                      )}
                      <span>{nayModelInfo?.label ?? nayEffectiveModel}</span>
                      {nayModelInfo?.badge && (
                        <span style={{
                          fontSize: 9, fontWeight: 700,
                          color: BADGE_COLORS[nayModelInfo.badge] ?? 'var(--text-tertiary)',
                          background: `color-mix(in srgb, ${BADGE_COLORS[nayModelInfo.badge] ?? 'var(--text-tertiary)'} 12%, transparent)`,
                          border: `1px solid color-mix(in srgb, ${BADGE_COLORS[nayModelInfo.badge] ?? 'var(--text-tertiary)'} 25%, transparent)`,
                          padding: '0px 4px', borderRadius: 3,
                        }}>
                          {nayModelInfo.badge}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {messages.length > 0 && (
                <button className="tty-icon-btn" onClick={clearChat} title={pt ? 'Nova conversa' : 'New conversation'} style={iconBtnStyle}>
                  <Plus size={12} />
                </button>
              )}
              {!nayDetached && !isMobile && (
                <button
                  className="tty-icon-btn"
                  onClick={() => {
                    setNayDetached(true)
                    setNayMinimized(false)
                  }}
                  title={pt ? 'Destacar janela Nay' : 'Detach Nay window'}
                  style={iconBtnStyle}
                >
                  <ExternalLink size={12} />
                </button>
              )}
              <button
                className="tty-icon-btn"
                onClick={openHistory}
                title={pt ? 'Histórico de conversas' : 'Conversation history'}
                style={{ ...iconBtnStyle, color: showHistory ? 'var(--accent-purple)' : 'var(--text-secondary)' }}
              >
                <History size={12} />
              </button>
              <button
                className="tty-icon-btn"
                onClick={() => setFullscreen(v => !v)}
                title={fullscreen ? (pt ? 'Restaurar' : 'Restore') : (pt ? 'Tela cheia' : 'Fullscreen')}
                style={iconBtnStyle}
              >
                {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              <button className="tty-icon-btn" onClick={() => setOpen(false)} title={pt ? 'Fechar' : 'Close'} style={iconBtnStyle}>
                <X size={12} />
              </button>
            </div>
          </div>

          {<>

          {/* History panel */}
          {showHistory && (
            <div style={{
              position: 'absolute', inset: 0, top: 52, zIndex: 10,
              background: 'var(--bg-surface)',
              display: 'flex', flexDirection: 'column',
              borderTop: '1px solid var(--border)',
              animation: 'ttyChatFadeIn 0.15s ease-out',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', borderBottom: '1px solid var(--border)',
                background: 'var(--bg-card)', flexShrink: 0,
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <History size={12} style={{ color: 'var(--accent-purple)' }} />
                  {pt ? 'Histórico' : 'History'}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={newConversation}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 6,
                      border: '1px solid color-mix(in srgb, var(--accent-purple) 60%, transparent)',
                      background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', color: 'var(--accent-purple)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <Plus size={10} />
                    {pt ? 'Nova' : 'New'}
                  </button>
                  <button onClick={() => setShowHistory(false)} className="tty-icon-btn" style={iconBtnStyle}>
                    <X size={12} />
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
                {historyLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
                    <Loader size={16} style={{ animation: 'ttyChatSpin 1s linear infinite' }} />
                  </div>
                ) : historyList.length === 0 ? (
                  <div style={{
                    height: '100%', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    color: 'var(--text-tertiary)', fontSize: 12, gap: 6,
                  }}>
                    <History size={28} style={{ opacity: 0.2 }} />
                    {pt ? 'Nenhuma conversa ainda' : 'No conversations yet'}
                  </div>
                ) : historyList.map(convo => (
                  <div
                    key={convo.id}
                    onClick={() => restoreConversation(convo.id)}
                    style={{
                      padding: '9px 10px', borderRadius: 8, marginBottom: 4,
                      cursor: 'pointer',
                      background: convo.id === sessionId ? 'color-mix(in srgb, var(--accent-purple) 12%, transparent)' : 'var(--bg-card)',
                      border: convo.id === sessionId ? '1px solid color-mix(in srgb, var(--accent-purple) 40%, transparent)' : '1px solid var(--border)',
                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
                      transition: 'background 0.12s',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        lineHeight: 1.4,
                      }}>
                        {convo.title}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3, display: 'flex', gap: 6 }}>
                        <span>{new Date(convo.updatedAt).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: 'short' })}</span>
                        <span>·</span>
                        <span>{convo.messageCount} {pt ? 'msgs' : 'msgs'}</span>
                        {convo.model && (
                          <>
                            <span>·</span>
                            <span>{CHAT_MODELS.find(m => m.id === convo.model)?.label ?? convo.model}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Streaming context bar — shows the last user message while assistant is responding */}
          {streaming && (() => {
            const lastUser = [...messages].reverse().find(m => m.role === 'user' && !m.terminal)
            if (!lastUser) return null
            const preview = lastUser.content.length > 120
              ? lastUser.content.slice(0, 120) + '…'
              : lastUser.content
            return (
              <div style={{
                flexShrink: 0,
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-card)',
                padding: '6px 14px',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 10, color: 'var(--accent-purple)', fontWeight: 700, flexShrink: 0 }}>↑</span>
                {lastUser.images && lastUser.images.length > 0 && (
                  <img src={lastUser.images[0]} alt=""
                    style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
                )}
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {preview || (lastUser.images?.length ? '[image]' : '')}
                </span>
              </div>
            )
          })()}

          {/* Messages */}
          <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 14px 6px' }}>
            {messages.length === 0 && !streaming && (
              <div style={{
                height: '100%', display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                gap: 10, color: 'var(--text-tertiary)', textAlign: 'center', padding: '0 20px',
              }}>
                <img src={versionedAsset('/minimalistLogo.png')} alt="Nay" style={{ width: 36, height: 36, objectFit: 'contain', opacity: 0.3 }} />
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {pt ? 'Olá! Sou a Nay' : 'Hi! I\'m Nay'}
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.65, opacity: 0.7, maxWidth: 220 }}>
                  {pt
                    ? 'Agente de analytics com acesso direto ao dashboard — custos, sessões, projetos e layouts personalizados.'
                    : 'Analytics agent with direct dashboard access — costs, sessions, projects and custom layouts.'}
                </div>
                <div style={{
                  marginTop: 4, background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)', borderRadius: 8,
                  padding: '8px 12px', fontSize: 11, color: 'var(--text-tertiary)',
                  textAlign: 'left', lineHeight: 1.8,
                }}>
                  <code style={{ color: 'var(--accent-green)' }}>!ls -la</code>{' '}
                  {pt ? '— executa comando' : '— run a command'}<br />
                  <code style={{ color: 'var(--accent-green)' }}>!pwd</code>{' '}
                  {pt ? '— atalho bash' : '— bash shortcut'}
                </div>
              </div>
            )}

            {messages.map((msg, i) => {
              const isLast = i === messages.length - 1
              return (
                <Message
                  key={i}
                  msg={msg}
                  isLiveStreaming={isLast && streaming ? true : undefined}
                  currentTools={isLast && streaming ? currentTools : undefined}
                  onRun={execCmd}
                  onNavigate={handleNavigate}
                  onPdfExport={onPdfExport}
                  pt={pt}
                />
              )
            })}

            {showConfirmBar && (
              <ConfirmBar
                pt={pt}
                onConfirm={() => sendMessage(pt ? 'Sim, pode prosseguir.' : 'Yes, proceed.')}
                onCancel={() => sendMessage(pt ? 'Não, cancele.' : 'No, cancel.')}
              />
            )}

            {error && (
              <div style={{
                padding: '10px 12px', borderRadius: 8, marginBottom: 8,
                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                fontSize: 12, color: '#ef4444',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{error}</span>
                </div>
                {activeHarnessForError && (
                  <HarnessErrorHelp harness={activeHarnessForError} />
                )}
              </div>
            )}
          </div>

          {/* Input area */}
          <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-card)', flexShrink: 0, position: 'relative', zIndex: 30 }}>
            {/* Attachment strip */}
            {nayAttachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '6px 12px 0' }}>
                {nayAttachments.map(att => (
                  <div key={att.id} style={{ position: 'relative', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden', background: 'var(--bg-elevated)' }}>
                    {att.isImage ? (
                      <img src={att.preview} alt={att.name} style={{ width: 52, height: 52, objectFit: 'cover', display: 'block' }} />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', maxWidth: 120 }}>
                        <FileTextIcon size={12} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />
                        <span style={{ fontSize: 10, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                      </div>
                    )}
                    <button onMouseDown={e => { e.preventDefault(); setNayAttachments(prev => prev.filter(a => a.id !== att.id)) }}
                      style={{ position: 'absolute', top: 2, right: 2, width: 14, height: 14, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', padding: 0 }}>
                      <X size={8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input ref={nayFileInputRef} type="file" multiple accept="image/*,text/*,.md,.json,.ts,.js,.py,.txt,.csv" onChange={handleNayFileSelect} style={{ display: 'none' }} />

          {/* Nay toolbar: thinking + harness selector + model picker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px 0', justifyContent: 'flex-end', flexWrap: 'wrap', overflow: 'hidden' }}>
            {/* Thinking toggle */}
            <button
              className="tty-icon-btn"
              onClick={() => setNayThinking(prev => nextThinkingBudget(prev))}
              title={nayThinking ? `Extended thinking: ${thinkingLabel(nayThinking)} tokens` : 'Enable extended thinking'}
              style={{
                ...iconBtnStyle,
                color: nayThinking ? 'var(--accent-purple)' : 'var(--text-tertiary)',
                borderColor: nayThinking ? 'color-mix(in srgb, var(--accent-purple) 40%, transparent)' : 'var(--border)',
                background: nayThinking ? 'color-mix(in srgb, var(--accent-purple) 10%, transparent)' : 'transparent',
                width: nayThinking ? 'auto' : 28, padding: nayThinking ? '0 6px' : 0, gap: 4, minWidth: 28,
              }}
            >
              <Brain size={11} />
              {nayThinking && <span style={{ fontSize: 9, fontWeight: 700 }}>{thinkingLabel(nayThinking)}</span>}
            </button>

            {/* Harness selector — shown when >1 harness known (including not-ready ones) */}
            {totalHarnessCount > 1 && (
              <div style={{ position: 'relative' }}>
                <button
                  className="tty-icon-btn"
                  onClick={() => { setShowNayHarnessPicker(v => !v); setShowNayModelPicker(false) }}
                  title="Change backend"
                  style={{ ...iconBtnStyle, width: 'auto', padding: '0 6px', gap: 4, fontSize: 10,
                    color: nayBackendHarnessId !== 'claude' ? HARNESS_COLORS[nayBackendHarnessId as HarnessId] ?? 'var(--text-secondary)' : 'var(--text-secondary)' }}
                >
                  {nayBackendHarness && !nayBackendHarness.ready && (
                    <AlertTriangle size={9} style={{ color: 'var(--accent-orange)' }} />
                  )}
                  <span style={{ maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nayBackendHarness?.label ?? nayBackendHarnessId}</span>
                  <ChevronDown size={9} />
                </button>
                {showNayHarnessPicker && (
                  <div style={{
                    position: 'absolute', bottom: 'calc(100% + 4px)', right: 0, zIndex: 50, minWidth: 200,
                    background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.3)', overflow: 'hidden',
                  }}>
                    {nayBackendHarnesses.map(h => {
                      const active = nayBackendHarnessId === h.id
                      const hColor = h.id === 'claude' ? 'var(--anthropic-orange)' : (HARNESS_COLORS[h.id as HarnessId] ?? 'var(--text-secondary)')
                      const isHovered = hoveredHarnessId === h.id
                      return (
                        <div key={h.id}>
                          <button className="tty-icon-btn"
                            onClick={() => {
                              setNayBackendHarnessId(h.id)
                              saveNayHarnessId(h.id)
                              if (h.ready) onModelSet(h.defaultModel as ChatModelId)
                              setShowNayHarnessPicker(false)
                            }}
                            onMouseEnter={() => setHoveredHarnessId(h.id)}
                            onMouseLeave={() => setHoveredHarnessId(null)}
                            style={{
                              width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                              background: active ? 'var(--bg-elevated)' : 'transparent', border: 'none',
                              cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                              borderBottom: isHovered && !h.ready ? 'none' : '1px solid var(--border)',
                              transition: 'background 0.1s',
                              borderRadius: 0,
                            }}>
                            {h.ready
                              ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: hColor, flexShrink: 0 }} />
                              : <AlertTriangle size={9} style={{ color: 'var(--accent-orange)', flexShrink: 0 }} />
                            }
                            <span style={{ flex: 1, fontSize: 12, fontWeight: active ? 700 : 400, color: active ? 'var(--text-primary)' : h.ready ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>{h.label}</span>
                            {!h.ready && (
                              <span style={{ fontSize: 9, color: 'var(--accent-orange)', flexShrink: 0 }}>
                                {!h.installed ? 'not installed' : 'not authed'}
                              </span>
                            )}
                          </button>
                          {/* Setup guidance shown when hovered and not ready */}
                          {isHovered && !h.ready && (
                            <div style={{ padding: '0 10px 8px', borderBottom: '1px solid var(--border)' }}>
                              <HarnessSetupPanel harness={h} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Model picker */}
            <div style={{ position: 'relative' }}>
              <button
                className="tty-icon-btn"
                onClick={() => { setShowNayModelPicker(v => !v); setShowNayHarnessPicker(false) }}
                title="Change model"
                style={{ ...iconBtnStyle, width: 'auto', padding: '0 6px', gap: 4, fontSize: 10, maxWidth: isMobile ? 140 : 'none' }}
              >
                <span style={{ maxWidth: isMobile ? 110 : 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nayModelInfo?.label ?? nayEffectiveModel}</span>
                <ChevronDown size={9} />
              </button>
              {showNayModelPicker && (
                <div style={{
                  position: 'absolute', bottom: 'calc(100% + 4px)', right: 0, zIndex: 50, minWidth: 180,
                  background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.3)', overflow: 'hidden',
                }}>
                  {nayHarnessModels.map(m => {
                    const active = nayEffectiveModel === m.id
                    const badgeColor = m.badge ? (BADGE_COLORS[m.badge] ?? 'var(--text-tertiary)') : 'var(--text-tertiary)'
                    return (
                      <button key={m.id} className="tty-icon-btn"
                        onClick={() => { onModelSet(m.id as ChatModelId); setShowNayModelPicker(false) }}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                          background: active ? 'var(--bg-elevated)' : 'transparent', border: 'none',
                          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                          borderBottom: '1px solid var(--border)', transition: 'background 0.1s',
                          borderRadius: 0,
                        }}>
                        <span style={{ flex: 1, fontSize: 12, fontWeight: active ? 700 : 400, color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{m.label}</span>
                        {m.badge && (
                          <span style={{ fontSize: 9, fontWeight: 700, color: badgeColor,
                            background: `color-mix(in srgb, ${badgeColor} 12%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${badgeColor} 30%, transparent)`,
                            padding: '1px 5px', borderRadius: 3 }}>{m.badge}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Show setup panel inline when selected backend is not installed */}
          {nayBackendHarness && !nayBackendHarness.installed && (
            <div style={{ padding: '0 12px 8px' }}>
              <HarnessSetupPanel harness={nayBackendHarness} />
            </div>
          )}
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <button className="tty-icon-btn" onClick={() => nayFileInputRef.current?.click()} title={pt ? 'Anexar arquivo' : 'Attach file'} style={{ ...iconBtnStyle, flexShrink: 0, width: 30, height: 30, alignSelf: 'flex-end', marginBottom: 1 }}>
              <Paperclip size={12} />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handleNayPaste}
              placeholder={pt ? 'Pergunte algo...' : 'Ask something...'}
              rows={1}
              disabled={streaming || chatModel === null || nayBackendHarness?.installed === false}
              style={{
                flex: 1, resize: 'none',
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '8px 10px', fontSize: isMobile ? 16 : 13, fontFamily: 'inherit',
                color: 'var(--text-primary)', outline: 'none', lineHeight: 1.5,
                maxHeight: isMobile ? 80 : 120, overflowY: 'auto', transition: 'border-color 0.15s',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent-purple) 60%, transparent)' }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
              onInput={e => {
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, isMobile ? 80 : 120)}px`
              }}
            />
            {streaming ? (
              <button
                onClick={stopStreaming}
                title={pt ? 'Cancelar' : 'Stop'}
                style={{
                  width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                  border: '1px solid rgba(239,68,68,0.4)',
                  background: 'rgba(239,68,68,0.1)', color: '#ef4444',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.15s',
                }}
              >
                <X size={14} />
              </button>
            ) : (
              <button
                className="tty-send-btn"
                onClick={() => sendMessage()}
                disabled={(!input.trim() && nayAttachments.length === 0) || chatModel === null || nayBackendHarness?.installed === false}
                title={pt ? 'Enviar (Enter)' : 'Send (Enter)'}
                style={{
                  width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                  border: '1px solid color-mix(in srgb, var(--accent-purple) 60%, transparent)',
                  background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', color: 'var(--accent-purple)',
                  cursor: (input.trim() || nayAttachments.length > 0) ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: (input.trim() || nayAttachments.length > 0) && chatModel !== null ? 1 : 0.4,
                  transition: 'all 0.15s',
                }}
              >
                {input.trim().startsWith('!') && input.trim().length > 1 ? <Play size={14} /> : <Send size={14} />}
              </button>
            )}
          </div>
          </div>

          </>}

        </div>
      )}

      {/* Nay floating window — minimized FAB */}
      {nayDetached && nayMinimized && (
        <div
          ref={nayFabRef}
          onMouseDown={onNayFabMouseDown}
          onClick={() => {
            if (nayFabDragRef.current.moved) { nayFabDragRef.current.moved = false; return }
            setNayMinimized(false)
          }}
          style={{
            position: 'fixed',
            left: nayFabPos.x,
            top: nayFabPos.y,
            zIndex: 551,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            cursor: 'grab', userSelect: 'none',
          }}
        >
          <div style={{
            width: NAY_FAB_W, height: NAY_FAB_W, borderRadius: '50%',
            border: '1.5px solid var(--accent-purple)',
            background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', pointerEvents: 'none',
          }}>
            <img src={versionedAsset('/minimalistLogo.png')} alt="Nay" style={{ width: 26, height: 26, objectFit: 'contain' }} />
          </div>
          <span style={{ fontSize: 9, color: 'var(--text-tertiary)', lineHeight: 1, pointerEvents: 'none' }}>Nay</span>
        </div>
      )}

      {/* Nay floating window */}
      {nayDetached && !nayMinimized && (
        <div
          ref={nayWindowRef}
          style={{
            position: 'fixed',
            left: nayPos.x,
            top: nayPos.y,
            width: naySize.w,
            height: naySize.h,
            zIndex: 551,
            display: 'flex', flexDirection: 'column',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            boxShadow: '0 10px 48px rgba(0,0,0,0.45)',
            overflow: 'hidden',
            animation: nayFlash ? 'ttyChatFlash 0.6s ease-out' : 'ttyChatSlideIn 0.18s ease-out',
          }}
        >
          {/* Floating header — drag handle */}
          <div
            className="tty-nay-header"
            onMouseDown={onNayHeaderMouseDown}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderBottom: '1px solid var(--border)',
              background: 'var(--bg-card)', flexShrink: 0,
              cursor: 'grab', userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8, overflow: 'hidden', flexShrink: 0,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <img src={versionedAsset('/minimalistLogo.png')} alt="Nay" style={{ width: 22, height: 22, objectFit: 'contain' }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                  Nay
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {streaming ? (
                    <span style={{ color: 'var(--accent-purple)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Loader size={8} style={{ animation: 'ttyChatSpin 1s linear infinite' }} />
                      {currentTools.length > 0
                        ? formatToolName(currentTools[currentTools.length - 1]!)
                        : (pt ? 'pensando...' : 'thinking...')}
                    </span>
                  ) : (
                    <>
                      {nayBackendHarnesses.length > 1 && nayBackendHarness && (
                        <span style={{
                          fontSize: 9, color: nayBackendHarnessId !== 'claude' ? HARNESS_COLORS[nayBackendHarnessId as HarnessId] ?? 'var(--text-tertiary)' : 'var(--anthropic-orange)',
                          fontWeight: 700,
                        }}>
                          {nayBackendHarness.label}·
                        </span>
                      )}
                      <span>{nayModelInfo?.label ?? nayEffectiveModel}</span>
                      {nayModelInfo?.badge && (
                        <span style={{
                          fontSize: 9, fontWeight: 700,
                          color: BADGE_COLORS[nayModelInfo.badge] ?? 'var(--text-tertiary)',
                          background: `color-mix(in srgb, ${BADGE_COLORS[nayModelInfo.badge] ?? 'var(--text-tertiary)'} 12%, transparent)`,
                          border: `1px solid color-mix(in srgb, ${BADGE_COLORS[nayModelInfo.badge] ?? 'var(--text-tertiary)'} 25%, transparent)`,
                          padding: '0px 4px', borderRadius: 3,
                        }}>
                          {nayModelInfo.badge}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {messages.length > 0 && (
                <button className="tty-icon-btn" onClick={clearChat} title={pt ? 'Nova conversa' : 'New conversation'} style={iconBtnStyle}>
                  <Plus size={12} />
                </button>
              )}
              <button
                className="tty-icon-btn"
                onClick={openHistory}
                title={pt ? 'Histórico de conversas' : 'Conversation history'}
                style={{ ...iconBtnStyle, color: showHistory ? 'var(--accent-purple)' : 'var(--text-secondary)' }}
              >
                <History size={12} />
              </button>
              {/* Re-attach button */}
              <button
                className="tty-icon-btn"
                onClick={() => {
                  setNayDetached(false)
                  setNayMinimized(false)
                  setOpen(true)
                }}
                title={pt ? 'Encaixar no chat' : 'Re-attach to chat'}
                style={iconBtnStyle}
              >
                <ExternalLink size={12} style={{ transform: 'scaleX(-1)' }} />
              </button>
              {/* Minimize */}
              <button
                className="tty-icon-btn"
                onClick={() => setNayMinimized(true)}
                title={pt ? 'Minimizar' : 'Minimize'}
                style={iconBtnStyle}
              >
                <Minus size={12} />
              </button>
              {/* Close → back to corner */}
              <button className="tty-icon-btn" onClick={() => { setNayDetached(false); setNayMinimized(false) }} title={pt ? 'Fechar' : 'Close'} style={iconBtnStyle}>
                <X size={12} />
              </button>
            </div>
          </div>

          {/* History panel */}
          {showHistory && (
            <div style={{
              position: 'absolute', inset: 0, top: 52, zIndex: 10,
              background: 'var(--bg-surface)',
              display: 'flex', flexDirection: 'column',
              borderTop: '1px solid var(--border)',
              animation: 'ttyChatFadeIn 0.15s ease-out',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', borderBottom: '1px solid var(--border)',
                background: 'var(--bg-card)', flexShrink: 0,
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <History size={12} style={{ color: 'var(--accent-purple)' }} />
                  {pt ? 'Histórico' : 'History'}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={newConversation}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 6,
                      border: '1px solid color-mix(in srgb, var(--accent-purple) 60%, transparent)',
                      background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', color: 'var(--accent-purple)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <Plus size={10} />
                    {pt ? 'Nova' : 'New'}
                  </button>
                  <button onClick={() => setShowHistory(false)} className="tty-icon-btn" style={iconBtnStyle}>
                    <X size={12} />
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
                {historyLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
                    <Loader size={16} style={{ animation: 'ttyChatSpin 1s linear infinite' }} />
                  </div>
                ) : historyList.length === 0 ? (
                  <div style={{
                    height: '100%', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    color: 'var(--text-tertiary)', fontSize: 12, gap: 6,
                  }}>
                    <History size={28} style={{ opacity: 0.2 }} />
                    {pt ? 'Nenhuma conversa ainda' : 'No conversations yet'}
                  </div>
                ) : historyList.map(convo => (
                  <div
                    key={convo.id}
                    onClick={() => restoreConversation(convo.id)}
                    style={{
                      padding: '9px 10px', borderRadius: 8, marginBottom: 4,
                      cursor: 'pointer',
                      background: convo.id === sessionId ? 'color-mix(in srgb, var(--accent-purple) 12%, transparent)' : 'var(--bg-card)',
                      border: convo.id === sessionId ? '1px solid color-mix(in srgb, var(--accent-purple) 40%, transparent)' : '1px solid var(--border)',
                      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
                      transition: 'background 0.12s',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        lineHeight: 1.4,
                      }}>
                        {convo.title}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3, display: 'flex', gap: 6 }}>
                        <span>{new Date(convo.updatedAt).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: 'short' })}</span>
                        <span>·</span>
                        <span>{convo.messageCount} {pt ? 'msgs' : 'msgs'}</span>
                        {convo.model && (
                          <>
                            <span>·</span>
                            <span>{CHAT_MODELS.find(m => m.id === convo.model)?.label ?? convo.model}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Streaming context bar */}
          {streaming && (() => {
            const lastUser = [...messages].reverse().find(m => m.role === 'user' && !m.terminal)
            if (!lastUser) return null
            const preview = lastUser.content.length > 120
              ? lastUser.content.slice(0, 120) + '…'
              : lastUser.content
            return (
              <div style={{
                flexShrink: 0,
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-card)',
                padding: '6px 14px',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 10, color: 'var(--accent-purple)', fontWeight: 700, flexShrink: 0 }}>↑</span>
                {lastUser.images && lastUser.images.length > 0 && (
                  <img src={lastUser.images[0]} alt=""
                    style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
                )}
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {preview || (lastUser.images?.length ? '[image]' : '')}
                </span>
              </div>
            )
          })()}

          {/* Messages */}
          <div ref={nayFloatListRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 14px 6px' }}>
            {messages.length === 0 && !streaming && (
              <div style={{
                height: '100%', display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                gap: 10, color: 'var(--text-tertiary)', textAlign: 'center', padding: '0 20px',
              }}>
                <img src={versionedAsset('/minimalistLogo.png')} alt="Nay" style={{ width: 36, height: 36, objectFit: 'contain', opacity: 0.3 }} />
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {pt ? 'Olá! Sou a Nay' : 'Hi! I\'m Nay'}
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.65, opacity: 0.7, maxWidth: 220 }}>
                  {pt
                    ? 'Agente de analytics com acesso direto ao dashboard — custos, sessões, projetos e layouts personalizados.'
                    : 'Analytics agent with direct dashboard access — costs, sessions, projects and custom layouts.'}
                </div>
                <div style={{
                  marginTop: 4, background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)', borderRadius: 8,
                  padding: '8px 12px', fontSize: 11, color: 'var(--text-tertiary)',
                  textAlign: 'left', lineHeight: 1.8,
                }}>
                  <code style={{ color: 'var(--accent-green)' }}>!ls -la</code>{' '}
                  {pt ? '— executa comando' : '— run a command'}<br />
                  <code style={{ color: 'var(--accent-green)' }}>!pwd</code>{' '}
                  {pt ? '— atalho bash' : '— bash shortcut'}
                </div>
              </div>
            )}
            {messages.map((msg, i) => {
              const isLast = i === messages.length - 1
              return (
                <Message
                  key={i}
                  msg={msg}
                  isLiveStreaming={isLast && streaming ? true : undefined}
                  currentTools={isLast && streaming ? currentTools : undefined}
                  onRun={execCmd}
                  onNavigate={handleNavigate}
                  onPdfExport={onPdfExport}
                  pt={pt}
                />
              )
            })}
            {showConfirmBar && (
              <ConfirmBar
                pt={pt}
                onConfirm={() => sendMessage(pt ? 'Sim, pode prosseguir.' : 'Yes, proceed.')}
                onCancel={() => sendMessage(pt ? 'Não, cancele.' : 'No, cancel.')}
              />
            )}
            {error && (
              <div style={{
                padding: '10px 12px', borderRadius: 8, marginBottom: 8,
                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)',
                fontSize: 12, color: '#ef4444',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{error}</span>
                </div>
                {activeHarnessForError && (
                  <HarnessErrorHelp harness={activeHarnessForError} />
                )}
              </div>
            )}
          </div>

          {/* Input area */}
          <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-card)', flexShrink: 0 }}>
            {nayAttachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '6px 12px 0' }}>
                {nayAttachments.map(att => (
                  <div key={att.id} style={{ position: 'relative', borderRadius: 6, border: '1px solid var(--border)', overflow: 'hidden', background: 'var(--bg-elevated)' }}>
                    {att.isImage ? (
                      <img src={att.preview} alt={att.name} style={{ width: 52, height: 52, objectFit: 'cover', display: 'block' }} />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', maxWidth: 120 }}>
                        <FileTextIcon size={12} style={{ color: 'var(--accent-purple)', flexShrink: 0 }} />
                        <span style={{ fontSize: 10, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                      </div>
                    )}
                    <button onMouseDown={e => { e.preventDefault(); setNayAttachments(prev => prev.filter(a => a.id !== att.id)) }}
                      style={{ position: 'absolute', top: 2, right: 2, width: 14, height: 14, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', padding: 0 }}>
                      <X size={8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Show setup panel inline when selected backend is not installed */}
            {nayBackendHarness && !nayBackendHarness.installed && (
              <div style={{ padding: '0 12px 8px' }}>
                <HarnessSetupPanel harness={nayBackendHarness} />
              </div>
            )}
            <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              <button className="tty-icon-btn" onClick={() => nayFileInputRef.current?.click()} title={pt ? 'Anexar arquivo' : 'Attach file'} style={{ ...iconBtnStyle, flexShrink: 0, width: 30, height: 30, alignSelf: 'flex-end', marginBottom: 1 }}>
                <Paperclip size={12} />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handleNayPaste}
                placeholder={pt ? 'Pergunte algo...' : 'Ask something...'}
                rows={1}
                disabled={streaming || chatModel === null || nayBackendHarness?.installed === false}
                style={{
                  flex: 1, resize: 'none',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit',
                  color: 'var(--text-primary)', outline: 'none', lineHeight: 1.5,
                  maxHeight: 120, overflowY: 'auto', transition: 'border-color 0.15s',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent-purple) 60%, transparent)' }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                onInput={e => {
                  const el = e.currentTarget
                  el.style.height = 'auto'
                  el.style.height = `${Math.min(el.scrollHeight, 120)}px`
                }}
              />
              {streaming ? (
                <button
                  onClick={stopStreaming}
                  title={pt ? 'Cancelar' : 'Stop'}
                  style={{
                    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                    border: '1px solid rgba(239,68,68,0.4)',
                    background: 'rgba(239,68,68,0.1)', color: '#ef4444',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.15s',
                  }}
                >
                  <X size={14} />
                </button>
              ) : (
                <button
                  className="tty-send-btn"
                  onClick={() => sendMessage()}
                  disabled={(!input.trim() && nayAttachments.length === 0) || chatModel === null || nayBackendHarness?.installed === false}
                  title={pt ? 'Enviar (Enter)' : 'Send (Enter)'}
                  style={{
                    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                    border: '1px solid color-mix(in srgb, var(--accent-purple) 60%, transparent)',
                    background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', color: 'var(--accent-purple)',
                    cursor: (input.trim() || nayAttachments.length > 0) ? 'pointer' : 'not-allowed',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    opacity: (input.trim() || nayAttachments.length > 0) && chatModel !== null ? 1 : 0.4,
                    transition: 'all 0.15s',
                  }}
                >
                  {input.trim().startsWith('!') && input.trim().length > 1 ? <Play size={14} /> : <Send size={14} />}
                </button>
              )}
            </div>
          </div>

          {/* Resize handle */}
          <div
            onMouseDown={onNayResizeMouseDown}
            style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 16, height: 16, cursor: 'nwse-resize',
              background: 'transparent',
            }}
          />
        </div>
      )}

      {/* Filter change confirmation dialog */}
      {pendingNav && (
        <div
          onClick={() => setPendingNav(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 600,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 14,
              padding: '22px 24px',
              width: '100%',
              maxWidth: 360,
              boxShadow: '0 8px 40px rgba(0,0,0,0.45)',
              display: 'flex', flexDirection: 'column', gap: 16,
              animation: 'ttyChatFadeIn 0.18s ease-out',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 30, height: 30,
                background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)',
                borderRadius: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <Filter size={14} color="var(--accent-purple)" />
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                {t('chat.filter_change_title', lang)}
              </span>
            </div>

            {/* Body */}
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55 }}>
              {t('chat.filter_change_body', lang)}
            </p>

            {/* Current vs New */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Current filter */}
              <div style={{
                padding: '10px 12px', borderRadius: 8,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                  {t('chat.filter_change_current', lang)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {filters.projects.length > 0
                    ? filters.projects.map(p => (
                        <span key={p} style={{
                          padding: '2px 8px', borderRadius: 4,
                          background: 'var(--bg-card)', border: '1px solid var(--border)',
                          fontSize: 11, color: 'var(--text-primary)',
                          maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {p.split('/').pop() ?? p}
                        </span>
                      ))
                    : <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                        {t('chat.filter_change_all', lang)}
                      </span>
                  }
                </div>
              </div>

              {/* Arrow */}
              <div style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 16 }}>↓</div>

              {/* New filter */}
              <div style={{
                padding: '10px 12px', borderRadius: 8,
                background: 'color-mix(in srgb, var(--accent-purple) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-purple) 40%, transparent)',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent-purple)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                  {t('chat.filter_change_new', lang)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {pendingNav.newProjects.map(p => (
                    <span key={p} style={{
                      padding: '2px 8px', borderRadius: 4,
                      background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-purple) 50%, transparent)',
                      fontSize: 11, color: 'var(--accent-purple)',
                      maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {p.split('/').pop() ?? p}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setPendingNav(null)}
                style={{
                  padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--text-tertiary)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
              >
                {t('chat.filter_change_cancel', lang)}
              </button>
              <button
                onClick={() => {
                  setFilters(prev => ({ ...prev, projects: pendingNav.newProjects }))
                  navigate(pendingNav.cleanPath)
                  setPendingNav(null)
                  setOpen(false)
                }}
                style={{
                  padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                  border: '1px solid var(--accent-purple)',
                  background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)', color: 'var(--accent-purple)',
                  cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '0.8' }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
              >
                <ArrowRight size={13} />
                {t('chat.filter_change_confirm', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const iconBtnStyle: React.CSSProperties = {
  width: 28, height: 28,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: '1px solid var(--border)', borderRadius: 7,
  color: 'var(--text-tertiary)', cursor: 'pointer', transition: 'all 0.15s', padding: 0,
}
