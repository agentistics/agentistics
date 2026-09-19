/**
 * monacoLanguage.ts — PURE: which Monaco language id a file's own name implies.
 *
 * v1 deliberately runs Monaco with NO language services (no TypeScript/JS type-checking, no
 * inline diagnostics — see the design spec's "Deferred" list), so this mapping only has to name a
 * language Monaco's bundled Monarch grammars can tokenize for syntax highlighting; it does not
 * need to distinguish "has a language service" from "syntax only".
 *
 * Deliberately NOT `EXT_TO_LANG` (packages/server/server/jsonl.ts): that table maps extensions to
 * the DISPLAY names used in per-language usage stats (e.g. 'TypeScript', 'C++'), not to Monaco's
 * own lowercase language ids, and `packages/web/src/` may never import `packages/server/server/*`
 * (Vite would try to bundle Bun/Node APIs and fail). Where the two genuinely agree — same
 * extension, same language — this table agrees with it deliberately.
 */

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html',
  yml: 'yaml', yaml: 'yaml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift',
  // `.cxx`/`.hh`/`.hxx` are in monaco's OWN `cpp` registration beside `.cpp`/`.cc`/`.hpp`; they were
  // missing here, so a perfectly ordinary C++ file opened as plain text.
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', xml: 'xml',
  // **`toml` AND `vue` ARE NOT MONACO LANGUAGE IDS IN THIS BUNDLE**, and this table used to name
  // both: `createModel(text, 'toml')` does not throw, it just attaches no tokenizer, so those files
  // rendered as plain text while the table claimed otherwise — the kind of confident-looking nothing
  // `languageIdsAreRegistered` in the test now makes impossible. Each is mapped to the closest
  // grammar that IS here, and neither mapping mis-colours anything:
  //   - TOML's surface is what `ini` draws: `#` comments, `[table]` headers, `key = value`, quoted
  //     strings, numbers. What it does not know (dotted keys, arrays-of-tables) stays plain.
  //   - a `.vue` SFC is `<template>` + `<script>` + `<style>`, which is precisely the shape monaco's
  //     `html` grammar embeds javascript and css into.
  toml: 'ini',
  graphql: 'graphql', vue: 'html', svelte: 'plaintext',
  // Grammars this bundle already ships and this table did not claim. Each extension is taken from
  // that grammar's own `registerLanguage({ extensions })` in
  // `monaco-editor/esm/vs/languages/definitions/<id>/register.js`, never guessed — and every one of
  // them is imported by `monacoEntry.ts`, so the colour is in the bundle whether or not this table
  // ever asks for it. Leaving them out cost nothing but the highlighting.
  r: 'r', lua: 'lua', dart: 'dart',
  ex: 'elixir', exs: 'elixir',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  scala: 'scala', sbt: 'scala', sc: 'scala',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  // `.env` files. `ini` is the grammar — see `DOTENV_LANGUAGE` for why, and for the whole-name rule
  // that catches `.env` itself, which has no extension to key on.
  ini: 'ini', properties: 'ini',
  // `*.dockerfile` (a file NAMED with the extension rather than named `Dockerfile` outright) — the
  // `dockerfile` grammar `NAME_LANGUAGE` already reaches for `Dockerfile` itself.
  dockerfile: 'dockerfile',
  // Terraform/HCL. `monacoEntry.ts` already imports this grammar (it exists for nothing else), so
  // leaving these three extensions unclaimed cost the highlighting for free.
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  // A Makefile FRAGMENT included by a top-level one. Same grammar answer as `makefile` above, and
  // for the same reason — stated so a reviewer does not have to re-derive it from the fallback.
  mk: 'plaintext',
}

