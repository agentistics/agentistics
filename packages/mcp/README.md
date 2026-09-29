# @agentistics/mcp

MCP server that exposes your [Claude Code](https://claude.ai/code) analytics as tools for Claude Desktop, Claude Code agents, and any MCP-compatible client.

## What it does

Reads data from `~/.claude/` (the same data [agentistics](https://github.com/blpsoares/agentistics) visualizes) and exposes it as 13 structured MCP tools.

## Usage

### With agentistics server (recommended)

The MCP server is included and auto-registered when you run `agentop server`. No separate install needed.

### Standalone with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentistics": {
      "command": "npx",
      "args": ["-y", "@agentistics/mcp"],
      "env": {
        "AGENTISTICS_API": "http://localhost:47291"
      }
    }
  }
}
```

The `AGENTISTICS_API` env var must point to a running agentistics server.

## Available tools

| Tool | Returns |
|------|---------|
| `agentistics_summary` | All-time totals: tokens, cost, sessions, streak — unified or per-harness |
| `agentistics_harnesses` | Side-by-side comparison of every tracked harness |
| `agentistics_projects` | Per-project token and cost breakdown (optionally per-harness) |
| `agentistics_sessions` | Recent sessions with harness, duration, model, cost |
| `agentistics_costs` | Model pricing breakdown and cache savings (optionally per-harness) |
| `agentistics_component_catalog` | Available dashboard components |
| `agentistics_get_layouts` | Current custom page layouts |
| `agentistics_build_layout` | Create a full layout from a component list |
| `agentistics_add_component` | Add one component to an existing layout |
| `agentistics_remove_component` | Remove a component by instance ID |
| `agentistics_create_layout` | Create a new empty layout |
| `agentistics_set_active_layout` | Switch the active /custom layout |
| `agentistics_delete_layout` | Delete a layout permanently |
| `agentistics_export_pdf` | Generate a PDF report download link for a date range |

## Requirements

Requires a running agentistics server (`agentop server` or the Windows desktop app). The MCP server proxies requests to `http://localhost:47291` by default.

## License

FSL-1.1-ALv2 — part of the [agentistics](https://github.com/blpsoares/agentistics) project.
