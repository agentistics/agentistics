/**
 * fileIcon.tsx — the glyph beside a name in the repository tree: a `.ts` file wearing a TypeScript
 * mark, a `Dockerfile` wearing a whale, `.env` wearing a key.
 *
 * **NO ICON PACKAGE, and that is the whole design constraint.** `material-icon-theme` and friends
 * ship a few thousand SVGs; this web bundle is compiled into the `agentop` binary every user
 * downloads, and the task immediately before this one cut 6.9 MB out of Monaco for exactly that
 * reason. So the marks below are drawn HERE, inline, and only for extensions that actually occur in
 * a repository — about thirty glyphs, every one of them a handful of path commands.
 *
 * **THEY ARE DRAWN, NOT COPIED.** Unlike `HarnessMark.tsx`, which inlines vendor files recorded in
 * `public/harness/SOURCES.md`, nothing here is a vendor asset: each mark is a simplified silhouette
 * or a letter badge authored in this file to be recognisable at 13-16px — a shield for the
 * web-platform trio, a whale with containers for Docker, `{ }` for JSON. No copyrighted artwork is
 * reproduced. The HUES are the languages' own (GitHub Linguist's colours as the starting point,
 * deepened where a pale one would vanish on the light theme), because recognition is the entire
 * point: an icon in the app's own accent palette would be decoration, not information.
 *
 * **THREE MARKS ARE SHARED ON PURPOSE, and the rule above is absolute about everything else.** A
 * `.vue` and a `.svelte` file wear the web-platform SHIELD (they are single-file components whose
 * body is markup, and it is the shield the mapping in `monacoLanguage.ts` already reaches for), and
 * `.kt` wears the Java badge's `JV`. These are stand-ins for languages with no mark of their own,
 * chosen because the family they name is right; they are NOT the same thing as a rule matching a
 * file it was never meant to match (`-lock.` once painted four hand-written TypeScript modules as
 * generated lockfiles — see `compoundIconId`). If a Kotlin letter badge is ever worth 3 lines, it
 * displaces `JV` and nothing else changes.
 *
 * **AN UNMAPPED EXTENSION GETS THE NEUTRAL GLYPH — never a near-miss.** `fileIconId` answers
 * `'file'`, which renders lucide's `File` in `--text-tertiary`: exactly the glyph this tree drew
 * before this module existed. A wrong icon is a statement about a file's contents, and the reader
 * cannot tell it from a right one; a neutral icon says nothing, which is the truth. Folders are the
 * same rule: they keep lucide's `Folder`/`FolderOpen` in the brand orange, unchanged, because those
 * two already read as the two states and lucide is the icon set the rest of this application uses.
 *
 * **THE RESOLUTION IS A PURE FUNCTION, and it is where the tests are.** `fileIconId(name, kind,
 * expanded)` takes a basename and returns an id; `ICONS` maps the id to a glyph. That split is what
 * lets `fileIcon.test.tsx` assert the parts that can be wrong — a compound name beating its own
 * extension (`docker-compose.yml` is Docker, not YAML), case-insensitivity, `.env.production`, and
 * that no id the resolver can return is missing a glyph — in a repo with no jsdom.
 */

