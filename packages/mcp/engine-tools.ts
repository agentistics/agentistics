/**
 * engine-tools.ts — the MCP tools an ENGINE declares (engine-api 1.30), listed and proxied by the MCP server.
 *
 * `GET /api/engine/mcp-tools` is read on list_tools (cached briefly; a failed fetch is no extra tools, never a
 * broken list). A call is a GET with the arguments as the query, or a POST with them as the JSON body, sent to the
 * path the engine declared — which is re-checked here (`mcpToolPathOk`) so a hostile answer cannot aim the proxy
 * elsewhere. A write carries the session proof, like the static write tools. `fetch` is injected for the tests.
 */
import { mcpToolRefusals, mcpToolPathOk, type EngineMcpTool } from "@agentistics/engine-api";
import { ENGINE_TOOL_PREFIX } from "@agentistics/core";
import { setEngineToolRisks } from "./agent-audit.js";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface Proof { id: string; token: string }

const CACHE_MS = 15_000;

export function createEngineTools(opts: { api: string; fetch?: Fetch; now?: () => number }) {
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? Date.now;
  let cache: { at: number; tools: EngineMcpTool[] } | null = null;

  async function list(): Promise<EngineMcpTool[]> {
    if (cache && now() - cache.at < CACHE_MS) return cache.tools;
    let tools: EngineMcpTool[] = [];
    try {
      const res = await f(`${opts.api}/api/engine/mcp-tools`);
      if (res.ok) {
        const body = (await res.json()) as { tools?: unknown };
        const raw = Array.isArray(body?.tools) ? (body.tools as EngineMcpTool[]) : [];
        tools = mcpToolRefusals(raw).length === 0 ? raw : [];
      }
    } catch { tools = []; }
    cache = { at: now(), tools };
    setEngineToolRisks(Object.fromEntries(tools.map(t => [t.name, t.risk])));
    return tools;
  }

  /** The MCP `Tool` entries to append to the static list. */
  async function mcpTools() {
    return (await list()).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: "object" } }));
  }

  /** `undefined` when `name` is not an engine tool (the caller falls through to its own switch). */
  async function call(name: string, args: Record<string, unknown> | undefined, proof: Proof | undefined) {
    if (!name.startsWith(ENGINE_TOOL_PREFIX)) return undefined;
    const tool = (await list()).find(t => t.name === name);
    if (!tool || !mcpToolPathOk(tool.path)) throw new Error(`Unknown tool: ${name}`);
    const a = args ?? {};
    let res: Response;
    if (tool.method === "GET") {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(a)) {
        if (v === undefined || v === null) continue;
        q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      const qs = q.toString();
      res = await f(`${opts.api}${tool.path}${qs ? `?${qs}` : ""}`);
    } else {
      const body = proof && a.session === undefined ? { ...a, session: proof } : a;
      res = await f(`${opts.api}${tool.path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${tool.method} ${tool.path} → HTTP ${res.status}${detail ? ` ${detail.slice(0, 400)}` : ""}`);
    }
    const out = await res.json().catch(() => ({}));
    return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
  }

  return { list, mcpTools, call };
}
