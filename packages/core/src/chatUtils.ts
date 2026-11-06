export const TOOL_LABELS: Record<string, string> = {
  agentistics_summary:           'Reading metrics',
  agentistics_projects:          'Fetching projects',
  agentistics_sessions:          'Loading sessions',
  agentistics_costs:             'Analyzing costs',
  agentistics_get_layouts:       'Reading layouts',
  agentistics_create_layout:     'Creating layout',
  agentistics_add_component:     'Adding component',
  agentistics_remove_component:  'Removing component',
  agentistics_set_active_layout: 'Activating layout',
  agentistics_delete_layout:     'Deleting layout',
  agentistics_build_layout:      'Building layout',
  agentistics_component_catalog: 'Reading catalog',
  agentistics_export_pdf:        'Generating PDF',
  agentistics_live_delivery:     'Checking live deliveries',

  // Codex tool types
  web_search_call:               'Web search',
  exec_command_call:             'Run command',
  exec_command:                  'Run command',
  apply_patch_call:              'Apply patch',
  local_shell_call:              'Shell command',
  custom_tool_call:              'Custom tool',
}

export function formatToolName(raw: string): string {
  const clean = raw.replace(/^mcp__\w+__/, '')
  return TOOL_LABELS[clean] ?? clean.replace(/_/g, ' ')
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Matches [→ label](/route) or [label](/route) where route starts with /
export const NAV_LINK_RE = /\[([^\]]+)\]\((\/[^)]*)\)/g

// Matches [label](pdf:URL) — PDF download button links
export const PDF_LINK_RE = /\[([^\]]+)\]\(pdf:([^)]+)\)/g

export interface NavLink { label: string; path: string }

/** Extract all navigation links from a markdown response. */
export function extractNavLinks(text: string): NavLink[] {
  const links: NavLink[] = []
  const re = new RegExp(NAV_LINK_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    links.push({ label: match[1]!.replace(/^→\s*/, ''), path: match[2]! })
  }
  return links
}

/** Returns text with all nav links removed (for display without buttons). */
export function stripNavLinks(text: string): string {
  return text.replace(new RegExp(NAV_LINK_RE.source, 'g'), '').trim()
}
