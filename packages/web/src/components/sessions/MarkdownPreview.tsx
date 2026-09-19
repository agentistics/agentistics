/**
 * MarkdownPreview — one markdown document, rendered.
 *
 * **NO `rehype-raw`.** A repository file is untrusted input; without it, `react-markdown` never
 * turns a raw `<script>`/`<img onerror>` tag into a live DOM element — an HTML block in the source
 * is either dropped or shown as inert text, and this component adds nothing that would change that.
 * `urlTransform` is overridden to the identity function so that EVERY decision about a link's or an
 * image's target is made by THIS file's own `classifyHref`/`classifyImgSrc`
 * (`lib/markdownLinks.ts`) rather than by react-markdown's own (undocumented-here) default —
 * auditable in one place, and exactly what the design's security check drives against: a
 * `javascript:` link renders inert, a remote `<img>` is never requested (see `MarkdownImage` below
 * — it never exists as an `<img src="http…">`, so there is nothing for the network tab to show), and
 * raw HTML stays text.
 *
 * **FRONTMATTER** (`lib/frontmatter.ts`) is pulled off the top and shown as a table above the body —
 * or, when it cannot be read as the small flat shape that module understands, as a code fence
 * instead: "shown as a code block, never dropped" is the promise; NEVER the body flowing straight
 * through with the fence lines mistaken for prose.
 *
 * **STYLING reuses `.ag-chat-md`** — the class `ArtifactDoc`/`ChatBubble` already draw `react-
 * markdown` output through — for everything BUT code fences: a heading, a table, a link all read the
 * same whether they arrived in a chat bubble or a repository file, and CLAUDE.md already asks for
 * one CSS rule rather than one per surface. Code, mermaid and the frontmatter table are this
 * component's OWN, laid on top: `.ag-chat-md pre` already gives a fenced block its box (background,
 * border, padding, horizontal scroll), so `code` below only has to decide WHAT is inside it —
 * per-token colour (`FencedCodeBlock`, the same palette `ArtifactDoc`'s `CodeView` reads via
 * `buildHighlightColors`, commit 80e956fd) or a diagram (`MermaidDiagram`) — and never re-draws the
 * box itself, which is how a highlighted fence and a plain one stay ONE background instead of two.
 * **A diagram is the ONE exception** (M5): `MarkdownPre` intercepts it BEFORE `.ag-chat-md pre`'s box
 * ever applies — see that component's own header for why a diagram inside a `<pre>` is a box inside
 * a box.
 *
 * **THE `a`/`img`/`code`/`pre` RENDERERS ARE MODULE-LEVEL, NOT INLINE.** They used to be closures
 * created fresh inside `MarkdownPreview`'s own body (`components={{ a() {…}, img() {…}, … }}`), so
 * every re-render of this component — the Studio polls the fleet every few seconds, and any of
 * that state changing re-renders everything under it — handed `react-markdown` a BRAND NEW function
 * for `img`/`code` on every pass. React's reconciliation keys a custom element on its `type`
 * (the function itself), so a new function each render reads as a DIFFERENT component type at that
 * position in the tree — React unmounted and remounted every image, link and diagram on every
 * poll, even though nothing about the document had changed. Measured: every image re-fetched
 * (the media route answers `no-store`, so each remount was a full re-download) and every diagram
 * re-ran `mermaid.render()` and flashed its "drawing…" state (I1). Hoisting the renderers to the
 * MODULE fixes this the same way Monaco's `defineAgentisticsThemes` is idempotent rather than
 * re-created per render: the function reference never changes, so React treats the poll's
 * re-render as an ordinary prop update and `MermaidDiagram`'s own `useEffect([source, theme])`
 * correctly does not re-run. What they need from a given render (`docPath`, `sessionId`, `lang`,
 * `theme`, `onOpenPath`) travels through `PreviewContext` instead of a closure, because a closure
 * is exactly the thing that would force them back to being recreated per render.
 */

import { createContext, isValidElement, useContext, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, ImageOff } from 'lucide-react'
import { parseFrontmatter } from '../../lib/frontmatter'
import { classifyHref, classifyImgSrc, resolveRepoRelativePath } from '../../lib/markdownLinks'
import { highlight, type Token, type TokenKind } from '../../lib/codeHighlight'
import { buildHighlightColors, type CodeThemeVariant } from '../../lib/monacoTheme'
import { repoMediaUrl } from '../../lib/attachmentUrl'
import { MermaidDiagram } from './MermaidDiagram'

