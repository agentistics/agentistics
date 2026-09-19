import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { JSON_DIAGNOSTICS_OVERRIDE, languageForPath, languageIdsInUse } from './monacoLanguage'

describe('languageForPath', () => {
  test('maps common extensions to Monaco language ids', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript')
    expect(languageForPath('src/a.tsx')).toBe('typescript')
    expect(languageForPath('src/a.js')).toBe('javascript')
    expect(languageForPath('a.json')).toBe('json')
    expect(languageForPath('README.md')).toBe('markdown')
    expect(languageForPath('style.css')).toBe('css')
    expect(languageForPath('index.html')).toBe('html')
    expect(languageForPath('script.py')).toBe('python')
    expect(languageForPath('main.go')).toBe('go')
    expect(languageForPath('lib.rs')).toBe('rust')
  })
  test('is case-insensitive on the extension', () => {
    expect(languageForPath('A.TS')).toBe('typescript')
  })
  test('Dockerfile has no extension and is matched by its bare name', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('deploy/Dockerfile')).toBe('dockerfile')
  })
  test('and so are its stage variants, which the icon table already claimed', () => {
    // `Dockerfile.dev` wore the whale in the tree and opened as plain text: one file, two answers.
    for (const p of ['Dockerfile.dev', 'Dockerfile.prod', 'docker/Dockerfile.base']) {
      expect(languageForPath(p), p).toBe('dockerfile')
    }
    // The trailing dot, here for the same reason it is in `.env.` — a name that merely starts with
    // those ten letters is not a Dockerfile.
    expect(languageForPath('dockerfiles.md')).toBe('markdown')
    expect(languageForPath('dockerfile-notes.txt')).toBe('plaintext')
  })
  test('an unknown extension falls back to plaintext, never throws', () => {
    expect(languageForPath('data.xyz123')).toBe('plaintext')
  })
  test('a file with no extension at all is plaintext', () => {
    expect(languageForPath('LICENSE')).toBe('plaintext')
  })

  // --- the grammars the table was missing --------------------------------------------------------
  test('the C++ extensions monaco registers are all claimed', () => {
    for (const p of ['a.cpp', 'a.cc', 'a.cxx', 'a.hpp', 'a.hh', 'a.hxx']) {
      expect(languageForPath(p), p).toBe('cpp')
    }
    expect(languageForPath('a.c')).toBe('c')
    expect(languageForPath('a.h')).toBe('c')
  })
  test('the languages this bundle ships and the table did not claim', () => {
    expect(languageForPath('analysis.r')).toBe('r')
    expect(languageForPath('init.lua')).toBe('lua')
    expect(languageForPath('main.dart')).toBe('dart')
    expect(languageForPath('app.ex')).toBe('elixir')
    expect(languageForPath('test.exs')).toBe('elixir')
    expect(languageForPath('core.clj')).toBe('clojure')
    expect(languageForPath('core.cljs')).toBe('clojure')
    expect(languageForPath('deps.edn')).toBe('clojure')
    expect(languageForPath('Main.scala')).toBe('scala')
    expect(languageForPath('build.sbt')).toBe('scala')
    expect(languageForPath('Program.fs')).toBe('fsharp')
    expect(languageForPath('script.fsx')).toBe('fsharp')
  })

  // --- the niche-file audit (Docker variants, HCL, config files with no grammar here) -------------
  test('Containerfile and the *.dockerfile extension get the same grammar as Dockerfile', () => {
    expect(languageForPath('Containerfile')).toBe('dockerfile')
    expect(languageForPath('build/Containerfile')).toBe('dockerfile')
    expect(languageForPath('app.dockerfile')).toBe('dockerfile')
  })
  test('Terraform/HCL, a grammar this bundle already ships and the table did not claim', () => {
    expect(languageForPath('main.tf')).toBe('hcl')
    expect(languageForPath('terraform.tfvars')).toBe('hcl')
    expect(languageForPath('network.hcl')).toBe('hcl')
  })
  test('docker-compose*.yml and compose*.yml already resolve through the plain YAML rule', () => {
    expect(languageForPath('docker-compose.yml')).toBe('yaml')
    expect(languageForPath('compose.override.yaml')).toBe('yaml')
  })
  test('files with no grammar in this bundle at all are PLAINTEXT, said explicitly', () => {
    expect(languageForPath('common.mk')).toBe('plaintext')
    expect(languageForPath('Justfile')).toBe('plaintext')
    expect(languageForPath('Procfile')).toBe('plaintext')
    expect(languageForPath('.gitignore')).toBe('plaintext')
    expect(languageForPath('.gitattributes')).toBe('plaintext')
    expect(languageForPath('.dockerignore')).toBe('plaintext')
    // `nginx.conf`/`Caddyfile`: no grammar exists either, and neither carries a NAME_LANGUAGE or
    // EXT_LANGUAGE entry of its own — this is the unmapped fallback, exercised explicitly so the
    // audit is not merely inferred from the rule three lines above `languageForPath`'s `return`.
    expect(languageForPath('nginx.conf')).toBe('plaintext')
    expect(languageForPath('Caddyfile')).toBe('plaintext')
  })

  // --- `.env` ------------------------------------------------------------------------------------
  describe('.env files highlight, including the variants people actually have', () => {
    test('the bare name, which has no extension to key on', () => {
      expect(languageForPath('.env')).toBe('ini')
      expect(languageForPath('packages/web/.env')).toBe('ini')
    })
    test('every variant, by PREFIX — the suffix is an environment name, not a known list', () => {
      for (const p of [
        '.env.local', '.env.production', '.env.example', '.env.config',
        '.env.development.local', '.env.whatever-this-project-calls-it',
      ]) {
        expect(languageForPath(p), p).toBe('ini')
      }
    })
    test('and `.envrc` is NOT one of them', () => {
      // direnv's file is a shell script. The trailing dot in the prefix test is what keeps it out,
      // along with `.environment` and anything else that merely starts with those four letters.
      expect(languageForPath('.envrc')).toBe('plaintext')
      expect(languageForPath('.environment')).toBe('plaintext')
    })
    test('an `.ini` or `.properties` file gets the same grammar by its extension', () => {
      expect(languageForPath('setup.ini')).toBe('ini')
      expect(languageForPath('app.properties')).toBe('ini')
    })
  })

  // --- I3: tsconfig*.json / *.jsonc, and the shell extensions the audit found untested -------------
  test('shell scripts, the extensions the niche-file audit found with no dedicated test', () => {
    for (const p of ['deploy.sh', 'setup.bash', 'profile.zsh']) {
      expect(languageForPath(p), p).toBe('shell')
    }
  })
  test('tsconfig*.json and *.jsonc stay the ordinary `json` language id', () => {
    // There is no separate `'jsonc'` id — see `JSON_DIAGNOSTICS_OVERRIDE`'s own header for why the
    // comment/trailing-comma leniency these files need is a GLOBAL diagnostics change instead, applied
    // by `RepoFileEditor.tsx` once `jsonDefaults` loads. This only pins that the mapping itself never
    // changed underneath that decision.
    for (const p of ['tsconfig.json', 'tsconfig.base.json', 'packages/web/tsconfig.json', 'a.jsonc']) {
      expect(languageForPath(p), p).toBe('json')
    }
  })
})

