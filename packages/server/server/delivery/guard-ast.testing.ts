/** Guard inventories use the TypeScript parser: strings/comments are never executable sites. */
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
/** Conservative: inventory every raw fs writer, including unknown/computed destinations and aliases. */
export function rawWriters(src: string) {
  const file = source(src)
  const aliases = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const n of file.statements) {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier) || !/^(node:)?fs(?:\/promises)?$/.test(n.moduleSpecifier.text)) continue
    const bindings = n.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const b of bindings.elements) aliases.set(b.name.text, b.propertyName?.text ?? b.name.text)
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (n.importClause?.name) namespaces.add(n.importClause.name.text)
  }
  const bindAliases = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const e = n.initializer
      if (ts.isIdentifier(e) && (aliases.has(e.text) || WRITES.has(e.text))) aliases.set(n.name.text, aliases.get(e.text) ?? e.text)
      if (ts.isPropertyAccessExpression(e) && WRITES.has(e.name.text)) aliases.set(n.name.text, e.name.text)
    }
    ts.forEachChild(n, bindAliases)
  }
  bindAliases(file)
  return calls(src).filter(c => {
    const e = c.node.expression
    if (ts.isIdentifier(e)) return WRITES.has(aliases.get(e.text) ?? e.text)
    if (!ts.isPropertyAccessExpression(e)) return false
    const owner = e.expression.getText(c.file)
    return (owner === 'Bun' && e.name.text === 'write') || WRITES.has(e.name.text)
  })
}