/**
 * **WHY `.env` FILES GET THE `ini` GRAMMAR.**
 *
 * They had no highlighting at all: `.env` has no extension (`lastIndexOf('.') === 0`) and
 * `.env.local`'s "extension" is `local`, so both fell through to `plaintext`.
 *
 * `ini` is the right fit and it is CHOSEN, not assumed — the grammar was read before it was wired
 * (`monaco-editor/esm/vs/languages/definitions/ini/ini.js`). Against a dotenv file it colours
 * exactly the four things such a file has: the NAME in `(^\w+)(\s*)(\=)` as `key`, the `=` as
 * `delimiter`, a line opening with `#` or `;` as `comment`, and a quoted value as `string` (with
 * `\n`-style escapes as `string.escape`); bare values stay plain, which is honest — a dotenv value
 * has no type. `shell` was the other candidate and is worse here: it reads `KEY=value` as an
 * assignment expression and gives the name no token of its own, so the one thing a reader scans a
 * `.env` for would be the same colour as everything else.
 *
 * It is in the bundle: `monacoEntry.ts` imports `languages/definitions/ini/register`, and
 * `monacoEntry.lint.test.ts` asserts that list against the installed package in both directions —
 * so this cannot silently become a language id that resolves to nothing.
 */
const DOTENV_LANGUAGE = 'ini'

/**
 * Whole names with no extension to key on.
 *
 * `.gitconfig` and `.editorconfig` are in monaco's own `ini` registration (`filenames:`), so they
 * are its answer rather than ours.
 */
const NAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  // The OCI-neutral spelling some projects use instead of `Dockerfile` — same grammar, same syntax.
  containerfile: 'dockerfile',
  // **`makefile` IS NOT A LANGUAGE IN THIS BUNDLE EITHER**, and unlike `toml` and `vue` it has no
  // near-neighbour: `shell` was considered and REFUSED, because a Makefile's top-level lines are not
  // shell (only its recipes are), and one unbalanced quote in an `echo` would then paint the rest of
  // the file as a string. `plaintext` is what it already rendered as; saying so is the only change.
  makefile: 'plaintext',
  '.env': DOTENV_LANGUAGE,
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  // `.gitignore`/`.gitattributes` and `.dockerignore` are pattern lists monaco has no grammar for —
  // stated explicitly rather than left to fall through the extension branch below (both basenames
  // have no `.` after their leading one, so `dot <= 0` would answer `plaintext` anyway; this says WHY
  // instead of leaving it to be inferred from a `<= 0` check three lines away).
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.dockerignore': 'plaintext',
  // A Justfile is `just`'s own recipe format — Makefile-shaped, shell-bodied, no grammar here either.
  justfile: 'plaintext',
  // Procfile (Heroku/foreman): `name: command` lines. No grammar; `ini` was considered and refused —
  // a shell command on the right of the colon routinely contains its OWN `key=value` pairs, which
  // `ini` would then paint as this file's top-level fields.
  procfile: 'plaintext',
}

/**
 * Is this basename a `.env` VARIANT — `.env.local`, `.env.production`, `.env.example`,
 * `.env.config`, `.env.local.example`?
 *
 * The trailing dot is load-bearing: without it `.environment` and `.envrc` would be swept in, and
 * neither is a dotenv file (`.envrc` is a shell script direnv sources). This matches the `.env.`
 * PREFIX only, so the suffix can be anything a project invents — which is the point, since that
 * suffix is an environment name and there is no list of those.
 */
function isDotenvVariant(base: string): boolean {
  return base.startsWith('.env.')
}

/**
 * Is this basename a Dockerfile VARIANT — `Dockerfile.dev`, `Dockerfile.prod`, `Dockerfile.base`?
 *
 * Same shape and same reason as `.env.*`: the part after the dot is a STAGE name a project invents,
 * so there is no list to enumerate, and the trailing dot is what keeps `dockerfiles.md` out.
 *
 * It was missing, and the asymmetry was visible on screen: `fileIcon.tsx` has had a `dockerfile.`
 * prefix rule from the start, so `Dockerfile.dev` wore the whale in the tree and then opened as
 * PLAIN TEXT — one file, two answers about what it is. The `.env` variants were fixed on both sides
 * at once; this one was fixed on one.
 */
function isDockerfileVariant(base: string): boolean {
  return base.startsWith('dockerfile.')
}

