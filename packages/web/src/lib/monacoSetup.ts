/// <reference types="vite/client" />
/**
 * monacoSetup.ts — self-hosted Monaco, no CDN, loaded only when the Studio is opened.
 *
 * TWO GUARANTEES, and both are structural rather than a matter of care:
 *
 * 1. **No CDN.** Every worker below is a Vite `?worker` import, so it is bundled out of
 *    `node_modules` and served from this origin like every other asset.
 * 2. **Lazy.** Monaco is reached ONLY through the dynamic `import('./monacoEntry')` in
 *    `loadMonaco()`, so it lands in its own chunk and a user who never opens the Studio never
 *    downloads it. **This module must itself only ever be imported dynamically**: Vite hoists
 *    the `?worker` wrappers below into the Monaco chunk, so a STATIC `import { loadMonaco }` would
 *    drag ~4.4 MB into whatever chunk wrote it.
 *
 * **The editor is composed in `monacoEntry.ts`, not imported from the `monaco-editor` barrel.** Read
 * that file's header for why: the barrel's TypeScript LANGUAGE SERVICE emits a 6.9 MB
 * `ts.worker.js` at build time whether a browser ever asks for it or not, and that service is not
 * SWITCHED OFF here — it is ABSENT, never registered, which is why there is no
 * `disableTypeScriptServices` call anywhere in this file to find. Everything the barrel registers
 * except that one language service is registered there, grammars included — `.ts` and `.js` keep
 * their syntax highlighting.
 *
 * **The import specifiers there are `monaco-editor/<path-under-esm/vs>`, NOT
 * `monaco-editor/esm/vs/...`.** monaco-editor 0.56 ships an `exports` map whose subpath pattern is
 * `"./*": "./esm/vs/*.js"`, so the `esm/vs/` prefix every pre-0.5x recipe still uses now resolves
 * to `esm/vs/esm/vs/...` and fails outright. Verified against the installed package.
 *
 * **WHY THIS FILE STILL HAS TO EXIST ON 0.56, and why it must answer EVERY label.** Measured
 * against a real production build, not assumed:
 *
 * - The LANGUAGE workers (json, css, html) carry their own
 *   `createWorker: () => new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })`
 *   inside monaco's own `workerManager.js`, which Vite recognises and self-hosts unaided. They are
 *   emitted into `dist/assets/` whether this file names them or not.
 * - The BASE editor worker does NOT. It offers only
 *   `esmModuleLocationBundler: () => new URL('…/editorWebWorkerMain.js', import.meta.url)` — a bare
 *   asset URL, and that 544-byte file is under Vite's inline limit, so the build turns it into a
 *   `data:text/javascript;base64,…` URL whose first line is a RELATIVE import. A relative import
 *   cannot resolve against a `data:` URL, so without the `EditorWorker` below the base worker is
 *   dead on arrival — this file's reason for existing, now demonstrated rather than believed.
 * - And `MonacoEnvironment.getWorker` is consulted BEFORE a descriptor's own `createWorker`. So
 *   defining it at all takes over for EVERY label, including the three that worked by themselves:
 *   a label `workerFor` declines is a language broken by this file, not one left alone. That is why
 *   all four are wired even though only one of them is strictly ours.
 */
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'

/**
 * **THIS TYPE IS WHAT `loadMonaco()` ACTUALLY RESOLVES, AND IT USED NOT TO BE.** It was the BARREL's
 * `typeof import('monaco-editor')`, which promises two members `monacoEntry` does not have:
 * `typescript` (the language service that is not registered) and `lsp` (unreachable through the
 * package's `exports` map). Both were typed REQUIRED and `undefined` at RUNTIME, so
 * `monaco.typescript.typescriptDefaults…` TYPE-CHECKED and then threw inside the `.then()` — an
 * unhandled rejection and an editor that silently never mounts, the blank-pane class this product
 * has already been bitten by twice. Naming the module instead makes that read a compile error at the
 * call site, and `monacoEntry.lint.test.ts` greps for it as the second lock.
 *
 * **If you need `monaco.typescript`**, re-register the feature in `monacoEntry.ts` (and with it
 * 6.9 MB); this type then gains the member by itself, which is the point of deriving it.
 */
type Monaco = typeof import('./monacoEntry')

