import { defineConfig, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const apiPort = process.env.PORT ?? '47291'

/**
 * A short content hash for every brand image in `public/` (and `public/icons/`), keyed by its URL
 * path. The server keeps these files unhashed under stable URLs, and a browser (or an installed
 * PWA) holds on to whichever version it fetched first — so the URL a page references has to change
 * when the artwork does. `?v=<hash>` on the reference does that without renaming any file: the
 * server ignores the query, the browser sees a new URL. Used by the manifest, `index.html` and, via
 * `define`, by the app's own `versionedAsset()` (`src/lib/brand.ts`).
 */
function brandTags(): Record<string, string> {
  const root = fileURLToPath(new URL('./public', import.meta.url))
  const tags: Record<string, string> = {}
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'icons') walk(`${dir}/${e.name}`, `${prefix}${e.name}/`)
        continue
      }
      if (!/\.(png|ico|svg)$/.test(e.name)) continue
      tags[`/${prefix}${e.name}`] = createHash('md5').update(readFileSync(`${dir}/${e.name}`)).digest('hex').slice(0, 8)
    }
  }
  walk(root, '')
  return tags
}
const BRAND_TAGS = brandTags()
const tagged = (path: string): string => (BRAND_TAGS[path] ? `${path}?v=${BRAND_TAGS[path]}` : path)

/**
 * **mermaid's dependency graph OVERLAPS the app's own** — `d3-shape`, `d3-hierarchy` and friends
 * reach this bundle a second way, through `recharts` → `victory-vendor`, and wherever the two
 * resolve to the same installed version rolldown places the shared code in ONE chunk (measured:
 * `CartesianChart-*.js`, 52 of its 265 modules are `d3-*` files mermaid also imports). Monaco never
 * had this problem — nothing else in this bundle imports `monaco-editor` — so its own routing below
 * checks "does ANY module trace to it"; doing the same for mermaid would take `CartesianChart` (used
 * on Home, Costs, every chart on the dashboard) out of the precache for the sake of a diagram most
 * sessions never open. So a chunk is MERMAID'S only when it is made of NOTHING ELSE: every module in
 * it must resolve through mermaid's own package or one of the dependencies below — each read off
 * `mermaid`'s own `package.json` `dependencies` (plus `lodash-es`, which is `dagre-d3-es`'s and
 * `chevrotain`'s own transitive dependency and, per `bun.lock`, nobody else's). Measured against a
 * real build: 96 chunks are ALL mermaid, 14 more touch it but are genuinely shared and are correctly
 * left alone.
 */
const MERMAID_ONLY_MARKERS = [
  '/mermaid/dist/', '/mermaid/lib/', '@mermaid-js/parser',
  '@braintree/sanitize-url', '@iconify/utils', '@upsetjs/venn.js',
  '/chevrotain/', '@chevrotain/',
  '/cytoscape/', 'cytoscape-cose-bilkent', 'cytoscape-fcose', 'cose-base', 'layout-base',
  'dagre-d3-es', 'graphlib',
  'dayjs', 'elkjs', 'es-toolkit',
  'katex', 'khroma', 'marked', 'roughjs', 'stylis', 'ts-dedent', 'uuid', 'lodash-es',
  // `dompurify` is DELIBERATELY ABSENT (M1). It used to be a flat marker here, and that swept
  // jspdf's OWN DOMPurify import (PDF export uses it too, and both features resolve to the exact
  // same installed copy — there is only one `dompurify` in the lockfile) into
  // `assets/mermaid/purify.es-*.js`: a chunk one file above named nothing to do with mermaid,
  // routed into mermaid's directory and so excluded from the precache with it. A chunk made of
  // nothing but `dompurify` is genuinely SHARED, exactly like the 14 chunks the header above already
  // names as correctly left alone — it now falls through to the ordinary `assets/` bucket instead.
]

