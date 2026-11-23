/** AST inventory: only the actual context argument, in the writer's declared position, counts. */
import { contextSites } from './guard-ast.testing'

export const missingContextSites = (src: string): string[] => contextSites(src).filter(c => !c.carries).map(c => c.id)
export const missingContext = (src: string): number => missingContextSites(src).length
export const carryingContext = (src: string): number => contextSites(src).filter(c => c.carries).length