/**
 * The labels Monaco actually asks for, read off the package rather than guessed:
 * `editorWorkerService` from `editor/browser/services/editorWorkerService.js`, and each language
 * feature's own `workerManager.js`, which passes the LANGUAGE ID — so one worker answers to several
 * labels (css/less/scss, html/handlebars/razor).
 *
 * **`typescript` and `javascript` are deliberately NOT here**, and they cannot be asked for: their
 * language service is not registered at all (see `monacoEntry.ts`), so nothing constructs a worker
 * manager for those labels. If one ever appears in the thrown error below, the TypeScript feature
 * has been imported again and its 6.9 MB worker is back in the bundle.
 */
function workerFor(label: string): Worker {
  switch (label) {
    case 'json':
      return new JsonWorker()
    case 'css':
    case 'less':
    case 'scss':
      return new CssWorker()
    case 'html':
    case 'handlebars':
    case 'razor':
      return new HtmlWorker()
    case 'editorWorkerService':
      return new EditorWorker()
    default:
      // NEVER fall back to the base editor worker. It answers the handshake and then has none of
      // the methods the asking language service calls, so the feature fails one silent rejection at
      // a time with nothing on screen naming the cause. Naming the label is what makes the next
      // language service a one-line fix instead of an investigation.
      throw new Error(
        `monacoSetup: no worker bundled for Monaco worker label "${label}". ` +
          'Add its `?worker` import and a case to workerFor() in packages/web/src/lib/monacoSetup.ts.',
      )
  }
}

type MonacoEnvironmentHost = {
  MonacoEnvironment?: {
    getWorker?(workerId: string, label: string): Worker
    [key: string]: unknown
  }
}

/**
 * Must be set BEFORE the first editor is created. Idempotent.
 *
 * **IT MERGES, AND THE GUARD IS ON `getWorker` ALONE.** `MonacoEnvironment` is not one setting, it
 * is a bag of several: monaco reads `globalThis.MonacoEnvironment?.createTrustedTypesPolicy`
 * (`internal/common/workers.js`) and `?.globalAPI` (`editor/editor.api.js`) independently of
 * `getWorker`. Testing the whole OBJECT therefore disarmed us for the exact deployment most likely
 * to have one: a CSP-hardened host that sets only `createTrustedTypesPolicy`. We would then leave
 * `getWorker` unset, and the base editor worker — which has no `createWorker` of its own, only an
 * inlined `data:` URL that cannot resolve its relative imports — would be dead on arrival. So an
 * existing object is EXTENDED, its own keys untouched, and only a `getWorker` somebody else
 * installed is left alone.
 */
function armWorkers() {
  const host = self as unknown as MonacoEnvironmentHost
  if (host.MonacoEnvironment?.getWorker) return
  // **AND IT PRESERVES THE OBJECT'S IDENTITY.** A spread installs a NEW object, so a CSP-hardened
  // host holding a reference to its own `MonacoEnvironment` and setting `createTrustedTypesPolicy`
  // on it AFTER us would be writing into a bag monaco no longer reads — the exact failure the merge
  // above exists to prevent, one step later. Assigning INTO the existing object cannot diverge.
  Object.assign((host.MonacoEnvironment ??= {}), {
    getWorker: (_workerId: string, label: string) => workerFor(label),
  })
}

let pending: Promise<Monaco> | null = null

/**
 * Load Monaco, once. Call before the first `monaco.editor.create`.
 *
 * The PROMISE is memoized rather than the module: a second editor mounting while the first chunk is
 * still in flight must join that fetch rather than start a second one.
 *
 * **A FAILURE IS NOT MEMOIZED.** A rejected promise left in `pending` poisons `loadMonaco()` for the
 * life of the page, and the page has exactly one other line of defence: `main.tsx`'s
 * `vite:preloadError` handler reloads once and then explicitly declines to reload again. So the
 * SECOND failed chunk fetch used to land here permanently — the editor could never open again
 * without the user reloading by hand, with nothing on screen saying so. Clearing `pending` costs a
 * retry on the next open and is the only thing that makes that recoverable.
 */
export function loadMonaco(): Promise<Monaco> {
  if (pending) return pending
  armWorkers()
  pending = import('./monacoEntry').catch(e => {
    pending = null
    throw e
  })
  return pending
}
