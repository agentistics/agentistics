/**
 * engine/engine-mcp-tools.ts — which of an engine's declared MCP tools `GET /api/engine/mcp-tools` lists.
 * With no engine, or when any declared tool is refused, the list is empty (declared absence, never a crash).
 */
import { mcpToolRefusals, type EngineMcpTool } from '@agentistics/engine-api'

export function engineMcpToolsFor(tools: readonly EngineMcpTool[] | undefined): EngineMcpTool[] {
  if (!tools || mcpToolRefusals(tools).length > 0) return []
  return tools.map(t => ({ ...t, inputSchema: { ...t.inputSchema } }))
}