export interface MarkdownPreviewProps {
  /** The live buffer — unsaved edits show, per the toggle's own contract. */
  text: string
  sessionId: string
  /** This document's own path, relative to the session's tree root — resolves every relative link
   * and image against ITS directory, not the tree root. */
  docPath: string
  lang: 'pt' | 'en'
  theme: CodeThemeVariant
  /**
   * Opens another repository file in the Studio. Absent (no caller has wired the Studio's tab
   * system to this preview yet) leaves an internal link CLICKABLE but INERT — see `MarkdownLink`
   * below — rather than guessing at a navigation this component has no way to perform honestly.
   *
   * **I5 — the exact one-line wiring the coordinator owes `Studio.tsx`, once it is ready:** the
   * review found `Studio.tsx:1164` constructing this preview with no `onOpenPath` prop at all, so
   * every relative link's `onClick` runs `preventDefault()` and stops. Whatever function opens a
   * repo path as a Studio tab there (the same one a file-tree click already calls) is the value —
   * e.g. `<MarkdownPreview … onOpenPath={openRepoPath} />`, where `openRepoPath: (path: string) =>
   * void` is that existing tab-opening function. This is outside W1-B's ownership of `Studio.tsx`.
   */
  onOpenPath?: (path: string) => void
}

/**
 * What every module-level renderer below needs from a given `MarkdownPreview` render, threaded
 * through context instead of a closure — see this file's own header for why a closure is exactly
 * what would force the renderers back to being recreated on every render.
 */
interface PreviewContextValue {
  docPath: string
  sessionId: string
  lang: 'pt' | 'en'
  theme: CodeThemeVariant
  onOpenPath?: (path: string) => void
}

const PreviewContext = createContext<PreviewContextValue | null>(null)

/** Every renderer below is only ever mounted INSIDE `MarkdownPreview`'s own `<ReactMarkdown>` —
 * react-markdown creates them, and only from the tree this file builds — so a `null` context here
 * is this module's own wiring being wrong, not a caller's mistake to recover from. */
function usePreviewContext(): PreviewContextValue {
  const ctx = useContext(PreviewContext)
  if (ctx === null) {
    throw new Error('MarkdownPreview: renderer used outside its own PreviewContext.Provider')
  }
  return ctx
}

// A fenced block's info-string language, mapped onto the small set `codeHighlight.ts` actually
// knows. Unlisted (including no language at all) renders PLAIN — that lexer's own rule, applied
// here at one remove: a language it cannot lex is never mis-coloured.
const FENCE_LANG: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'ts',
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  python: 'py', py: 'py',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css',
}

function childrenToText(children: ReactNode): string {
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  return ''
}

const COLOR_FOR = (colours: ReturnType<typeof buildHighlightColors>): Record<TokenKind, string> => ({
  plain: colours.plain,
  comment: colours.comment,
  string: colours.string,
  number: colours.number,
  keyword: colours.keyword,
  punct: colours.punct,
})

/**
 * A highlighted fence — NO box of its own; `.ag-chat-md pre` already draws it, and `.ag-chat-md pre
 * code` already resets padding/border/background to nothing and sets `white-space: pre`, which is
 * what lets the plain `\n` between lines below stand as real line breaks.
 */
function FencedCodeBlock({ text, fenceLang, theme }: {
  text: string; fenceLang: string; theme: CodeThemeVariant
}) {
  const kind = FENCE_LANG[fenceLang.toLowerCase()] ?? null
  const lines: Token[][] = highlight(text, kind)
  const colour = COLOR_FOR(buildHighlightColors(theme))
  return (
    <code>
      {lines.map((toks, i) => (
        <span key={i}>
          {toks.map((t, j) => <span key={j} style={{ color: colour[t.kind] }}>{t.text}</span>)}
          {i < lines.length - 1 ? '\n' : null}
        </span>
      ))}
    </code>
  )
}

const FRONTMATTER_LABEL = { en: 'Frontmatter', pt: 'Frontmatter' }
const FRONTMATTER_UNPARSED = {
  en: 'This block is not a simple list of fields — shown as written:',
  pt: 'Este bloco não é uma lista simples de campos — mostrado como está escrito:',
}
const REMOTE_IMAGE_FALLBACK = { en: 'remote image', pt: 'imagem remota' }
const BLOCKED_LINK_TITLE = {
  en: 'This link is not opened — its address is not one this preview allows.',
  pt: 'Este link não é aberto — o endereço dele não é permitido nesta pré-visualização.',
}
// M7: a refused relative image (escaped outside the session's tree, or simply not found) used to
// draw the browser's own broken-image glyph with nothing on screen saying why — indistinguishable
// from a slow network. `MarkdownImage`'s `onError` swaps to this instead.
const BROKEN_IMAGE_TITLE = {
  en: 'This image could not be loaded.',
  pt: 'Não foi possível carregar esta imagem.',
}