describe('JSON_DIAGNOSTICS_OVERRIDE', () => {
  test('relaxes exactly the two diagnostics the review caught firing on tsconfig.json/*.jsonc', () => {
    // "Comments are not permitted in JSON.(521)" and the matching trailing-comma diagnostic — see the
    // review's I3 repro. `allowComments`/`schemas`/etc. are deliberately left at Monaco's own
    // defaults; only these two severities move.
    expect(JSON_DIAGNOSTICS_OVERRIDE).toEqual({ comments: 'ignore', trailingCommas: 'ignore' })
  })
})

/**
 * **EVERY ID IN THE TABLE IS ONE THE BUNDLE ACTUALLY REGISTERS.**
 *
 * This is the assertion the table existed three months without: `monaco.editor.createModel(text,
 * 'toml')` does not throw for a language nobody registered — it returns a model with no tokenizer —
 * so `toml`, `vue` and `makefile` all sat here naming grammars this bundle does not contain, and the
 * files rendered as plain text with the table insisting otherwise. The only way to tell is to ask
 * the package.
 *
 * The registered set is read the same way `monacoEntry.lint.test.ts` reads it: from the imports in
 * `monacoEntry.ts` (the one composition this app loads — a grammar in `node_modules` that nothing
 * imports is NOT in the bundle) and then from each of those `register.js` files' own `id:`, because a
 * directory name is not a language id — `languages/definitions/cpp/register.js` registers two (`c`
 * and `cpp`), and `objective-c`'s id carries its dash.
 */
