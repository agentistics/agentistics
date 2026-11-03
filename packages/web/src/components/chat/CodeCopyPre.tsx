/**
 * CodeCopyPre — the `pre` renderer for markdown: a FENCED code block gets a small copy button in
 * its top-right corner. react-markdown emits `<pre>` only for a fenced (or indented) block, never
 * for an inline `code` span, so mapping `pre` — and nothing else — is what keeps inline code
 * button-free. The copied text is the block's own text (no backticks, no language tag), read from
 * the rendered `<code>` so a syntax-highlighted block copies exactly what it shows.
 *
 * Visible always on touch devices, on hover/focus on a pointer device (index.css `.ag-code-*`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../../lib/clipboard'

export const COPY_LABEL = { en: 'Copy', pt: 'Copiar' }
export const COPIED_LABEL = { en: 'Copied', pt: 'Copiado' }
export const COPIED_MS = 1500

export function CodeCopyBlock({ children, pt, preProps }: {
  children?: ReactNode
  pt: boolean
  preProps?: React.HTMLAttributes<HTMLPreElement>
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const onCopy = async () => {
    const el = preRef.current
    if (!el) return
    const code = el.querySelector('code') ?? el
    const text = (code.textContent ?? '').replace(/\n$/, '')
    if (!(await copyText(text))) return
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }
  const label = (pt ? COPY_LABEL.pt : COPY_LABEL.en)
  const done = (pt ? COPIED_LABEL.pt : COPIED_LABEL.en)

  return (
    <div className="ag-code-block">
      <pre ref={preRef} {...preProps}>{children}</pre>
      <button
        type="button"
        className="ag-code-copy"
        data-copied={copied ? 'true' : undefined}
        onClick={onCopy}
        aria-label={copied ? done : label}
        title={copied ? done : label}
      >
        <span className="ag-code-copy-chip">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied && <span>{done}</span>}
        </span>
      </button>
    </div>
  )
}

const PT = { pre: ({ children }: { children?: ReactNode }) => <CodeCopyBlock pt>{children}</CodeCopyBlock> }
const EN = { pre: ({ children }: { children?: ReactNode }) => <CodeCopyBlock pt={false}>{children}</CodeCopyBlock> }

/** Stable `components` maps (a fresh object per render would remount every block). */
export function codeCopyComponents(pt: boolean) {
  return pt ? PT : EN
}
