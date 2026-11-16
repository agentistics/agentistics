/** Guard inventories use the TypeScript parser: strings/comments are never executable sites.
 * Threat model: prevent accidental raw writers in our own code; deliberately obfuscated committed code is covered by
 * code review. Runtime code generation, process.binding and nonliteral globalThis/Bun access are forbidden outright.
 */
import ts from 'typescript'
import { createHash } from 'node:crypto'

export const digest = (s: string) => createHash('sha256').update(s).digest('hex')
export function source(src: string) { return ts.createSourceFile('inventory.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }
export function calls(src: string): Array<{ node: ts.CallExpression; file: ts.SourceFile; id: string }> {
  const file = source(src)
  const out: Array<{ node: ts.CallExpression; file: ts.SourceFile; id: string }> = []
  const printer = ts.createPrinter({ removeComments: true })
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const scope: string[] = []
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if ((ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p)) && p.name) scope.push(p.name.text)
        else if (ts.isMethodDeclaration(p)) scope.push(p.name.getText(file))
        else if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
          if (ts.isVariableDeclaration(p.parent)) scope.push(p.parent.name.getText(file))
          else if (ts.isPropertyAssignment(p.parent)) scope.push(p.parent.name.getText(file))
        }
      }
      out.push({ node: n, file, id: digest(scope.reverse().join('/') + '\n' + printer.printNode(ts.EmitHint.Unspecified, n, file)) })
    }
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out
}

const TASK = new Set(['upsertTask', 'patchTask', 'upsertSubtask', 'registerComposerSubtask'])
const prop = (e: ts.Expression): string | undefined => ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : undefined
const isContext = (e: ts.Expression | undefined): boolean => {
  if (!e) return false
  if (ts.isIdentifier(e)) return /^(guard|ctx|guardCtx)$/.test(e.text)
  if (ts.isPropertyAccessExpression(e)) return /^(guard|ctx|guardCtx)$/.test(e.name.text)
  if (ts.isCallExpression(e)) return /^(flowContext|unattributedContext|contextOfActor)$/.test(prop(e.expression) ?? '')
  if (ts.isObjectLiteralExpression(e)) return e.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText() === 'principal')
  return false
}
const optionContext = (e: ts.Expression | undefined) => !!e && ts.isObjectLiteralExpression(e) && e.properties.some(p =>
  (ts.isPropertyAssignment(p) && p.name.getText() === 'guard' && isContext(p.initializer)) ||
  (ts.isShorthandPropertyAssignment(p) && p.name.text === 'guard'))

export function contextSites(src: string) {
  return calls(src).flatMap(c => {
    const e = c.node.expression
    if (!ts.isPropertyAccessExpression(e)) return []
    const name = e.name.text
    if (!TASK.has(name) && !(name === 'update' && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'store') && !(name === 'update' && ts.isIdentifier(e.expression) && e.expression.text === 'store')) return []
    const arg = c.node.arguments[name === 'patchTask' ? 2 : 1]
    return [{ id: c.id, carries: name === 'update' || name === 'patchTask' ? optionContext(arg) : isContext(arg) }]
  })
}

const WRITES = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'createWriteStream', 'open', 'openSync'])
/**
 * r3 (QA r2 N3): names that write only when they come FROM a writing module (a bare `write(...)` is any local helper),
 * and the process surface (`cp`/`mv`/`install` through a child process write as surely as `writeFile`).
 */
const MODULE_WRITES = new Set(['write', 'writeSync', 'writev', 'writevSync', 'link', 'linkSync', 'symlink', 'symlinkSync', 'ftruncate', 'ftruncateSync', 'mkdtemp', 'exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork', '$'])
const PROPERTY_WRITES = new Set(['linkSync', 'symlinkSync', 'execFileSync', 'execSync', 'spawnSync'])
const WRITING_MODULE = /^(node:)?(fs(\/promises)?|child_process|worker_threads|module)$|^bun$/
const BUN_WRITES = new Set(['write', 'spawn', 'spawnSync', '$'])
const literalText = (e: ts.Node | undefined): string | undefined => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined
const isModuleCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
/** `x` or `await x` → x */
const unwrap = (e: ts.Expression): ts.Expression => ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e

/** r4: inventory the MODULE's capabilities, before interpreting calls or tracking aliases.
 * Importing fs/process/Worker/createRequire already makes a module capable of writing. A computed loader is
 * equally capable regardless of its current value; its exact expression must be pinned too.
 * Bun is conservatively treated as a capability on any reference (including reads and aliases).
 */