describe('languageIdsAreRegistered', () => {
  const WEB = join(import.meta.dir, '../..')
  const VS_CANDIDATES = [
    join(WEB, 'node_modules', 'monaco-editor/package.json'),
    join(WEB, '../..', 'node_modules', 'monaco-editor/package.json'),
  ]

  function vsDir(): string | null {
    for (const pkg of VS_CANDIDATES) if (existsSync(pkg)) return join(dirname(pkg), 'esm/vs')
    return null
  }

  /**
   * Every module specifier an `import`/`export … from` STATEMENT names — anchored at a line start,
   * the same `SPECIFIER` `monacoEntry.lint.test.ts` reads the entry with.
   *
   * **IT WAS UNANCHORED, WHICH MADE THIS GUARD COMMENT-SATISFIABLE.** The old pattern matched the
   * quoted subpath anywhere in the file, so `// import 'monaco-editor/languages/definitions/apex/
   * register'` still counted as a grammar in the bundle: trim an import for bundle size, leave the
   * line commented rather than deleted — which is what everybody does — and the ONE test that
   * exists to catch a language id nothing registers goes on passing. That is worse than no test,
   * because this is the test somebody consults before making exactly that edit.
   *
   * The commented form still cannot reach the `id:` scan below now: a line whose first non-space
   * characters are `//` (or ` *`) does not start with `import`.
   *
   * **NOR CAN A DECLARATION THAT MERELY NAMES ONE.** Anchoring at line start closed the leading-`//`
   * shape, but `export const OK = true // import '.../register'` and `export const DROPPED = ['.../
   * register']` both START with `export` and still carry the quoted path — so a genuinely deleted
   * import survived as a trailing comment or a plain array literal and this scan went on reporting
   * the grammar present. `(?!\s+(?:type|const|let|var|function|class|interface|enum|namespace)\b)`
   * excludes every declaration shape a real specifier clause is never written as; a bare side-effect
   * `import '...'` (what `monacoEntry.ts` writes for every grammar) is unaffected.
   */
  const SPECIFIER =
    /^\s*(?:import|export)\b(?!\s+(?:type|const|let|var|function|class|interface|enum|namespace)\b)[^\n]*?['"]([^'"\n]+)['"]/gm
  /** …of which these are the ones that register a language. */
  const LANG_SUBPATH = /^monaco-editor\/(languages\/(?:definitions|features)\/[^/]+)\/register$/

  /** The language ids the composition in `monacoEntry.ts` puts in the bundle, plus `plaintext`. */
  function registeredIds(vs: string): Set<string> {
    const entry = readFileSync(join(import.meta.dir, 'monacoEntry.ts'), 'utf8')
    // Both the grammars (`languages/definitions/<dir>/register`) and the three language FEATURES
    // (`languages/features/<name>/register`) register languages; json's does it with
    // `languages.register({ id: "json" })` and the grammars with `registerLanguage({ id: 'x' })`,
    // hence the quote-agnostic match on the `id:` below.
    const specs = [...entry.matchAll(SPECIFIER)].flatMap(m => {
      const sub = LANG_SUBPATH.exec(m[1] ?? '')
      return sub === null ? [] : [sub[1]!]
    })
    // If the parse ever breaks, it must break LOUDLY: a specifier list that came back empty would
    // make every assertion below vacuously true, which is the failure mode this whole file is about.
    expect(specs.length).toBeGreaterThan(50)
    // `plaintext` is monaco's own built-in and is registered by the editor core, not by a grammar.
    const ids = new Set<string>(['plaintext'])
    for (const spec of specs) {
      const file = join(vs, `${spec}/register.js`)
      expect(existsSync(file), `monacoEntry.ts imports ${spec}, which is not in the package`).toBe(true)
      for (const m of readFileSync(file, 'utf8').matchAll(/\bid:\s*["']([^"']+)["']/g)) ids.add(m[1]!)
    }
    return ids
  }

  test('every language id this table can answer with is in the bundle', () => {
    const vs = vsDir()
    if (vs === null) {
      // Same stance as `monacoEntry.lint.test.ts`: without the package there is nothing to compare
      // against, and a green tick would be worse than a skip.
      throw new Error(`monaco-editor not installed; looked in:\n${VS_CANDIDATES.join('\n')}`)
    }
    const registered = registeredIds(vs)
    // The set is read, not assumed: if this ever comes back tiny, the parse above broke and every
    // assertion below would be vacuous.
    expect(registered.size).toBeGreaterThan(60)
    for (const id of languageIdsInUse()) {
      expect(registered.has(id), `language id "${id}" is registered by nothing in monacoEntry.ts`)
        .toBe(true)
    }
  })

  test('and the ids the table used to invent are gone', () => {
    // Pins the three corrections, so nobody reintroduces a language this bundle cannot colour.
    expect(languageIdsInUse()).not.toContain('toml')
    expect(languageIdsInUse()).not.toContain('vue')
    expect(languageIdsInUse()).not.toContain('makefile')
    expect(languageForPath('bunfig.toml')).toBe('ini')
    expect(languageForPath('App.vue')).toBe('html')
    expect(languageForPath('Makefile')).toBe('plaintext')
  })

  /**
   * `SPECIFIER` was anchored at line start (Shape A, closed above), which stops a leading `//` from
   * reaching it — but a line that genuinely STARTS with `export`/`import` and only later carries a
   * `//` or a plain array literal still slips through, because nothing about "starts with import or
   * export" tells a real specifier clause apart from a declaration that merely NAMES one as a
   * string. Both shapes below would let a dropped grammar keep reading as "still imported".
   */
  test('the specifier scan is not fooled by a declaration that only NAMES a register path', () => {
    const trailingComment = "export const OK = true // import 'monaco-editor/languages/definitions/lua/register'"
    const arrayLiteral = "export const DROPPED_GRAMMARS = ['monaco-editor/languages/definitions/lua/register']"
    expect([...trailingComment.matchAll(SPECIFIER)]).toEqual([])
    expect([...arrayLiteral.matchAll(SPECIFIER)]).toEqual([])
    // The scan must still see the real thing: a bare side-effect import, exactly what monacoEntry.ts
    // writes for every grammar.
    expect([...("import 'monaco-editor/languages/definitions/lua/register'").matchAll(SPECIFIER)].length).toBe(1)
  })
})