import { File, Folder, FolderOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { MIN_UI_CONTRAST, contrastRatio } from '../../lib/monacoTheme'

// --- which glyph ---------------------------------------------------------------------------------

/**
 * Every glyph this module can draw. `'file'` is the fallback and `'folder'`/`'folder-open'` are the
 * two directory states; the rest are earned by a name.
 */
export type FileIconId =
  | 'file' | 'folder' | 'folder-open'
  | 'ts' | 'react' | 'js' | 'json' | 'markdown'
  | 'css' | 'sass' | 'less' | 'html'
  | 'config' | 'shell' | 'docker' | 'env' | 'lock' | 'git'
  | 'image' | 'svg'
  | 'python' | 'go' | 'rust' | 'java' | 'ruby' | 'php' | 'c' | 'cpp' | 'csharp' | 'sql' | 'text'

/** Whole basenames. Checked FIRST, so `.env` beats every extension rule. */
const BY_NAME: Record<string, FileIconId> = {
  'dockerfile': 'docker',
  // The OCI-neutral spelling — same whale, `monacoLanguage.ts` gives it the same grammar too.
  'containerfile': 'docker',
  '.dockerignore': 'docker',
  '.env': 'env',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitconfig': 'git',
  '.gitkeep': 'git',
  'go.sum': 'lock',
  // A Makefile is a file of COMMANDS, so it wears the terminal rather than the sliders: `config` is
  // for a file that is read as settings, and a near-miss is the one thing this module must not do.
  'makefile': 'shell',
  // Same shape as a Makefile — a Justfile's body is shell recipes, so it earns the same terminal.
  'justfile': 'shell',
  // `name: command` — closer to a settings file than to a script, so it wears the sliders instead.
  'procfile': 'config',
  '.editorconfig': 'config',
  '.npmrc': 'config',
  '.nvmrc': 'config',
  // M4: a reverse-proxy config file with no extension to key on — `nginx.conf` already lands on
  // `config` through the ordinary `.conf` extension rule below, and this is Caddy's equivalent.
  'caddyfile': 'config',
  // `LICENSE` is deliberately ABSENT. It has no extension and it is not a `.txt`; a TXT badge on it
  // would be a claim about a format nobody declared, and the neutral glyph is the honest answer.
}

/** Extensions. The long tail of a repository, and the last thing consulted before the fallback. */
const BY_EXT: Record<string, FileIconId> = {
  ts: 'ts', mts: 'ts', cts: 'ts',
  tsx: 'react', jsx: 'react',
  js: 'js', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  yml: 'config', yaml: 'config', toml: 'config', ini: 'config',
  conf: 'config', cfg: 'config', properties: 'config',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  lock: 'lock', lockb: 'lock',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  avif: 'image', bmp: 'image', ico: 'image',
  svg: 'svg',
  py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'java',
  rb: 'ruby', php: 'php',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', sql: 'sql',
  txt: 'text', log: 'text', csv: 'text',
  // `*.dockerfile` (named by extension rather than `Dockerfile` outright) and Terraform/HCL — both
  // audited alongside `monacoLanguage.ts`'s own niche-file pass.
  dockerfile: 'docker',
  tf: 'config', tfvars: 'config', hcl: 'config',
  // A Makefile FRAGMENT, included by a top-level one — same glyph as `makefile` above.
  mk: 'shell',
  // M4: no dedicated diagram glyph exists in this set, so a mermaid source file is grouped with
  // plain text rather than drawing the generic file glyph — the same honest-subset choice
  // `monacoLanguage.ts` makes when a real grammar is missing, not a claim that this is a good fit.
  mmd: 'text', mermaid: 'text',
}

/**
 * A compound name whose own extension would answer WRONG: `docker-compose.yml` is a Docker file
 * that happens to be YAML, and `pnpm-lock.yaml` is a lockfile that happens to be YAML.
 *
 * **EVERY RULE HERE IS ANCHORED AT BOTH ENDS, and two of them were not.** `base.includes('-lock.')`
 * matched anywhere in a name, and this repository's own `git ls-files` holds four files it painted
 * as generated lockfiles — `file-lock.ts`, `file-lock.test.ts`, `resume-lock.ts`,
 * `resume-lock.test.ts`, all TypeScript modules somebody wrote by hand. `docker-compose` was the
 * same shape one character short of the same bug (`docker-composer.ts` took the whale). That is the
 * confident-wrong-value the header forbids, produced by this module on the very repository it was
 * built to browse, so the rule below is now: a PREFIX carries its trailing dot and a SUFFIX is
 * pinned to `$`.
 *
 * Two of the prefixes stay open-ended on the right and that is deliberate, because the part after
 * the dot is a NAME rather than a format: `.env.<environment>` and `Dockerfile.<stage>` are both
 * invented per project, so there is no list to enumerate (`monacoLanguage.ts` says the same of
 * `.env.*`). The two that name a DATA format — a compose file and a `-lock` file — are pinned to
 * the extensions those formats actually use, which is what closes the hole.
 */
const LOCK_DATA = /-lock\.(json|ya?ml)$/
// `docker-compose.yml`, `docker-compose.prod.yml`, `compose.yaml`, `compose.override.yml` — anchored
// at BOTH ends for the same reason `-lock\.` is: `composer.yml` (a PHP composer file that happens to
// be YAML) must not take the whale, and `^compose\.` alone would have let it.
const COMPOSE = /^(docker-)?compose\.(.+\.)?ya?ml$/

function compoundIconId(base: string): FileIconId | null {
  if (base.startsWith('.env.')) return 'env'
  if (base.startsWith('dockerfile.')) return 'docker'
  if (COMPOSE.test(base)) return 'docker'
  // `package-lock.json`, `pnpm-lock.yaml`. `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`
  // and `bun.lockb` need no rule here at all — `.lock`/`.lockb` are ordinary extensions and `BY_EXT`
  // answers them, which is one fewer unanchored test to get wrong.
  if (LOCK_DATA.test(base)) return 'lock'
  return null
}

/**
 * Which glyph one row gets. Pure; never throws; the basename only — a path says nothing about a
 * file's type that its own name does not.
 */
export function fileIconId(name: string, kind: 'file' | 'dir', expanded = false): FileIconId {
  if (kind === 'dir') return expanded ? 'folder-open' : 'folder'
  const base = (name.split('/').pop() ?? name).toLowerCase()
  const byName = BY_NAME[base]
  if (byName !== undefined) return byName
  const compound = compoundIconId(base)
  if (compound !== null) return compound
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'file'
  return BY_EXT[base.slice(dot + 1)] ?? 'file'
}

// --- the marks -----------------------------------------------------------------------------------

/**
 * The hues. GitHub Linguist's language colours where they are legible on BOTH of this app's
 * backgrounds (`#0a0a0f` and `#f4f4f7`), deepened where they are not — Linguist's JavaScript
 * `#f1e05a` and React `#61dafb` are pale enough to disappear on the light theme, so they are carried
 * down into mid-tone. Fixed in both themes on purpose: a mark whose colour follows the theme is no
 * longer the language's mark.
 *
 * **"DEEPENED" IS NOW A MEASURED CLAIM, AND FOR SEVEN OF THEM IT WAS NOT.** The sentence above has
 * always been the rule; nothing enforced it, and seven hues sat under `MIN_UI_CONTRAST` — the same
 * 3:1 non-text floor `badgeInk` applies to a badge's own letters, and the floor `monacoTheme.ts`
 * lifts the caret to. Measured against `--bg-base` on each ground, before → after:
 *
 * ```
 *   js     #d6a400 → #ad8500   light 2.09 → 3.12   (dark 8.62 → 5.77)
 *   env    #d1a02a → #af8623   light 2.18 → 3.06   (dark 8.25 → 5.89)
 *   svg    #d98a2b → #c37a23   light 2.51 → 3.12   (dark 7.17 → 5.76)
 *   react  #2aa7c4 → #2699b3   light 2.58 → 3.04   (dark 6.98 → 5.92)
 *   json   #c08b12 → #b78411   light 2.76 → 3.03   (dark 6.53 → 5.95)
 *   go     #1f9fc7 → #1e98be   light 2.80 → 3.04   (dark 6.44 → 5.92)
 *   less   #2f5d9e → #3162a6   dark  2.99 → 3.22   (light 6.02 → 5.58)
 * ```
 *
 * `env` is why this is worth the churn: it is a stroke-only key with no badge behind it to carry it,
 * it is the file in a repository whose icon matters most to spot, and it was the second faintest
 * thing here on the light theme.
 *
 * Each replacement is `readable(original, <the failing ground>, MIN_UI_CONTRAST)` from
 * `monacoTheme.ts` — the same HSL walk the syntax colours take, so hue and saturation are untouched
 * and the mark is still the language's own. Written out as literals rather than computed at load
 * because a palette is read by people; `fileIcon.test.tsx` holds both grounds to the floor, so a
 * hand-edited hue that misses it fails the build instead of the eye.
 *
 * ONE lift moves a second decision: `badgeInk` gives `js` WHITE letters now, where the old pale gold
 * took near-black. That is not a coincidence to be tuned away — a badge pale enough for dark ink
 * needs a luminance above 0.30, and any such fill is below 2.70:1 on the light ground. Passing this
 * floor and carrying dark letters are mutually exclusive, so every badge here is white-on-colour.
 */
const HUE = {
  ts: '#3178c6',
  react: '#2699b3',
  js: '#ad8500',
  json: '#b78411',
  markdown: '#4a8ed6',
  css: '#2d6cb5',
  sass: '#cd6799',
  less: '#3162a6',
  html: '#e2642a',
  config: '#9a6cd4',
  shell: '#3f9c52',
  docker: '#1f8fd6',
  env: '#af8623',
  lock: '#8b8b94',
  git: '#e2683c',
  image: '#a169d8',
  svg: '#c37a23',
  python: '#3572a5',
  go: '#1e98be',
  rust: '#c4763a',
  java: '#b07219',
  ruby: '#cc342d',
  php: '#6272a4',
  c: '#6a737d',
  cpp: '#d1527a',
  csharp: '#2f8f2f',
  sql: '#2f8f8f',
  text: '#8b8b94',
} as const satisfies Record<string, string>

/**
 * The two `--bg-surface` values a mark is ACTUALLY drawn on — the tree's rows and an inactive tab
 * are both transparent over that backdrop, never `--bg-elevated` (that is the active tab's ground,
 * `ICON_GROUNDS_ELEVATED` below) and never `--bg-base` either. This constant named `--bg-base`
 * (`#0a0a0f`/`#f4f4f7`) until a live measurement of the computed ancestor chain found the real
 * ground one step lighter; the "DEEPENED" table above still records its original figures against
 * `--bg-base`; nothing here failed the floor once re-checked against the correct ground.
 */
export const ICON_GROUNDS = ['#111118', '#fafafc'] as const

/** Every hue a mark can be drawn in, for the test that holds each of them to the floor. */
export const ICON_HUES: Readonly<Record<string, string>> = HUE

/**
 * The ink on a letter badge: white when the badge is dark enough to carry it, near-black otherwise.
 *
 * `contrastRatio` and `MIN_UI_CONTRAST` are imported from `monacoTheme.ts` rather than re-derived.
 * It is generic colour arithmetic, the repo already has exactly one implementation of it, and a
 * second one here would be a second answer to "is this legible" — the duplication this codebase
 * refuses elsewhere. The floor is that module's 3:1, the non-text/large-glyph floor: a badge letter
 * at 13px is a SHAPE more than a word. It is the SAME floor `HUE` is now held to, which is the
 * point: one number, so the fill and the letters on it cannot be judged by two different rules.
 *
 * Every badge in the table above currently answers `#ffffff` — see `HUE` for why that is forced by
 * the floor rather than chosen. The branch stays because the floor is a property of a hue, and the
 * next hue somebody adds is the one it exists for.
 */
function badgeInk(badge: string): string {
  return contrastRatio('#ffffff', badge) >= MIN_UI_CONTRAST ? '#ffffff' : '#15151a'
}

interface GlyphProps { size: number }

/** The frame every drawn mark shares: a 16-unit square, scaled to the row's glyph size. */
function Svg({ size, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {children}
    </svg>
  )
}

/**
 * A rounded badge carrying one or two (at most three) characters — the shape the eye reads as "a
 * file of this language" without any logo being involved, and the reason thirty glyphs did not have
 * to be thirty drawings.
 */
function LetterBadge({ size, label, badge }: GlyphProps & { label: string; badge: string }) {
  // Three characters have to give up width to fit between the badge's rounded corners.
  const fontSize = label.length >= 3 ? 5.6 : label.length === 2 ? 7 : 8.4
  return (
    <Svg size={size}>
      <rect x="1" y="2.2" width="14" height="11.6" rx="2.4" fill={badge} />
      <text
        x="8"
        y="8"
        fill={badgeInk(badge)}
        fontSize={fontSize}
        fontWeight="700"
        fontFamily="'Inter', -apple-system, 'Segoe UI', sans-serif"
        textAnchor="middle"
        dominantBaseline="central"
        // The letters are drawn type, not a label: the row's own text already names the file, and a
        // screen reader reading "TS" before every filename would be noise.
        aria-hidden="true"
      >
        {label}
      </text>
    </Svg>
  )
}

/** The web platform's shield silhouette — CSS, Sass, Less and HTML, one shape, four hues. */
function Shield({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <path d="M2.4 2h11.2l-1.1 10.2L8 14.5 3.5 12.2z" fill={hue} />
      {/* The lighter half is what makes it read as a shield rather than a blob at 13px. */}
      <path d="M8 3.6v9.4l3.2-1.6.8-7.8z" fill="#ffffff" opacity="0.22" />
    </Svg>
  )
}

/** React's atom: a nucleus and three orbits. `.tsx` wears it in TypeScript blue, `.jsx` in cyan. */
function Atom({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <circle cx="8" cy="8" r="1.6" fill={hue} />
      {[0, 60, 120].map(deg => (
        <ellipse
          key={deg}
          cx="8"
          cy="8"
          rx="6.4"
          ry="2.5"
          stroke={hue}
          strokeWidth="1"
          transform={`rotate(${deg} 8 8)`}
        />
      ))}
    </Svg>
  )
}

/** The Markdown mark: a framed `M` with the down-arrow beside it. */
function MarkdownMark({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <rect x="0.8" y="3.4" width="14.4" height="9.2" rx="1.8" stroke={hue} strokeWidth="1.2" />
      <path
        d="M3.4 10.6V5.8l2.3 2.9 2.3-2.9v4.8"
        stroke={hue}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11.8 5.6v3.2" stroke={hue} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10.2 8.2h3.2l-1.6 2.4z" fill={hue} />
    </Svg>
  )
}

/** Two sliders — configuration, for the `.yml`/`.toml`/`.ini`/`Makefile` family. */
function Sliders({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <path d="M2 5.4h3.2M8.4 5.4h5.6M2 10.6h5.6M10.8 10.6H14" stroke={hue} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6.8" cy="5.4" r="1.8" fill={hue} />
      <circle cx="9.2" cy="10.6" r="1.8" fill={hue} />
    </Svg>
  )
}

/** A terminal: the prompt and a line of input. */
function Terminal({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <rect x="1" y="2.4" width="14" height="11.2" rx="2.2" fill={hue} opacity="0.16" />
      <rect x="1" y="2.4" width="14" height="11.2" rx="2.2" stroke={hue} strokeWidth="1.1" />
      <path
        d="M4 6.2l2 1.9-2 1.9"
        stroke={hue}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 10.2h4" stroke={hue} strokeWidth="1.3" strokeLinecap="round" />
    </Svg>
  )
}

/** Docker: the whale, with its stack of containers. */
function Whale({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <g fill={hue}>
        <rect x="3.4" y="6.6" width="2.1" height="2.1" rx="0.3" />
        <rect x="5.9" y="6.6" width="2.1" height="2.1" rx="0.3" />
        <rect x="8.4" y="6.6" width="2.1" height="2.1" rx="0.3" />
        <rect x="5.9" y="4.1" width="2.1" height="2.1" rx="0.3" />
      </g>
      <path
        d="M1.2 9.4h11.4c.5 1.9-.7 3.8-3.5 3.8H5.2C3 13.2 1.4 11.8 1.2 9.4z"
        fill={hue}
      />
      {/* The spout, which is what makes the shape read as a whale and not a barge. */}
      <path d="M13.2 8.4c.8-.6 1.6-.3 2 .3" stroke={hue} strokeWidth="1.1" strokeLinecap="round" />
    </Svg>
  )
}

/** A key — `.env` and its variants. The file that holds secrets is the one worth spotting fast. */
function Key({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <circle cx="5.2" cy="10.8" r="2.6" stroke={hue} strokeWidth="1.4" />
      <path d="M7.1 9 13 3.1" stroke={hue} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.2 5.9l1.5 1.5M11.6 4.5l1.5 1.5" stroke={hue} strokeWidth="1.4" strokeLinecap="round" />
    </Svg>
  )
}

/** A padlock — a lockfile is generated and not meant to be edited by hand. */
function Padlock({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <path d="M5.4 7.2V5.6a2.6 2.6 0 0 1 5.2 0v1.6" stroke={hue} strokeWidth="1.4" strokeLinecap="round" />
      <rect x="3" y="7" width="10" height="7" rx="1.8" fill={hue} />
    </Svg>
  )
}

/** A branch — the `.git*` files. */
function Branch({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <path d="M4.6 3.4v6.4" stroke={hue} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.6 6.6a5 5 0 0 1-5 5" stroke={hue} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="4.6" cy="3" r="1.9" fill={hue} />
      <circle cx="11.6" cy="4.8" r="1.9" fill={hue} />
      <circle cx="4.6" cy="12.4" r="1.9" fill={hue} />
    </Svg>
  )
}

/** A picture — raster images, and (in its own hue) SVG. */
function Picture({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <rect x="1.2" y="2.6" width="13.6" height="10.8" rx="2" fill={hue} opacity="0.18" />
      <rect x="1.2" y="2.6" width="13.6" height="10.8" rx="2" stroke={hue} strokeWidth="1.1" />
      <circle cx="5.3" cy="6.2" r="1.3" fill={hue} />
      <path d="M2.2 12.6l3.9-3.9 2.2 2.2 2.3-2.6 3.2 4.3z" fill={hue} />
    </Svg>
  )
}

/** `{ }` — JSON. */
function Braces({ size, hue }: GlyphProps & { hue: string }) {
  return (
    <Svg size={size}>
      <path
        d="M6.6 2.8C5 2.8 5.6 7.2 3.7 8c1.9.8 1.3 5.2 2.9 5.2"
        stroke={hue}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M9.4 2.8c1.6 0 1 4.4 2.9 5.2-1.9.8-1.3 5.2-2.9 5.2"
        stroke={hue}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Svg>
  )
}

/**
 * Id → glyph. A `Record`, so a new `FileIconId` is a compile error here until it is drawn — the same
 * reason `HARNESS_CAPABILITIES` is one.
 *
 * Every entry now takes the HUE AS A PARAMETER rather than reading `HUE.xxx` off the module scope —
 * the ONE change that lets `FileIcon` draw the same mark in a colour tuned for a ground other than
 * `--bg-base` (see `fileIconHueOnActiveTab`) without a second copy of the thirty drawings. The two
 * folder states and the fallback ignore it; every other entry passes it straight to the shape it
 * already took a `hue`/`badge` prop for.
 */
const ICONS: Record<FileIconId, (size: number, hue: string) => ReactNode> = {
  // The two delegated families. See the header: these are the glyphs the tree already used, and the
  // ones the rest of the application uses for the same two ideas. Neither reads `hue` — they draw in
  // `currentColor`, the caller's own text colour.
  file: size => <File size={size} />,
  folder: size => <Folder size={size} />,
  'folder-open': size => <FolderOpen size={size} />,

  ts: (size, hue) => <LetterBadge size={size} label="TS" badge={hue} />,
  react: (size, hue) => <Atom size={size} hue={hue} />,
  js: (size, hue) => <LetterBadge size={size} label="JS" badge={hue} />,
  json: (size, hue) => <Braces size={size} hue={hue} />,
  markdown: (size, hue) => <MarkdownMark size={size} hue={hue} />,

  css: (size, hue) => <Shield size={size} hue={hue} />,
  sass: (size, hue) => <Shield size={size} hue={hue} />,
  less: (size, hue) => <Shield size={size} hue={hue} />,
  html: (size, hue) => <Shield size={size} hue={hue} />,

  config: (size, hue) => <Sliders size={size} hue={hue} />,
  shell: (size, hue) => <Terminal size={size} hue={hue} />,
  docker: (size, hue) => <Whale size={size} hue={hue} />,
  env: (size, hue) => <Key size={size} hue={hue} />,
  lock: (size, hue) => <Padlock size={size} hue={hue} />,
  git: (size, hue) => <Branch size={size} hue={hue} />,

  image: (size, hue) => <Picture size={size} hue={hue} />,
  svg: (size, hue) => <Picture size={size} hue={hue} />,

  python: (size, hue) => <LetterBadge size={size} label="PY" badge={hue} />,
  go: (size, hue) => <LetterBadge size={size} label="GO" badge={hue} />,
  rust: (size, hue) => <LetterBadge size={size} label="RS" badge={hue} />,
  java: (size, hue) => <LetterBadge size={size} label="JV" badge={hue} />,
  ruby: (size, hue) => <LetterBadge size={size} label="RB" badge={hue} />,
  php: (size, hue) => <LetterBadge size={size} label="PHP" badge={hue} />,
  c: (size, hue) => <LetterBadge size={size} label="C" badge={hue} />,
  cpp: (size, hue) => <LetterBadge size={size} label="C++" badge={hue} />,
  csharp: (size, hue) => <LetterBadge size={size} label="C#" badge={hue} />,
  sql: (size, hue) => <LetterBadge size={size} label="SQL" badge={hue} />,
  text: (size, hue) => <LetterBadge size={size} label="TXT" badge={hue} />,
}

/** Every id, for the test that proves each of them draws something. */
export const FILE_ICON_IDS = Object.keys(ICONS) as FileIconId[]

export interface FileIconProps {
  /** The file or directory's own name (a full path works too — only the basename is read). */
  name: string
  kind: 'file' | 'dir'
  /** Directories only; ignored for a file. */
  expanded?: boolean
  size?: number
  /**
   * Draw the mark in THIS colour instead of its own `HUE` entry — see `fileIconHueOnActiveTab`. The
   * two folder states and the neutral fallback ignore it; they draw in `currentColor` regardless.
   */
  hue?: string
}

/**
 * The glyph for one row.
 *
 * The COLOUR is the mark's own, except for the three delegated glyphs, which inherit `currentColor`
 * from the row — so an unmapped file stays `--text-tertiary` and a folder stays the brand orange,
 * exactly as they were. A caller therefore sets the fallback colour by setting its own, and sets
 * nothing for a mapped file.
 */
export function FileIcon({ name, kind, expanded = false, size = 13, hue }: FileIconProps) {
  const id = fileIconId(name, kind, expanded)
  return <>{ICONS[id](size, hue ?? (HUE as Partial<Record<FileIconId, string>>)[id] ?? '')}</>
}

// --- a ground other than `--bg-base` ------------------------------------------------------------

/**
 * `--bg-elevated` in each theme — the ACTIVE tab's own ground in `TabStrip`, never `--bg-base`: an
 * inactive tab is transparent and sits on the same backdrop the tree already draws on, so only the
 * active one needs a floor of its own.
 */
export const ICON_GROUNDS_ELEVATED = ['#1e1e2e', '#f0f1f5'] as const

/**
 * `HUE`, LIFTED where `--bg-elevated` is not the ground it was tuned against.
 *
 * `--bg-elevated` sits CLOSER to every one of these marks than `--bg-base` does, in BOTH themes — a
 * ground with less contrast to spare, not a different one to tune for separately. Measured
 * 2026-09-12: eight of the twenty-seven fall under `MIN_UI_CONTRAST` there even though every one of
 * them clears it on `--bg-base` (`react`/`json`/`env`/`lock`/`git`/`go`/`text` on the LIGHT
 * `--bg-elevated`, `#f0f1f5`; `less` on the DARK one, `#1e1e2e`). Each replacement is
 * `readable(original, <the ground that failed>, MIN_UI_CONTRAST)` — the exact recipe the header's own
 * "DEEPENED" table used — and then RE-MEASURED against all four grounds (`ICON_GROUNDS` and
 * `ICON_GROUNDS_ELEVATED` together), because a lift aimed at one direction can spend the headroom the
 * other direction was relying on; none did here.
 *
 * A `Partial`, not a second full palette: nineteen of the twenty-seven already clear `--bg-elevated`
 * with their `HUE` value unchanged, so this only lists what actually needs to differ, and
 * `fileIconHueOnActiveTab` falls back to `HUE` for everything else — one table to drift, not two.
 * Written out as literals for the same reason `HUE` is: a palette is read by people. `fileIcon.test.tsx`
 * holds every one of them (and everything that fell through to `HUE`) to the floor on all four
 * grounds, so a hand-edited hue that misses it fails the build instead of the eye.
 *
 * ```
 *   react  #2699b3 → #2492ab   light-elevated 2.96 → 3.22
 *   json   #b78411 → #ae7d10   light-elevated 2.94 → 3.24
 *   less   #3162a6 → #366bb6   dark-elevated  2.68 → 3.07
 *   env    #af8623 → #a77f21   light-elevated 2.97 → 3.26
 *   lock   #8b8b94 → #86868f   light-elevated 2.99 → 3.20
 *   git    #e2683c → #e16133   light-elevated 2.96 → 3.12
 *   go     #1e98be → #1d91b5   light-elevated 2.96 → 3.22
 *   text   #8b8b94 → #86868f   light-elevated 2.99 → 3.20
 * ```
 */
const ACTIVE_TAB_HUE: Partial<Record<FileIconId, string>> = {
  react: '#2492ab',
  json: '#ae7d10',
  less: '#366bb6',
  env: '#a77f21',
  lock: '#86868f',
  git: '#e16133',
  go: '#1d91b5',
  text: '#86868f',
}

/**
 * The colour to draw `id` in on the ACTIVE tab. `undefined` for the two folder states and the
 * neutral fallback — they draw in `currentColor` and take no override at all.
 */
export function fileIconHueOnActiveTab(id: FileIconId): string | undefined {
  return ACTIVE_TAB_HUE[id] ?? (HUE as Partial<Record<FileIconId, string>>)[id]
}
