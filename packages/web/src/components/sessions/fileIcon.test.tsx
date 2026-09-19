/**
 * What can be asserted about an icon set, in a repo with no jsdom.
 *
 * The RESOLUTION (which is where every bug in an icon set lives: a compound name losing to its own
 * extension, a dotfile with no extension to key on, `.envrc` being swept in with `.env`), and the
 * fact that every id the resolver can return actually DRAWS something — an id with no glyph is an
 * empty cell where a name's icon should be, and `Record<FileIconId, …>` only catches it if the union
 * and the map are edited together.
 *
 * What is NOT asserted is whether a whale looks like a whale. That was checked by eye at 13px in
 * both themes.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MIN_UI_CONTRAST, contrastRatio } from '../../lib/monacoTheme'
import {
  FILE_ICON_IDS, FileIcon, ICON_GROUNDS, ICON_GROUNDS_ELEVATED, ICON_HUES, fileIconHueOnActiveTab,
  fileIconId, type FileIconId,
} from './fileIcon'

describe('fileIconId', () => {
  test('the extensions the brief asked for', () => {
    const cases: readonly [string, FileIconId][] = [
      ['a.ts', 'ts'], ['a.mts', 'ts'], ['a.tsx', 'react'], ['a.jsx', 'react'],
      ['a.js', 'js'], ['a.mjs', 'js'], ['a.json', 'json'], ['README.md', 'markdown'],
      ['a.css', 'css'], ['a.scss', 'sass'], ['a.less', 'less'], ['index.html', 'html'],
      ['ci.yml', 'config'], ['ci.yaml', 'config'], ['a.sh', 'shell'],
      ['logo.png', 'image'], ['logo.svg', 'svg'],
    ]
    for (const [name, id] of cases) expect(fileIconId(name, 'file'), name).toBe(id)
  })

  test('Docker, including the compose files whose extension would answer YAML', () => {
    expect(fileIconId('Dockerfile', 'file')).toBe('docker')
    expect(fileIconId('Dockerfile.dev', 'file')).toBe('docker')
    expect(fileIconId('.dockerignore', 'file')).toBe('docker')
    expect(fileIconId('docker-compose.yml', 'file')).toBe('docker')
    expect(fileIconId('docker-compose.override.yaml', 'file')).toBe('docker')
    expect(fileIconId('compose.yaml', 'file')).toBe('docker')
    // The point of the compound rule: the extension alone says config.
    expect(fileIconId('ci.yml', 'file')).toBe('config')
  })

  test('the niche-file audit: Containerfile, compose*.yml, HCL, Makefile fragments, and friends', () => {
    // The OCI-neutral Dockerfile spelling, and the extension form of the same file.
    expect(fileIconId('Containerfile', 'file')).toBe('docker')
    expect(fileIconId('app.dockerfile', 'file')).toBe('docker')
    // `compose*.yml` widened beyond the `docker-` prefix — and `composer.yml` must NOT take it.
    expect(fileIconId('compose.yml', 'file')).toBe('docker')
    expect(fileIconId('compose.override.yml', 'file')).toBe('docker')
    expect(fileIconId('composer.yml', 'file')).toBe('config')
    // Terraform/HCL.
    expect(fileIconId('main.tf', 'file')).toBe('config')
    expect(fileIconId('vars.tfvars', 'file')).toBe('config')
    expect(fileIconId('network.hcl', 'file')).toBe('config')
    // A Makefile fragment, a Justfile, a Procfile.
    expect(fileIconId('common.mk', 'file')).toBe('shell')
    expect(fileIconId('Justfile', 'file')).toBe('shell')
    expect(fileIconId('Procfile', 'file')).toBe('config')
    // *.toml and *.ini already worked; pinned here so the audit does not silently narrow them.
    expect(fileIconId('bunfig.toml', 'file')).toBe('config')
    expect(fileIconId('setup.ini', 'file')).toBe('config')
  })

  // M4: nginx.conf already lands on 'config' through the ordinary `.conf` extension rule (no rule
  // of its own needed); Caddyfile has no extension to key on and drew the neutral glyph until now.
  // `.mmd`/`.mermaid` have no dedicated diagram glyph in this set, so they join plain text rather
  // than the generic file icon.
  test('the niche-file audit: config files with no extension, and mermaid sources (M4)', () => {
    expect(fileIconId('nginx.conf', 'file')).toBe('config')
    expect(fileIconId('Caddyfile', 'file')).toBe('config')
    expect(fileIconId('diagram.mmd', 'file')).toBe('text')
    expect(fileIconId('flow.mermaid', 'file')).toBe('text')
  })

  test('.env and its variants, and NOT .envrc', () => {
    expect(fileIconId('.env', 'file')).toBe('env')
    expect(fileIconId('.env.local', 'file')).toBe('env')
    expect(fileIconId('.env.production', 'file')).toBe('env')
    expect(fileIconId('.env.example', 'file')).toBe('env')
    expect(fileIconId('.env.config', 'file')).toBe('env')
    expect(fileIconId('.envrc', 'file')).toBe('file')
  })

  test('lock files, whatever they are called', () => {
    for (const name of [
      'package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock',
      'pnpm-lock.yaml', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'uv.lock', 'go.sum',
    ]) {
      expect(fileIconId(name, 'file'), name).toBe('lock')
    }
  })

  test('the folder states', () => {
    expect(fileIconId('src', 'dir')).toBe('folder')
    expect(fileIconId('src', 'dir', true)).toBe('folder-open')
    // `expanded` is a directory's business only — a file never has it.
    expect(fileIconId('a.ts', 'file', true)).toBe('ts')
  })

  test('an unmapped extension gets the NEUTRAL glyph, never a near-miss', () => {
    for (const name of ['data.xyz123', 'LICENSE', 'notes', 'archive.tar.br']) {
      expect(fileIconId(name, 'file'), name).toBe('file')
    }
  })

  test('the basename only, and case-insensitively', () => {
    expect(fileIconId('deploy/Dockerfile', 'file')).toBe('docker')
    expect(fileIconId('src/lib/A.TS', 'file')).toBe('ts')
    expect(fileIconId('DOCKER-COMPOSE.YML', 'file')).toBe('docker')
  })

  /**
   * **THE HALF THIS SUITE DID NOT HAVE.** Every case above asserts a name GETS an icon; none
   * asserted that a name does not get a WRONG one, and that is exactly the gap `-lock.` walked
   * through — an unanchored `includes` that painted four hand-written modules of THIS repository as
   * generated lockfiles, with nothing red anywhere. A resolver that answers is not a resolver that
   * is right, so each rule that can over-reach is pinned against the name that proves it does not.
   */
  describe('the names a rule must NOT claim', () => {
    test('a `-lock` in the middle of a source file is not a lockfile', () => {
      // All four are real paths in this repository's own `git ls-files`, and all four resolved to
      // `lock` before `LOCK_DATA` was anchored to a data extension.
      for (const name of [
        'packages/server/server/sessions/file-lock.ts',
        'packages/server/server/sessions/file-lock.test.ts',
        'packages/server/server/sessions/resume-lock.ts',
        'packages/server/server/sessions/resume-lock.test.ts',
      ]) {
        expect(fileIconId(name, 'file'), name).toBe('ts')
      }
      // And the shape generally: only the formats a lockfile is actually written in are claimed.
      expect(fileIconId('use-lock.tsx', 'file')).toBe('react')
      expect(fileIconId('spin-lock.py', 'file')).toBe('python')
      expect(fileIconId('lock.md', 'file')).toBe('markdown')
    })

    test('a name that merely STARTS like docker-compose is not a compose file', () => {
      expect(fileIconId('docker-composer.ts', 'file')).toBe('ts')
      expect(fileIconId('docker-compose-helper.js', 'file')).toBe('js')
      // The compose files themselves still answer, middle part and all.
      expect(fileIconId('docker-compose.yml', 'file')).toBe('docker')
      expect(fileIconId('docker-compose.override.yml', 'file')).toBe('docker')
    })

    test('the letters of a mapped extension are not an extension', () => {
      // `.lock`/`.lockb` are ordinary extensions now; `lockfile` and `envelope.ts` are neither.
      expect(fileIconId('lockfile', 'file')).toBe('file')
      expect(fileIconId('envelope.ts', 'file')).toBe('ts')
      expect(fileIconId('.environment', 'file')).toBe('file')
    })
  })

  test('a name that is only an extension is not an extension', () => {
    // `.ts` as a whole filename has no stem; `lastIndexOf('.') === 0` is the guard, and the answer
    // is the neutral glyph rather than TypeScript's.
    expect(fileIconId('.ts', 'file')).toBe('file')
  })
})

