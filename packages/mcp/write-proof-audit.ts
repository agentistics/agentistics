import ts from 'typescript'

/** Source audit for MCP write payloads. Missing/unsupported data flow fails closed.
 * Only explicit session fields and the three transport-tested payload builders are trusted.
 * A discarded call, comment, or proof on a different request cannot authorize a payload.
 */
/** A path argument that names a task write (`/api/tasks…`, `/api/task-files…`) — the routes `withTaskWriteProof` covers. */
const TASK_PATH = /^[`'"]\/api\/(tasks|task-files)(?=[/`'"?$])/

export interface ProofAuditOptions {
  /**
   * S0d: `apiSend` injects the pane's proof into every non-GET `/api/tasks*` / `/api/task-files*` body (`withTaskWriteProof`),
   * proven end to end by `task-write-proof.test.ts`. With this set, such a write is proven BY THE TRANSPORT unless the handler
   * itself writes a `session` field (any value but `sessionProof(…)`), deletes/assigns one, `Object.assign`s, uses a computed
   * key, or spreads the raw tool arguments — any of which could pre-empt the injection. Fails closed on each.
   */
  transportProvesTaskWrites?: boolean
}

export function proofAudit(source: string, ownerApprove = false, opts: ProofAuditOptions = {}): boolean {
  const file = ts.createSourceFile('handler.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = new Map<string, ts.Expression>()
  const modified = new Set<string>()
  const writes: ts.Expression[] = []
  /** Writes `apiSend` sends to a task route (their proof may come from the transport, `opts.transportProvesTaskWrites`). */
  const taskWrites = new Set<ts.Expression>()
  /** The handler writes / removes / merges a `session` field or spreads the raw arguments somewhere (transport proof refused). */
  let preempts = false
  const scan = (node: ts.Node) => {
    if ((ts.isPropertyAssignment(node) && node.name.getText(file) === 'session' && !(ts.isCallExpression(node.initializer) && node.initializer.expression.getText(file) === 'sessionProof'))
      || (ts.isShorthandPropertyAssignment(node) && node.name.text === 'session')
      || ts.isComputedPropertyName(node)
      || (ts.isPropertyAccessExpression(node) && node.name.text === 'session' && ts.isBinaryExpression(node.parent) && node.parent.left === node)
      || (ts.isElementAccessExpression(node) && /^["'`]session["'`]$/.test(node.argumentExpression.getText(file)))
      || ts.isDeleteExpression(node)
      || (ts.isCallExpression(node) && /^Object\.(assign|defineProperty|defineProperties)$/.test(node.expression.getText(file)))
      || (ts.isSpreadAssignment(node) && /^\(?\s*(a|args|rest)\s*(as\s+[\w<>]+\s*)?\)?$/.test(node.expression.getText(file)))) preempts = true
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      let target = node.left
      while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
      if (ts.isIdentifier(target)) modified.add(target.text)
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file)
      if (name === 'apiSend') {
        const payload = node.arguments[2] ?? ts.factory.createIdentifier('undefined')
        writes.push(payload)
        const path = node.arguments[1]
        const pathText = path && ts.isIdentifier(path) ? declarations.get(path.text)?.getText(file) : path?.getText(file)
        if (pathText && TASK_PATH.test(pathText)) taskWrites.add(payload)
      }
      if (name === 'fetch') writes.push(node.arguments[1] ?? ts.factory.createIdentifier('undefined'))
    }
    ts.forEachChild(node, scan)
  }
  scan(file)
  const proof = (node: ts.Expression | undefined): boolean => !!node && ts.isCallExpression(node) && node.expression.getText(file) === 'sessionProof'
  const maySetSession = (node: ts.Expression, seen = new Set<string>()): boolean => {
    if (ts.isParenthesizedExpression(node)) return maySetSession(node.expression, seen)
    if (ts.isObjectLiteralExpression(node)) return node.properties.some(p => ts.isSpreadAssignment(p)
      ? maySetSession(p.expression, seen) : !!p.name && (ts.isComputedPropertyName(p.name) || p.name.getText(file) === 'session'))
    if (ts.isConditionalExpression(node)) return maySetSession(node.whenTrue, seen) || maySetSession(node.whenFalse, seen)
    if (ts.isIdentifier(node) && !seen.has(node.text) && !modified.has(node.text)) {
      const value = declarations.get(node.text)
      if (value) return maySetSession(value, new Set([...seen, node.text]))
    }
    return true
  }
  const carries = (node: ts.Expression | undefined, seen = new Set<string>()): boolean => {
    if (!node) return false
    if (ts.isParenthesizedExpression(node)) return carries(node.expression, seen)
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text) || modified.has(node.text)) return false
      return carries(declarations.get(node.text), new Set([...seen, node.text]))
    }
    if (ts.isObjectLiteralExpression(node)) {
      let proven = false
      for (const p of node.properties) {
        if (ts.isSpreadAssignment(p)) {
          if (carries(p.expression, seen)) proven = true
          else if (maySetSession(p.expression)) proven = false
        } else if (ts.isPropertyAssignment(p)) {
          if (p.name.getText(file) === 'session') proven = proof(p.initializer)
          else if (p.name.getText(file) === 'body') proven = carries(p.initializer, seen)
          else if (ts.isComputedPropertyName(p.name)) proven = false
        }
      }
      return proven
    }
    if (ts.isPropertyAccessExpression(node) && ['body', 'payload'].includes(node.name.text)) return carries(node.expression, seen)
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file)
      if (['evidenceRequestOf', 'taskCommentRequest', 'bookTakeoverPayload'].includes(name)) return proof(node.arguments[1])
      if (name === 'JSON.stringify') return carries(node.arguments[0], seen)
    }
    if (ts.isConditionalExpression(node)) {
      // Legacy human-gate approve is explicitly owner-only; F5/S0a removes this transport exception.
      const ownerBranch = ownerApprove && node.condition.getText(file) === 'action === "approve"' && node.whenTrue.getText(file) === '{}'
      return (ownerBranch || carries(node.whenTrue, seen)) && carries(node.whenFalse, seen)
    }
    return false
  }
  const byTransport = (w: ts.Expression) => !!opts.transportProvesTaskWrites && !preempts && taskWrites.has(w)
  return writes.length > 0 && writes.every(w => carries(w) || byTransport(w))
}