/**
 * `d3` is a META-PACKAGE: `d3@7.9.0`'s own `dependencies` are ~30 separate `d3-*` packages
 * (`d3-shape`, `d3-scale`, `d3-array`, `d3-hierarchy`, `d3-time-format`, …), most of them reached
 * through the bare `import 'd3'` mermaid's diagram renderers use — not only through the one
 * (`d3-sankey`) this list used to name. A flat substring per sub-package is exactly the
 * hand-maintained list this file's own header warns against, and it was already wrong: measured
 * against a real build, `pieDiagram-*`, `ganttDiagram-*`, `sankeyDiagram-*`, `diagram-3UASUU5V-*`,
 * `chunk-ZIGJFQKS-*` and `src-CKoDGS-*` are 100% mermaid (every module in each resolves through
 * mermaid's own dependency tree) and still fell through to the generic `assets/` bucket — their
 * modules are real `node_modules/d3-shape/`, `node_modules/d3-scale/`, … folders, and NONE of them
 * contain the literal substring `/d3/` the old marker tested for (the character after `d3` there is
 * `-`, never `/`). Matched as a FAMILY instead — any path whose package segment is `d3` or
 * `d3-<word>` (one or more hyphenated words: `d3-scale-chromatic`, `d3-time-format`) — which also
 * correctly sweeps in the recharts/victory-vendor side's OWN older `d3-shape@1.3.7`/`d3-path@1.0.9`
 * if a chunk is ever made of nothing else. That is the safe direction to be wrong in, the same one
 * `assetFileNames` below states explicitly: worst case a genuinely chart-only chunk skips the
 * aggressive precache and is fetched once over the ordinary HTTP cache instead of never — never a
 * correctness bug, unlike shipping mermaid's own diagram-type chunks to every visitor's precache.
 */
const D3_FAMILY = /\/d3(-[a-z0-9]+)*\//

function isMermaidOnlyChunk(chunk: Rollup.PreRenderedChunk | Rollup.RenderedChunk): boolean {
  const ids = chunk.moduleIds ?? []
  return ids.length > 0
    && ids.every(id => D3_FAMILY.test(id) || MERMAID_ONLY_MARKERS.some(marker => id.includes(marker)))
}

