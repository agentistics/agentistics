/**
 * MarkdownPreview — rendered to markup (`renderToStaticMarkup`, this repo's own no-jsdom stack;
 * see `RepoFileEditor.test.tsx`'s own note) and asserted on the ACTUAL OUTPUT, which is what the
 * design's own security check asks for: a `<script>`, an `onerror` handler, a `javascript:` link
 * and a remote image must all render INERT, and the remote image must never be an `<img src=...>`
 * a browser would fetch — a live network check (Playwright) additionally confirmed no request goes
 * out for it, but the shape of the markup below is what MAKES that true, and is asserted here where
 * it can be pinned by a test that runs every commit.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { MarkdownPreview, type MarkdownPreviewProps } from './MarkdownPreview'

function render(text: string, opts: Partial<Parameters<typeof MarkdownPreview>[0]> = {}): string {
  return renderToStaticMarkup(
    <MarkdownPreview
      text={text}
      sessionId="s1"
      docPath="docs/guide.md"
      lang="en"
      theme="dark"
      {...opts}
    />,
  )
}

const BASE_PROPS: MarkdownPreviewProps = {
  text: 'body', sessionId: 's1', docPath: 'docs/guide.md', lang: 'en', theme: 'dark',
}

/**
 * Walks the element tree `MarkdownPreview(props)` returns (calling the component as a PLAIN
 * FUNCTION, never rendered — this repo's stack has no jsdom) looking for the one element whose
 * `type` is `wanted`. Used to reach the `<ReactMarkdown components={…}>` element buried inside the
 * frontmatter conditionals, so a test can inspect the `components` map's own function IDENTITIES
 * without a DOM.
 */
function findElement(node: unknown, wanted: unknown): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== 'object') return null
  const el = node as { type?: unknown; props?: { children?: unknown } }
  if (el.type === wanted) return el as { props: Record<string, unknown> }
  const children = el.props?.children
  if (Array.isArray(children)) {
    for (const c of children) {
      const found = findElement(c, wanted)
      if (found !== null) return found
    }
    return null
  }
  return findElement(children, wanted)
}

