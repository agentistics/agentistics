import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// React #300: a hook below an early `return` changes the hook count between renders. Checked on the AST so
// generic calls (`useState<boolean>(false)`) and nested forms are not missed by a regex.
const FILES: Array<[string, string]> = [
  ['sessions/SessionChat.tsx', 'SessionChat'],
  ['../pages/CustomPage.tsx', 'CustomPage'],
  ['InfoModal.tsx', 'InfoModal'],
  ['BudgetPanel.tsx', 'BudgetPanel'],
]

function hooksAfterFirstEarlyReturn(file: string, name: string): string[] {
  const src = readFileSync(join(import.meta.dir, file), 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
  if (!fn?.body) throw new Error(`component ${name} not found in ${file}`)
  const stmts = fn.body.statements
  const isEarlyReturn = (s: ts.Statement) =>
    ts.isIfStatement(s) && (ts.isReturnStatement(s.thenStatement) || (ts.isBlock(s.thenStatement) && s.thenStatement.statements.some(ts.isReturnStatement)))
  const idx = stmts.findIndex(isEarlyReturn)
  if (idx < 0) return []
  const found: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== fn) return // hooks inside callbacks are not component-level calls
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use[A-Z]/.test(n.expression.text)) found.push(n.expression.text)
    ts.forEachChild(n, visit)
  }
  for (const s of stmts.slice(idx + 1)) visit(s)
  return found
}

describe('hooks stay above early returns', () => {
  for (const [file, name] of FILES) {
    test(name, () => { expect(hooksAfterFirstEarlyReturn(file, name)).toEqual([]) })
  }
})
