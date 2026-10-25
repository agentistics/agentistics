# Chat activity summary icons

Every collapsed `ToolActivity` summary (live, inline, divider) begins with a 14px
contextual icon. Its 5px text gap, inherited muted colour and left edge match
`SystemEventRow`; desktop activity summaries no longer have a 36px indent.
Running, error and unfinished indicators follow the summary so the text column
stays aligned regardless of execution status.

The most frequent activity kind determines the icon. Ties keep first appearance,
including unfinished steps. Commands use SquareTerminal, reads BookOpen, edits
FilePen, writes FilePlus, searches Search, web Globe, memory Brain, delegation Bot,
plans ClipboardList, skills Sparkles, and unknown tools Wrench.

For MCP activity, the most frequent server wins, again keeping first appearance on
ties. Server names are extracted from both `mcp__server__tool` and `mcp_server_tool`.
Agentistics uses its existing local minimalist mark (including central branding).
Other servers use Plug until a real local server logo is available. A failed logo
load also falls back to Plug. Harness logos are not used as MCP server logos.

The dev-only `/preview/chat-activity/` fixture renders real components with commands,
MCP with and without a known logo, and mixed runs beside task handback events.
Use `?theme=light` for light mode. Validate at 1280px and 390px inside `agentop run
--rm`; no API or personal session data is needed.