function FrontmatterTable({ data, lang }: { data: Map<string, string>; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  return (
    <table
      style={{
        display: 'block', maxWidth: '100%', overflowX: 'auto', borderCollapse: 'collapse',
        margin: '0 0 14px', fontSize: 12,
        border: '1px solid var(--border-subtle)', borderRadius: 8,
      }}
    >
      <caption style={{
        captionSide: 'top', textAlign: 'left', padding: '5px 9px', fontSize: 10.5,
        fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}>
        {pt ? FRONTMATTER_LABEL.pt : FRONTMATTER_LABEL.en}
      </caption>
      <tbody>
        {[...data.entries()].map(([key, value]) => (
          <tr key={key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <td style={{
              padding: '4px 9px', verticalAlign: 'top', fontWeight: 600, whiteSpace: 'nowrap',
              color: 'var(--text-secondary)',
            }}>
              {key}
            </td>
            <td style={{
              padding: '4px 9px', verticalAlign: 'top', color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {value === '' ? '—' : value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function identity(url: string): string {
  return url
}

// --- module-level renderers — see this file's own header for why they live here, not inline ------

/**
 * M7: an internal link used to keep its raw relative `href` (`./other.md`) on the rendered `<a>` —
 * harmless on a left click (`onClick`'s `preventDefault()` still runs first) but a real oddity on a
 * middle click or "open in new tab", which navigated the BROWSER TAB to that meaningless relative
 * URL against the dashboard's own origin. There is nothing this component could open it TO (it is a
 * path inside a session's repository, not a URL), so the fix is to give the element no `href` at
 * all — it stops being a navigable link and becomes a plain clickable/keyboard-activatable control,
 * which is what it always functionally was. `role="link"` + `tabIndex`/`onKeyDown` keep it reachable
 * from a keyboard, which a bare `onClick` on an `href`-less `<a>` is not.
 */
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { docPath, onOpenPath, lang } = usePreviewContext()
  const pt = lang === 'pt'
  const h = href ?? ''
  const kind = classifyHref(h)
  if (kind === 'blocked') {
    return (
      <span
        title={pt ? BLOCKED_LINK_TITLE.pt : BLOCKED_LINK_TITLE.en}
        style={{ color: 'var(--text-tertiary)', textDecoration: 'line-through', cursor: 'not-allowed' }}
      >
        {children}
      </span>
    )
  }
  if (kind === 'external') {
    return <a href={h} target="_blank" rel="noopener noreferrer">{children}</a>
  }
  const resolved = resolveRepoRelativePath(docPath, h)
  const open = () => onOpenPath?.(resolved)
  return (
    <a
      role="link"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
      onClick={ev => { ev.preventDefault(); open() }}
      onKeyDown={ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        ev.preventDefault()
        open()
      }}
    >
      {children}
    </a>
  )
}

/**
 * M7: a relative image the server refused (escaped the session's tree, or simply gone) used to draw
 * the browser's own generic broken-image glyph — nothing on screen said WHY, which reads exactly
 * like a slow network rather than a refusal. `onError` is the only signal a plain `<img>` gives for
 * this, so the swap is local `useState` rather than something derivable from props alone.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const { docPath, sessionId, lang } = usePreviewContext()
  const pt = lang === 'pt'
  const [broken, setBroken] = useState(false)
  const s = src ?? ''
  if (classifyImgSrc(s) === 'remote') {
    // NEVER fetched — see the header. Rendered as a link so the reader can still open it
    // deliberately, with the alt text (or a stated fallback) as the only thing shown.
    return (
      <a href={s} target="_blank" rel="noopener noreferrer">
        {alt && alt.trim() !== '' ? alt : (pt ? REMOTE_IMAGE_FALLBACK.pt : REMOTE_IMAGE_FALLBACK.en)}
      </a>
    )
  }
  if (broken) {
    return (
      <span
        title={pt ? BROKEN_IMAGE_TITLE.pt : BROKEN_IMAGE_TITLE.en}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5,
          color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)',
          borderRadius: 6, padding: '3px 7px',
        }}
      >
        <ImageOff size={13} style={{ flexShrink: 0 }} />
        {alt && alt.trim() !== '' ? alt : (pt ? BROKEN_IMAGE_TITLE.pt : BROKEN_IMAGE_TITLE.en)}
      </span>
    )
  }
  const resolved = resolveRepoRelativePath(docPath, s)
  const url = s.startsWith('data:') ? s : repoMediaUrl(sessionId, resolved)
  return (
    <img
      src={url}
      alt={alt ?? ''}
      style={{ maxWidth: '100%', borderRadius: 6 }}
      onError={() => setBroken(true)}
    />
  )
}

/** The fenced block's info-string language (`language-mermaid` → `'mermaid'`), or `null` for an
 * inline `` `code` `` span (no `className` at all) or a fence with no language tag. Shared between
 * `MarkdownCode` and `MarkdownPre` so the two never drift on what counts as "a mermaid fence" —
 * `MarkdownPre` has to answer that from the SAME `className` prop `MarkdownCode` reads, one render
 * step before `MarkdownCode` itself has run (see its own header). */
function fenceLanguageOf(className: string | undefined): string | null {
  const match = /language-(\S+)/.exec(className ?? '')
  return match === null ? null : match[1]!
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const { theme, lang } = usePreviewContext()
  const fenceLang = fenceLanguageOf(className)
  if (fenceLang === null) return <code>{children}</code>
  const raw = childrenToText(children).replace(/\n$/, '')
  if (fenceLang.toLowerCase() === 'mermaid') {
    return <MermaidDiagram source={raw} theme={theme === 'light' ? 'light' : 'dark'} lang={lang} />
  }
  return <FencedCodeBlock text={raw} fenceLang={fenceLang} theme={theme} />
}

/**
 * M5: a diagram used to render INSIDE `.ag-chat-md pre` — react-markdown's default wraps a fenced
 * block's `code` output in `<pre>`, and `MermaidDiagram`'s own box (border, background, horizontal
 * scroll) landed a second time inside that box, with its error card's monospace sentence sitting in
 * a `<pre>` meant for source text and a plain `<div>` nested inside one.
 *
 * **THIS CANNOT CHECK WHAT `MarkdownCode` RETURNS — only what it was GIVEN.** `hast-util-to-jsx-
 * runtime` builds the tree top-down: by the time THIS function runs, `children` is still the
 * un-rendered `<MarkdownCode className="language-mermaid">` ELEMENT (`type === MarkdownCode`), not
 * its eventual `<MermaidDiagram>` output — React does not call a function component until it
 * actually mounts it, and mounting `MarkdownPre`'s own return value is a step AFTER this function
 * returns. So the test here is on the SAME `className` prop `MarkdownCode` reads
 * (`fenceLanguageOf`, shared rather than re-derived) — never on the child element's `.type` — and
 * when it says "mermaid", the fix is to hand that UN-RENDERED `<MarkdownCode>` element straight back
 * as `MarkdownPre`'s own return value, skipping the `<pre>` wrapper around it. React still mounts
 * `MarkdownCode` exactly as it would have — one level higher in the tree, which is the entire fix.
 */
function MarkdownPre({ children }: { children?: ReactNode }) {
  // react-markdown hands a `pre` node's children over as an ARRAY (hast's own shape: a `<pre>` node
  // always has exactly one `code` child, but it is still a one-element array, not the element bare)
  // — `isValidElement` answers `false` for an array, so unwrapping the single-child case is what
  // lets the check below see the actual element instead of always missing.
  const only = Array.isArray(children) && children.length === 1 ? children[0] : children
  if (isValidElement(only)) {
    const codeProps = only.props as { className?: string }
    if (fenceLanguageOf(codeProps.className)?.toLowerCase() === 'mermaid') return only
  }
  return <pre>{children}</pre>
}

// The MAP ITSELF is hoisted too, not only the functions inside it — react-markdown only needs each
// KEY's function identity to stay put to avoid a remount (see this file's own header), but a fresh
// object literal on every render is still a wasted allocation `ReactMarkdown` never needed, and this
// is one line cheaper than arguing about it.
const MARKDOWN_COMPONENTS = { a: MarkdownLink, img: MarkdownImage, code: MarkdownCode, pre: MarkdownPre }

export function MarkdownPreview({ text, sessionId, docPath, lang, theme, onOpenPath }: MarkdownPreviewProps) {
  const pt = lang === 'pt'
  const front = parseFrontmatter(text)

  return (
    <PreviewContext.Provider value={{ docPath, sessionId, lang, theme, onOpenPath }}>
      <div className="ag-chat-md" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {front.present && front.data !== null && front.data.size > 0 && (
          <FrontmatterTable data={front.data} lang={lang} />
        )}
        {front.present && front.data === null && (
          <div style={{ marginBottom: 14 }}>
            <p style={{
              margin: '0 0 4px', fontSize: 11, color: 'var(--text-tertiary)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <AlertTriangle size={11} />
              {pt ? FRONTMATTER_UNPARSED.pt : FRONTMATTER_UNPARSED.en}
            </p>
            <pre style={{
              margin: 0, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-base)',
              border: '1px solid var(--border-subtle)', maxWidth: '100%', overflowX: 'auto',
              fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, monospace",
              fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)', whiteSpace: 'pre',
            }}>
              {front.raw}
            </pre>
          </div>
        )}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={identity}
          components={MARKDOWN_COMPONENTS}
        >
          {front.body}
        </ReactMarkdown>
      </div>
    </PreviewContext.Provider>
  )
}