export default defineConfig({
  // The app reads its brand tags through `versionedAsset()` (`src/lib/brand.ts`).
  define: { __BRAND_TAGS__: JSON.stringify(BRAND_TAGS) },
  plugins: [
    react(),
    {
      // The two icon links in the shell get the same content tag as the manifest's icons, so a tab
      // or a home-screen entry that cached an older drawing fetches the current one.
      name: 'agentistics-brand-urls',
      transformIndexHtml: (html: string) => html
        .replace('href="/favicon.ico"', `href="${tagged('/favicon.ico')}"`)
        .replace('href="/apple-touch-icon.png"', `href="${tagged('/apple-touch-icon.png')}"`),
    },
    VitePWA({
      registerType: 'autoUpdate',
      // Service worker disabled in dev: it cached stale bundles during iteration,
      // making code changes appear not to take effect. Still enabled for prod builds.
      devOptions: { enabled: false, suppressWarnings: true, type: 'module' },
      // `icons/*.png` covers the central variants too; the central favicon needs naming.
      includeAssets: ['favicon.ico', 'favicon-central.ico', 'apple-touch-icon.png', 'apple-touch-icon-central.png', 'minimalistLogo.png', 'icons/*.png'],
      manifest: {
        name: 'Agentistics',
        short_name: 'Agentistics',
        description: 'Local analytics dashboard for AI coding assistants',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f0f12',
        theme_color: '#FD8924',
        icons: [
          // The BARE glyph, scaled up, no plate — what desktop taskbars/docks draw verbatim. A plate
          // vanished into a dark Windows taskbar; generated by scripts/gen-brand-assets.ts.
          { src: tagged('/icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: tagged('/icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Opaque plate, glyph confined to the safe-zone circle — for OSes (Android/ChromeOS)
          // that crop icons to their own adaptive shape. A maskable icon must stay opaque
          // edge-to-edge, or the crop reveals holes; it must never double as the 'any' icon,
          // or the same edge-to-edge plate is what painted the black square being fixed here.
          { src: tagged('/icons/icon-192-maskable.png'), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: tagged('/icons/icon-512-maskable.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache only static assets; API calls always go to network
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // ...EXCEPT Monaco. `globPatterns` above is `**/*.js`, and **a precache manifest is the one
        // place a lazy chunk stops being lazy**: workbox would download the editor, its ~160 KB of
        // stylesheet and its five workers on every first visit, for every user, including everyone
        // who never opens the Repository tab — undoing the whole point of the dynamic import. It is
        // also a hard BUILD FAILURE and not merely waste: `vite-plugin-pwa` aborts when a
        // glob-matched asset passes workbox's 2 MiB ceiling, and Monaco's largest chunk is 2.66 MB.
        // Both patterns are paths this config OWNS (see `build.rollupOptions.output` below), never
        // chunk names invented by the bundler — rolldown splits Monaco into ~94 chunks called
        // `editor.api`, `toggleHighContrast`, `pgsql`… and a name-based rule would be one upstream
        // refactor away from silently precaching 14 MB again. Monaco is fetched on demand and then
        // served from the ordinary HTTP cache.
        // `assets/mermaid/**` is the exact same rule as Monaco's — see `isMermaidOnlyChunk`'s own
        // header for why a substring/name-based rule cannot stand in for the directory here, the way
        // it might look like it could from this line alone.
        globIgnores: ['assets/monaco/**', 'assets/mermaid/**', '**/*.worker-*.js'],
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  // Monaco's worker entry points are ES modules that import across several files. Vite's default
  // worker output is 'iife', which cannot express that; 'es' emits real module workers, which is
  // also what lets the json/css/html workers share one chunk of Monaco base code instead of
  // inlining a copy each.
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        // Everything Monaco emits goes under `assets/monaco/`, so `workbox.globIgnores` above can
        // exclude it by PATH. **`manualChunks` was tried first and is wrong**: collapsing Monaco
        // into one named chunk also put a `<link rel="modulepreload" href="…monaco…">` and a
        // render-blocking `<link rel="stylesheet">` into `index.html`, i.e. 4.5 MB fetched on every
        // page load — the exact opposite of what the dynamic import is for. Routing by DIRECTORY
        // leaves rolldown's own splitting alone, and `index.html` then names no Monaco asset at all.
        // `assets/mermaid/` is the SAME technique, ONE LINE below Monaco's, for `MermaidDiagram.tsx`'s
        // own `import('mermaid')` — see `isMermaidOnlyChunk`'s header for why it is a stricter test
        // than Monaco's `.some(...)` and must stay one.
        chunkFileNames: chunk =>
          (chunk.moduleIds ?? []).some(id => id.includes('monaco-editor'))
            ? 'assets/monaco/[name]-[hash].js'
            : isMermaidOnlyChunk(chunk)
              ? 'assets/mermaid/[name]-[hash].js'
              : 'assets/[name]-[hash].js',
        // The same for Monaco's assets, which are its CSS (~160 KB across two files) and
        // `codicon.ttf`. The test is `originalFileNames`, because that is the only field that is
        // IDENTICAL on both of the calls Vite makes per asset — it probes once with a placeholder
        // `source` before the real call, so a content test would answer differently each time and
        // the file would be named one thing and referenced as another. Monaco's CSS belongs to a
        // vendor chunk and so traces back to no source file of ours: an EMPTY origin list is the
        // signature. Every stylesheet this app writes itself carries its own origin
        // (`index.html`, `src/pages/CustomPage.tsx`, `src/components/SessionTerminal.tsx`) and
        // stays put. If some future dependency ever emits chunk-level CSS of its own, it would land
        // here too — which costs it its place in the PRECACHE and nothing else: it is still built,
        // still served, still cached by the browser. That is the direction to be wrong in.
        assetFileNames: asset => {
          const origins = asset.originalFileNames ?? []
          const fromMonaco = origins.length === 0 || origins.some(n => n.includes('monaco-editor'))
          return fromMonaco ? 'assets/monaco/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
  server: {
    allowedHosts: true,
    host: true,
    // Dev UI port. Defaults to 47292; the central dev flow sets WEB_PORT=48080 so you open the
    // same URL as the Docker container (which publishes 48080). API stays proxied below.
    port: Number(process.env.WEB_PORT ?? 47292),
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        // WEBSOCKETS TOO, and without this line the write channels are dead in dev while
        // everything else works. Both of them ride an upgrade (`/api/fleet/input`,
        // `/api/shell/input`); a proxy entry without `ws` forwards ordinary requests and silently
        // DROPS the handshake, so the socket times out with no status to look up — the live screen
        // keeps drawing over SSE (a plain GET) and typing into it just does nothing.
        ws: true,
      },
    },
  },
})