/**
 * **THE TWO JSON DIAGNOSTICS THIS APP RELAXES, AND WHY THEY STAY DATA RATHER THAN A FUNCTION HERE.**
 *
 * Monaco's built-in JSON language service treats a `//` comment or a trailing comma as an ERROR by
 * default (`monaco-editor/languages/features/json/register.js`'s own `diagnosticDefault`:
 * `comments: 'error'`, `trailingCommas: 'error'`) — right for `package.json`, wrong for
 * `tsconfig*.json` and `*.jsonc`, both of which legitimately carry both (`tsconfig.json` was the
 * probe: a `// a comment` and a trailing comma each drew a `.squiggly-error` reading "Comments are
 * not permitted in JSON.(521)").
 *
 * **There is no PER-FILE knob for this.** Every `.json`/`.jsonc` model on the page shares ONE
 * `jsonDefaults` object (Monaco's `schemas[].fileMatch` targets SCHEMA validation only — a different
 * setting entirely); the only way to tell `tsconfig.json` and `package.json` apart would be a
 * SECOND language id with its own worker-backed diagnostics config, which means reaching into
 * `jsonMode.js`'s un-typed, unexported `setupMode()` (there is no public API for a second JSON
 * language) — undocumented internals `monacoEntry.lint.test.ts`'s barrel-equality check would also
 * have to grow an exception for. This viewer makes no other claim of JSON strictness anywhere else
 * in the product, so the two diagnostics are relaxed for every `.json` file rather than only
 * `tsconfig*.json`/`*.jsonc`: the alternative is a `package.json` with a genuine trailing comma
 * going unflagged, which is the smaller and disclosed cost next to a `tsconfig.json` permanently
 * squiggly for syntax it is written in on purpose. `languageForPath` below does NOT map these to a
 * separate id — `tsconfig.json`/`*.jsonc` stay `'json'`, exactly like every other `.json` file; only
 * the shared diagnostics options move.
 *
 * This stays DATA, not a function that calls into `monaco.languages.json.jsonDefaults` itself,
 * because this module is deliberately MONACO-FREE (see the file header) — the caller
 * (`RepoFileEditor.tsx`, which already holds the loaded `monaco` module) merges this object into
 * `jsonDefaults`'s current options once, before the first editor mounts.
 */
export const JSON_DIAGNOSTICS_OVERRIDE = {
  comments: 'ignore',
  trailingCommas: 'ignore',
} as const

/**
 * Every language id this module can answer with.
 *
 * It exists for ONE assertion, and it is the assertion this file most needs: `monacoLanguage.test.ts`
 * checks each of these against the grammars `monacoEntry.ts` actually imports, so a plausible id
 * nothing registers — `'toml'`, `'vue'` and `'makefile'` all were, for as long as this table has
 * existed — cannot be added again. Monaco answers an unknown id with a model that has no tokenizer
 * and no error, which is indistinguishable from a language whose grammar is simply quiet.
 */
export function languageIdsInUse(): string[] {
  return [...new Set([
    ...Object.values(EXT_LANGUAGE), ...Object.values(NAME_LANGUAGE), DOTENV_LANGUAGE,
  ])].sort()
}

/**
 * Resolve a Monaco language id from a file path. Looks at the basename only (case-insensitive):
 * first a full-name match (Dockerfile, Makefile, `.env` — no extension to key on), then the two
 * families whose suffix is a NAME rather than an extension (`.env.*`, `Dockerfile.*`), then the
 * extension. An unknown or absent extension resolves to `plaintext` — a confident wrong
 * highlighting is worse than none, so this never guesses and never returns `undefined`.
 */
export function languageForPath(path: string): string {
  const base = (path.split('/').pop() ?? path).toLowerCase()
  const byName = NAME_LANGUAGE[base]
  if (byName) return byName
  if (isDotenvVariant(base)) return DOTENV_LANGUAGE
  if (isDockerfileVariant(base)) return NAME_LANGUAGE['dockerfile']!
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  const ext = base.slice(dot + 1)
  return EXT_LANGUAGE[ext] ?? 'plaintext'
}
