import ts from 'typescript'

/** Source audit for MCP write payloads. Missing/unsupported data flow fails closed.
 * Only explicit session fields and the three transport-tested payload builders are trusted.
 * A discarded call, comment, or proof on a different request cannot authorize a payload.
 */
export function proofAudit(source: string, ownerApprove = false): boolean {
  const file = ts.createSourceFile('handler.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = new Map<string, ts.Expression>()
  const modified = new Set<string>()
  const writes: ts.Expression[] = []
  const scan = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      let target = node.left
      while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
      if (ts.isIdentifier(target)) modified.add(target.text)
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(file)
      if (name === 'apiSend') writes.push(node.arguments[2] ?? ts.factory.createIdentifier('undefined'))
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
  return writes.length > 0 && writes.every(w => carries(w))
}
