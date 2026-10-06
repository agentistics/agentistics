/**
 * panelMeta.ts — ONE title and ONE one-line description per panel, EN/PT, for all fourteen ids in
 * `panelSlots.ts`.
 *
 * BEFORE THE RIGHT ICON RAIL, this table did not need to exist: the ten `live`/`gallery`/… panels
 * shared ONE container (`contents`) with one header saying "Conteúdo"/"Contents", and the tab strip
 * inside it was the only thing naming which of the ten was showing. Once each of them is its own
 * panel — its own rail icon, its own bottom tab, its own content-area header — the strip is gone and
 * something else has to say which one a reader is looking at. This is that something, read by:
 *  - the rail (`PanelRail.tsx`) for the icon, the hover/focus tooltip and (a later pass) the
 *    overflow dropdown's tile;
 *  - the content area's own header, for the title where "Conteúdo" used to sit unconditionally;
 *  - the bottom band's own tab meta table (`bandControls.tsx`'s `PanelBar`), which used to hardcode
 *    five entries and now reads all fourteen from here instead of carrying a second copy.
 *
 * PURE AND ICON-FREE ON PURPOSE. The icon is a `lucide-react` element, which only a `.tsx` file can
 * hold without pulling React into every pure module that wants a panel's plain English/Portuguese
 * name (`panelBar.ts` is one such caller, and it is deliberately not a component). `panelIconFor` in
 * `PanelRail.tsx` is the one place an id becomes a picture — the same split `panelMenuIconFor` in
 * `bandControls.tsx` already keeps between `lib/panelMenu.ts`'s icon IDS and their pictures.
 */

import type { PanelId } from './panelSlots'

export interface PanelMetaEntry {
  title: { en: string; pt: string }
  /** One line: what a reader finds behind this panel. Used by the rail's tooltip and, in a later
   *  pass, by the overflow dropdown's and the eye's own tiles (design §4/§5 — "a square with the
   *  icon, the title, and a one-line description"). */
  description: { en: string; pt: string }
}

export const PANEL_META: Record<PanelId, PanelMetaEntry> = {
  search: {
    title: { en: 'Search the conversation', pt: 'Buscar na conversa' },
    description: {
      en: 'Find any message in this session’s whole conversation, then copy it, forward it or go to it.',
      pt: 'Encontre qualquer mensagem da conversa inteira desta sessão e copie, encaminhe ou vá até ela.',
    },
  },
  live: {
    title: { en: 'Live', pt: 'Live' },
    description: {
      en: 'What this session is doing right now, as it happens.',
      pt: 'O que esta sessão está fazendo agora, em tempo real.',
    },
  },
  gallery: {
    title: { en: 'Gallery', pt: 'Galeria' },
    description: {
      en: 'What you sent this session and what it produced, grouped by message.',
      pt: 'O que você enviou para esta sessão e o que ela produziu, agrupado por mensagem.',
    },
  },
  skills: {
    title: { en: 'Skills', pt: 'Skills' },
    description: {
      en: 'The skills this session has invoked.',
      pt: 'As skills que esta sessão invocou.',
    },
  },
  agents: {
    title: { en: 'Subagents', pt: 'Subagentes' },
    description: {
      en: 'The subagents this session has launched, and what each one cost.',
      pt: 'Os subagentes que esta sessão lançou, e quanto cada um custou.',
    },
  },
  forks: {
    title: { en: 'Forks', pt: 'Forks' },
    description: {
      en: 'Conversations branched off this one.',
      pt: 'Conversas ramificadas a partir desta.',
    },
  },
  workflows: {
    title: { en: 'Workflows', pt: 'Workflows' },
    description: {
      en: 'Dynamic Workflow runs this session has started.',
      pt: 'Execuções de Dynamic Workflow que esta sessão iniciou.',
    },
  },
  mcps: {
    title: { en: 'MCPs', pt: 'MCPs' },
    description: {
      en: 'The MCP servers available to this session.',
      pt: 'Os servidores MCP disponíveis para esta sessão.',
    },
  },
  prs: {
    title: { en: 'PRs', pt: 'PRs' },
    description: {
      en: 'This repository’s pull requests.',
      pt: 'Os pull requests deste repositório.',
    },
  },
  tasks: {
    title: { en: 'Task', pt: 'Tarefa' },
    description: {
      en: 'Which task this session is filed under.',
      pt: 'Sob qual tarefa esta sessão está arquivada.',
    },
  },
  metrics: {
    title: { en: 'Metrics', pt: 'Métricas' },
    description: {
      en: 'Everything the store knows about this conversation — tokens, cost, duration.',
      pt: 'Tudo que o banco sabe sobre esta conversa — tokens, custo, duração.',
    },
  },
  studio: {
    title: { en: 'Studio', pt: 'Studio' },
    description: {
      en: 'Agentistics Studio (beta) — this session’s files as a tree, with search and an editor.',
      pt: 'Agentistics Studio (beta) — os arquivos desta sessão em árvore, com busca e editor.',
    },
  },
  hardware: {
    title: { en: 'Hardware', pt: 'Hardware' },
    description: {
      en: 'This machine’s own hardware resources.',
      pt: 'Os recursos de hardware desta máquina.',
    },
  },
  cli: {
    title: { en: 'Claude Code', pt: 'Claude Code' },
    description: {
      en: 'The session’s own assistant pane.',
      pt: 'O painel do próprio assistente da sessão.',
    },
  },
  shell: {
    title: { en: 'Shell', pt: 'Shell' },
    description: {
      en: 'A per-session utility shell, in this session’s own directory.',
      pt: 'Um shell utilitário por sessão, no diretório desta sessão.',
    },
  },
}

/** `panelTitle('skills', true)` → `'Skills'`. `cli`/`shell` carry a session-specific override
 *  elsewhere (`targetLabel`, which names the harness — "Claude Code" for a Claude session, its own
 *  mark for another) — this is the FALLBACK title for them, used only where no session/harness is in
 *  scope to ask `targetLabel` instead (the rail's own tooltip does have one, and prefers it). */
export function panelTitle(panel: PanelId, pt: boolean): string {
  return pt ? PANEL_META[panel].title.pt : PANEL_META[panel].title.en
}

export function panelDescription(panel: PanelId, pt: boolean): string {
  return pt ? PANEL_META[panel].description.pt : PANEL_META[panel].description.en
}