describe('every id draws something', () => {
  test('the ids are a set, and the three delegated glyphs are among them', () => {
    // This used to loop `expect(FILE_ICON_IDS).toContain(id)` over `FILE_ICON_IDS` — true of any
    // array whatsoever, a green tick proving nothing. What IS worth asserting here is that the
    // exported list is a set (`ICONS`'s keys, so a duplicated id would mean a glyph silently
    // overwritten) and that the fallback and the two folder states did not get dropped from it;
    // every id actually DRAWING something is the test two below, which drives the whole table.
    expect(FILE_ICON_IDS.length).toBeGreaterThan(25)
    expect(new Set(FILE_ICON_IDS).size).toBe(FILE_ICON_IDS.length)
    for (const id of ['file', 'folder', 'folder-open'] satisfies FileIconId[]) {
      expect(FILE_ICON_IDS).toContain(id)
    }
  })

  test('a mapped file, an unmapped one and both folder states all render markup', () => {
    const cases: readonly [string, 'file' | 'dir', boolean][] = [
      ['a.ts', 'file', false], ['Dockerfile', 'file', false], ['.env', 'file', false],
      ['data.xyz123', 'file', false], ['src', 'dir', false], ['src', 'dir', true],
    ]
    for (const [name, kind, expanded] of cases) {
      const html = renderToStaticMarkup(<FileIcon name={name} kind={kind} expanded={expanded} />)
      expect(html, name).toContain('<svg')
      expect(html, name).toContain('aria-hidden="true"')
    }
  })

  test('every drawn mark produces an svg at the size it was given', () => {
    // Drives the WHOLE table, which is what catches a glyph that throws on render (a bad `transform`
    // array, a missing prop) rather than only the six sampled above.
    const names: Record<FileIconId, string> = {
      file: 'x.unknown', folder: 'dir', 'folder-open': 'dir',
      ts: 'a.ts', react: 'a.tsx', js: 'a.js', json: 'a.json', markdown: 'a.md',
      css: 'a.css', sass: 'a.scss', less: 'a.less', html: 'a.html',
      config: 'a.yml', shell: 'a.sh', docker: 'Dockerfile', env: '.env',
      lock: 'a.lock', git: '.gitignore',
      image: 'a.png', svg: 'a.svg',
      python: 'a.py', go: 'a.go', rust: 'a.rs', java: 'a.java', ruby: 'a.rb', php: 'a.php',
      c: 'a.c', cpp: 'a.cpp', csharp: 'a.cs', sql: 'a.sql', text: 'a.txt',
    }
    for (const id of FILE_ICON_IDS) {
      const name = names[id]
      const kind = id.startsWith('folder') ? 'dir' : 'file'
      const expanded = id === 'folder-open'
      // The name really does resolve to the id it is listed under — otherwise this loop would be
      // rendering the same glyph thirty times and proving nothing.
      expect(fileIconId(name, kind, expanded), `${id} ← ${name}`).toBe(id)
      const html = renderToStaticMarkup(
        <FileIcon name={name} kind={kind} expanded={expanded} size={16} />,
      )
      expect(html, id).toContain('<svg')
      expect(html, id).toContain('width="16"')
    }
  })

  test('a letter badge carries its letters, and its ink clears the floor against its own fill', () => {
    const ts = renderToStaticMarkup(<FileIcon name="a.ts" kind="file" size={16} />)
    expect(ts).toContain('TS')
    expect(ts).toContain('#3178c6')
    expect(ts).toContain('#ffffff')
    const js = renderToStaticMarkup(<FileIcon name="a.js" kind="file" size={16} />)
    expect(js).toContain('JS')

    // The PROPERTY, rather than one badge's answer. It used to be `js` must NOT take white ink,
    // which was true of the old pale gold and is false now the hue clears the light ground — and
    // the assertion would have been read as a regression rather than as the consequence it is. What
    // must hold for every badge, whatever the palette does next, is that the letters are legible on
    // the thing they are drawn on.
    const BADGES: readonly [string, string][] = [
      ['a.ts', 'ts'], ['a.js', 'js'], ['a.py', 'python'], ['a.go', 'go'], ['a.rs', 'rust'],
      ['a.java', 'java'], ['a.rb', 'ruby'], ['a.php', 'php'], ['a.c', 'c'], ['a.cpp', 'cpp'],
      ['a.cs', 'csharp'], ['a.sql', 'sql'], ['a.txt', 'text'],
    ]
    for (const [name, hueId] of BADGES) {
      const html = renderToStaticMarkup(<FileIcon name={name} kind="file" size={16} />)
      const fill = ICON_HUES[hueId]!
      expect(html, name).toContain(fill)
      const ink = html.includes('#ffffff') ? '#ffffff' : '#15151a'
      expect(contrastRatio(ink, fill), `${name}: ${ink} on ${fill}`)
        .toBeGreaterThanOrEqual(MIN_UI_CONTRAST)
    }
  })

  /**
   * **THE HEADER SAYS THESE ARE "deepened where a pale one would vanish on the light theme", and
   * for seven of them that was simply untrue** — `js` sat at 2.09:1 on `--bg-base`, `env` (a
   * stroke-only key, no badge behind it to carry the shape) at 2.18:1 — against the same 3:1
   * non-text floor this module already applies to a badge's own ink. A stated rule with nothing
   * asserting it is a rule that drifts, and three lines is the whole cost of it not drifting again.
   */
  test('every hue clears the shape floor on BOTH grounds', () => {
    for (const [id, hex] of Object.entries(ICON_HUES)) {
      for (const ground of ICON_GROUNDS) {
        expect(contrastRatio(hex, ground), `${id} ${hex} on ${ground}`)
          .toBeGreaterThanOrEqual(MIN_UI_CONTRAST)
      }
    }
  })

  /**
   * **`TabStrip`'s ACTIVE tab sits on `--bg-elevated`, and `ICON_HUES` was never proven readable
   * there.** Planting the defect this guards — reverting `fileIconHueOnActiveTab('react')` to
   * `ICON_HUES.react` (`#2699b3`) — drops the light-elevated ratio to 2.96:1 and fails this test;
   * restoring the lifted `#2492ab` passes it again.
   */
  test('the active-tab hue clears the shape floor on every ground, base and elevated alike', () => {
    for (const id of FILE_ICON_IDS) {
      const hue = fileIconHueOnActiveTab(id)
      if (hue === undefined) continue // the two folder states and the fallback draw in currentColor
      for (const ground of [...ICON_GROUNDS, ...ICON_GROUNDS_ELEVATED]) {
        expect(contrastRatio(hue, ground), `${id} ${hue} on ${ground}`)
          .toBeGreaterThanOrEqual(MIN_UI_CONTRAST)
      }
    }
  })

  test('a tab icon can be drawn in the active-tab hue without disturbing the tree default', () => {
    const active = renderToStaticMarkup(
      <FileIcon name=".env" kind="file" size={14} hue={fileIconHueOnActiveTab('env')} />,
    )
    expect(active).toContain('#a77f21')
    // The tree (and an inactive tab) still gets the ORIGINAL hue when no override is passed —
    // this refactor threading `hue` through every drawn glyph must not change a single default.
    const inactive = renderToStaticMarkup(<FileIcon name=".env" kind="file" size={14} />)
    expect(inactive).toContain(ICON_HUES.env!)
    expect(inactive).not.toContain('#a77f21')
  })
})