export function moduleCapabilities(src: string): string[] {
  const file = source(src)
  const out = new Set<string>()
  const module = (spec: ts.Node | undefined) => {
    const text = literalText(spec)
    if (text === undefined) out.add(`computed:${digest(spec?.getText(file) ?? '<missing>')}`)
    else if (WRITING_MODULE.test(text)) out.add(`module:${text.replace(/^node:/, '')}`)
  }
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) module(n.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) module(n.moduleReference.expression)
    if (isModuleCall(n)) module(n.arguments[0])
    if (ts.isIdentifier(n) && n.text === 'Bun') out.add('global:Bun')
    if (ts.isElementAccessExpression(n) && literalText(n.argumentExpression) === 'Bun') out.add('global:Bun')
    if (ts.isNewExpression(n) && n.expression.getText(file).split('.').at(-1) === 'Worker') out.add('constructor:Worker')
    ts.forEachChild(n, visit)
  }
  visit(file)
  return [...out].sort()
}

/** These constructs are forbidden, not grandfathered capabilities. */
export function forbiddenCapabilities(src: string): string[] {
  // Production files run as modules. Without a module marker TS parses top-level `await (x)` as a call to an
  // identifier named await, swallowing the global receiver. The marker has no executable inventory sites.
  const file = source('export {};\n' + src)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const e = unwrap(n.expression)
      const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) ? literalText(e.argumentExpression) : e.getText(file)
      if (/^(eval|Function)$/.test(name ?? '')) out.push(n.expression.getText(file))
    }
    if (ts.isPropertyAccessExpression(n) && unwrap(n.expression).getText(file) === 'process' && n.name.text === 'binding') out.push('process.binding')
    if (ts.isElementAccessExpression(n) && unwrap(n.expression).getText(file) === 'process' && literalText(n.argumentExpression) === 'binding') out.push('process.binding')
    if (ts.isElementAccessExpression(n) && /^(globalThis|Bun)$/.test(unwrap(n.expression).getText(file)) && literalText(n.argumentExpression) === undefined) out.push('computed:' + unwrap(n.expression).getText(file))
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out
}

/** Literal module edges, including re-exports and dynamic loaders. The inventory resolves relative/workspace/absolute paths. */
export function localImports(src: string): string[] {
  const file = source(src)
  const out: string[] = []
  const add = (n: ts.Node | undefined) => { const s = literalText(n); if (s !== undefined) out.push(s) }
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) add(n.moduleSpecifier)
    if (isModuleCall(n)) add(n.arguments[0])
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) add(n.moduleReference.expression)
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out.sort()
}

/**
 * Conservative: inventory every raw fs / process writer, including unknown/computed destinations and aliases — named,
 * default and namespace imports, `require` / `import()` with destructuring renames, element access (`fs['writeFileSync']`),
 * the Bun global however it is reached (`Bun`, `globalThis.Bun`, an alias), `Bun.file(p).write()`, `Bun.$`…, and the
 * child-process surface (`cp`/`mv` run as a process), `link`/`symlink` over a store.
 */