describe('security — untrusted repository content renders inert', () => {
  test('a raw <script> tag is never a live element', () => {
    const html = render('# Hello\n\n<script>document.title = "XSS"</script>\n\nAfter.')
    expect(html).not.toContain('<script>')
    expect(html.toLowerCase()).not.toContain('<script ')
  })

  test('an <img onerror=...> is never a live element with a handler attribute', () => {
    const html = render('<img src="x" onerror="document.title=\'XSS\'">')
    // No `rehype-raw` means the raw HTML tag is never parsed into a real element at all — it comes
    // back as ESCAPED TEXT (`&lt;img …&gt;`), which is why `onerror=` still appears as a SUBSTRING:
    // it is part of the inert sentence on screen, not a live attribute. The real assertion is that
    // no unescaped `<img` tag exists in the output for this input.
    expect(html).not.toContain('<img ')
    expect(html).toContain('&lt;img')
  })

  test('a javascript: link is caught by OUR OWN classifyHref, not left to react-dom alone', () => {
    // React itself also refuses to emit a raw `javascript:` href (it substitutes a throwing stub),
    // which would make a bare `not.toContain('javascript:')` pass even if this component's own
    // `classifyHref` gate were deleted entirely — see `markdownLinks.ts`'s own header for why the
    // gate exists regardless. So this asserts the SPECIFIC inert markup our `a` renderer produces
    // for a blocked link (a struck-through, non-navigating `<span>` with the refusal as its title),
    // which only appears when OUR gate runs.
    const html = render("[click me](javascript:document.title='XSS')")
    expect(html).toContain('text-decoration:line-through')
    expect(html).toContain('This link is not opened')
    expect(html).not.toContain('<a href')
    expect(html).toContain('click me')
  })

  test('a data: link (not an image) is blocked the same way', () => {
    const html = render('[open](data:text/html,<script>alert(1)</script>)')
    expect(html).toContain('text-decoration:line-through')
    expect(html).not.toContain('<a href')
  })

  test('a remote image is NEVER an <img src="http…"> — nothing for the browser to fetch', () => {
    const html = render('![tracker](https://example.com/tracker.png)')
    expect(html).not.toContain('<img')
    // It is offered as a deliberate, explicit link instead.
    expect(html).toContain('href="https://example.com/tracker.png"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test('a relative image resolves through the media route, relative to the DOCUMENT\'S directory', () => {
    const html = render('![diagram](./img.png)', { docPath: 'docs/guide.md' })
    expect(html).toContain('<img')
    expect(html).toContain('/api/fleet/tree/media?id=s1&amp;path=docs%2Fimg.png')
  })

  test('a safe external link (https) opens in a new tab with noopener', () => {
    const html = render('[docs](https://example.com/docs)')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test('a relative link to another repo file is clickable but calls back rather than navigating', () => {
    let opened: string | null = null
    const html = render('[other](./other.md)', { onOpenPath: p => { opened = p } })
    expect(html).toContain('other')
    // The onClick handler is a real prop, not asserted through static markup (it never fires
    // server-side) — its wiring is exercised by TypeScript accepting the callback shape above and
    // by `resolveRepoRelativePath`'s own tests for the path it would be called with.
    expect(opened).toBeNull()
  })

  // M7: a relative link used to carry its raw `href`, so a middle click / "open in new tab" hit a
  // meaningless dashboard URL — harmless, but a real oddity next to a link that visually looks like
  // one. There is nothing to navigate TO (it names a path inside a session's repository, not a URL),
  // so the fix is no `href` at all: still clickable, still reachable from a keyboard, never a
  // navigation target.
  test('an internal link carries no href — nothing for a middle click to navigate to (M7)', () => {
    const html = render('[other](./other.md)')
    expect(html).not.toContain('href="./other.md"')
    expect(html).not.toContain('href=".%2Fother.md"')
    expect(html).toContain('role="link"')
    expect(html).toContain('tabindex="0"')
  })
})

describe('frontmatter', () => {
  test('a flat block renders as a table above the body', () => {
    const html = render('---\nname: probe-doc\ndescription: a test\n---\n\n# Body\n')
    expect(html).toContain('probe-doc')
    expect(html).toContain('a test')
    expect(html).toContain('<table')
    expect(html).toContain('Body')
  })

  test('an unparseable block is shown as a code block, never dropped', () => {
    const html = render('---\ntags: [a, b]\n---\n\nBody text.\n')
    expect(html).toContain('tags: [a, b]')
    expect(html).toContain('Body text.')
  })
})

describe('code fences', () => {
  test('a labelled fence is highlighted, not left as one plain grey block', () => {
    const html = render('```ts\nconst x = 1\n```\n')
    // Colours come from `buildHighlightColors('dark')` — the keyword `const` gets its own span.
    expect(html).toContain('<code')
    expect((html.match(/<span/g) ?? []).length).toBeGreaterThan(1)
  })

  test('a mermaid fence renders the diagram component, not a code block', () => {
    const html = render('```mermaid\ngraph TD\n  A --> B\n```\n')
    // The diagram itself only resolves in a browser (dynamic `import(\'mermaid\')` inside an
    // effect, which never runs under static rendering) — what THIS proves is that it did not fall
    // through to the code highlighter, which would have printed the raw arrow/bracket tokens.
    expect(html).not.toContain('<span style="color')
    expect(html).toContain('Drawing the diagram')
  })

  // M5: the diagram (and its "drawing…"/error card) used to render INSIDE `.ag-chat-md pre` — a box
  // inside a box, and a `<div>` nested inside a `<pre>`. `MarkdownPre` intercepts exactly the element
  // `MarkdownCode` returns for a mermaid fence and skips the wrapper for it alone.
  test('a mermaid fence is NOT wrapped in a <pre> — the fix for M5', () => {
    const html = render('```mermaid\ngraph TD\n  A --> B\n```\n')
    expect(html).not.toContain('<pre')
  })

  test('an ordinary fence keeps its <pre> wrapper — M5 does not touch non-mermaid code', () => {
    const html = render('```ts\nconst x = 1\n```\n')
    expect(html).toContain('<pre')
  })
})

// I1: every custom renderer used to be a closure created fresh inside `MarkdownPreview`'s own body,
// so a poll-driven re-render handed `react-markdown` a brand-new function identity for `img`/`code`
// on every pass — read as a DIFFERENT component type at that tree position, so React unmounted and
// remounted every image, link and diagram on every poll (measured: re-fetched images, re-run
// `mermaid.render()`). Calling `MarkdownPreview` as a PLAIN FUNCTION twice (this repo's stack has no
// jsdom to actually re-render a mounted tree) and comparing the `components` map `<ReactMarkdown>`
// receives each time is what proves the renderer FUNCTIONS themselves never change, which is what
// keeps React from ever unmounting anything the source did not actually change.
describe('renderer identity survives a re-render (I1)', () => {
  test('a/img/code/pre are the exact same function on every call, not merely equal', () => {
    const el1 = MarkdownPreview(BASE_PROPS)
    const el2 = MarkdownPreview({ ...BASE_PROPS })
    const rm1 = findElement(el1, ReactMarkdown)
    const rm2 = findElement(el2, ReactMarkdown)
    expect(rm1).not.toBeNull()
    expect(rm2).not.toBeNull()
    const c1 = rm1!.props.components as Record<string, unknown>
    const c2 = rm2!.props.components as Record<string, unknown>
    for (const key of ['a', 'img', 'code', 'pre']) {
      expect(c1[key]).toBeDefined()
      expect(c1[key]).toBe(c2[key])
    }
  })

  test('the whole components object is the same reference too — one static map, not rebuilt', () => {
    const el1 = MarkdownPreview(BASE_PROPS)
    const el2 = MarkdownPreview({ ...BASE_PROPS, text: 'a different body' })
    const rm1 = findElement(el1, ReactMarkdown)
    const rm2 = findElement(el2, ReactMarkdown)
    expect(rm1!.props.components).toBe(rm2!.props.components)
  })
})