export function rawWriters(src: string) {
  const file = source(src)
  const aliases = new Map<string, string>()
  const namespaces = new Set<string>()
  const buns = new Set<string>(['Bun'])
  const bunFiles = new Set<string>()
  const isBun = (e: ts.Expression): boolean => {
    e = unwrap(e)
    if (ts.isIdentifier(e)) return buns.has(e.text)
    if (ts.isPropertyAccessExpression(e)) return /^(globalThis|global|self|window)$/.test(e.expression.getText(file)) && e.name.text === 'Bun'
    if (ts.isElementAccessExpression(e)) return /^(globalThis|global|self|window)$/.test(e.expression.getText(file)) && literalText(e.argumentExpression) === 'Bun'
    return false
  }
  const isBunFile = (e: ts.Expression): boolean => {
    e = unwrap(e)
    if (ts.isIdentifier(e)) return bunFiles.has(e.text)
    return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'file' && isBun(e.expression.expression)
  }
  const fromWritingModule = (e: ts.Expression): boolean => {
    e = unwrap(e)
    if (isModuleCall(e)) { const m = literalText(e.arguments[0]); return m === undefined || WRITING_MODULE.test(m) }
    if (ts.isPropertyAccessExpression(e)) return fromWritingModule(e.expression) || (ts.isIdentifier(e.expression) && namespaces.has(e.expression.text))
    return ts.isIdentifier(e) && namespaces.has(e.text)
  }
  for (const n of file.statements) {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier) || !WRITING_MODULE.test(n.moduleSpecifier.text)) continue
    const bindings = n.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const b of bindings.elements) aliases.set(b.name.text, b.propertyName?.text ?? b.name.text)
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (n.importClause?.name) namespaces.add(n.importClause.name.text)
  }
  // Two passes, so an alias declared after its use (hoisted function scope) is still seen.
  const bindAliases = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const e = unwrap(n.initializer)
      if (ts.isIdentifier(n.name)) {
        if (ts.isIdentifier(e) && (aliases.has(e.text) || WRITES.has(e.text))) aliases.set(n.name.text, aliases.get(e.text) ?? e.text)
        if (ts.isPropertyAccessExpression(e) && (WRITES.has(e.name.text) || (MODULE_WRITES.has(e.name.text) && fromWritingModule(e.expression)))) aliases.set(n.name.text, e.name.text)
        if (ts.isPropertyAccessExpression(e) && BUN_WRITES.has(e.name.text) && isBun(e.expression)) aliases.set(n.name.text, `Bun.${e.name.text}`)
        if (isBun(e)) buns.add(n.name.text)
        if (isBunFile(e)) bunFiles.add(n.name.text)
        if (fromWritingModule(e)) namespaces.add(n.name.text)
      } else if (ts.isObjectBindingPattern(n.name)) {
        const fromBun = isBun(e)
        const fromModule = fromWritingModule(e)
        for (const el of n.name.elements) {
          const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : undefined) : ts.isIdentifier(el.name) ? el.name.text : undefined
          if (!key || !ts.isIdentifier(el.name)) continue
          if (fromBun && BUN_WRITES.has(key)) aliases.set(el.name.text, `Bun.${key}`)
          else if (WRITES.has(key) || (fromModule && MODULE_WRITES.has(key))) aliases.set(el.name.text, key)
        }
      }
    }
    ts.forEachChild(n, bindAliases)
  }
  bindAliases(file); bindAliases(file)
  const writerName = (name: string) => WRITES.has(name) || MODULE_WRITES.has(name) || name.startsWith('Bun.')
  const sites = calls(src).filter(c => {
    const e = unwrap(c.node.expression)
    if (ts.isIdentifier(e)) { const a = aliases.get(e.text); return a !== undefined ? writerName(a) : WRITES.has(e.text) }
    if (ts.isElementAccessExpression(e)) {
      const key = literalText(e.argumentExpression)
      // `fs['writeFileSync']`, `Bun['write']`, or a COMPUTED member of a writing module / Bun: all writers.
      if (key === undefined) return isBun(e.expression) || fromWritingModule(e.expression)
      return WRITES.has(key) || PROPERTY_WRITES.has(key) || (MODULE_WRITES.has(key) && fromWritingModule(e.expression)) || (BUN_WRITES.has(key) && isBun(e.expression))
    }
    if (!ts.isPropertyAccessExpression(e)) return false
    const name = e.name.text
    if (isBun(e.expression)) return BUN_WRITES.has(name)
    if ((name === 'write' || name === 'writer') && isBunFile(e.expression)) return true
    return WRITES.has(name) || PROPERTY_WRITES.has(name) || (MODULE_WRITES.has(name) && fromWritingModule(e.expression))
  })
  // `Bun.$\`cp a b\`` and an imported `$` are tagged templates, not calls.
  const tagged: Array<{ node: ts.Node; file: ts.SourceFile; id: string }> = []
  const visit = (n: ts.Node) => {
    if (ts.isTaggedTemplateExpression(n)) {
      const t = unwrap(n.tag)
      const shell = (ts.isPropertyAccessExpression(t) && t.name.text === '$' && isBun(t.expression)) || (ts.isIdentifier(t) && aliases.get(t.text) !== undefined && writerName(aliases.get(t.text)!))
      if (shell) tagged.push({ node: n, file, id: digest('tagged\n' + n.getText(file)) })
    }
    ts.forEachChild(n, visit)
  }
  visit(file)
  return [...sites, ...tagged]
}

/** r3 (QA r2 N3): a production module importing a test-only module (`*.testing`, `*.fixture`, `*.test`) by any route. */
export function testOnlyImports(src: string): string[] {
  const file = source(src)
  const out: string[] = []
  const check = (spec: string | undefined) => { if (spec !== undefined && (/\.(testing|fixture|test)(\.[cm]?[jt]sx?)?$/.test(spec) || /(^|\/)e2e\//.test(spec))) out.push(spec) }
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) check(literalText(n.moduleSpecifier))
    if (isModuleCall(n)) check(literalText(n.arguments[0]))
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) check(literalText(n.moduleReference.expression))
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out
}

/**
 * r3 (QA r2 N3): every reference that can REACH the books — their file names, the data directory, the env overrides and
 * the path helpers. Deny by default: a module's multiset of these is pinned and may only shrink, so a writer whose
 * destination is retargeted to a book (or a new module handed a book path) grows it and fails.
 */
const REACH_IDENTS = new Set(['TASKS_FILE', 'AGENTISTICS_DATA_DIR', 'DEFAULT_AGENTISTICS_DATA_DIR', 'AGENTISTICS_TASKS_FILE', 'AGENTISTICS_DELIVERIES_FILE', 'AGENTISTICS_DIR',
  'defaultDeliveriesPath', 'defaultGuardLockPaths', 'defaultGuardsPath', 'defaultGuaranteesPath', 'guardPathsOf', 'mirrorPathFor'])
const REACH_TEXT = /(^|[/\\])(tasks|deliveries|guards|guarantees)\.json$|\.agentistics|^AGENTISTICS_(TASKS_FILE|DELIVERIES_FILE|DIR)$/
export function storeReach(src: string): string[] {
  const file = source(src)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && REACH_IDENTS.has(n.text)) out.push(`ident:${n.text}`)
    const text = literalText(n) ?? (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : undefined)
    if (text !== undefined && REACH_TEXT.test(text)) out.push(`text:${text}`)
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out.sort()
}
