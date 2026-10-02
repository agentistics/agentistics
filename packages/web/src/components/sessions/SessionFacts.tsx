/**
 * SessionFacts — what a session row says about itself.
 *
 * Shared by the open list's row and the collapsed rail's tooltip, deliberately: the tooltip has to
 * carry exactly what the row carries, and two implementations of one card is how they come to
 * disagree — the same argument `rowMenu.ts` makes about the verbs and `task-reopen.ts` makes about
 * reopening.
 *
 * Extracted verbatim from `SessionRow`'s own body — nothing about the open row's rendering changes.
 */

import type React from 'react'
import { sessionNotify, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'

/**
 * A model id, shortened for a narrow column.
 *
 * The provider prefix and the dated suffix are what a person already knows or does not care about
 * in a sidebar — `anthropic/claude-sonnet-4-5-20250929` becomes `claude-sonnet-4-5`. The full id is
 * on the row's `title` attribute, so nothing is lost.
 */
export function shortModel(model: string): string {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return bare.replace(/-\d{8}$/, '')
}

export interface SessionFactsProps {
  session: ControlSession
  /** Bolder title — the same rule the open row uses (selected or wants a person). */
  selected?: boolean
  lang?: 'pt' | 'en'
  /**
   * Overrides the meta line's state-word color only — set by the Sessions aside's "neutral
   * background" card-color mode. The rest of the meta line (harness, model, delivery chip) keeps
   * its own colors regardless. Absent keeps the current wants-driven color on the state word
   * (orange when the session wants a person, tertiary otherwise), which is what the collapsed
   * rail's tooltip still gets: this is a Sessions-aside preference, not a fact about the row itself.
   */
  metaColor?: string
  /**
   * Also say the reasoning EFFORT the session was started with, after the model. Opt-in: the Nay
   * dock's list, where every row is the same assistant in the same folder, needs it to tell two
   * conversations apart. Absent effort draws nothing — no flag was passed, the harness default is
   * in force, and naming a level there would invent one.
   */
  withEffort?: boolean
}

export function SessionFacts({ session, selected = false, metaColor, withEffort = false }: SessionFactsProps) {
  const wants = sessionNotify(session)
  return (
    <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* The DELIVERY's name, read above the title. READ-ONLY on purpose: it used to have a clickable
          chip on the meta line too, and people kept hitting it by accident — filing a session is a
          verb in the row's menu, where it has to be asked for. */}
      {session.task && (
        <span style={{
          fontSize: 9.5, color: 'var(--text-tertiary)', fontWeight: 600,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {session.task}
        </span>
      )}
      <span style={{
        fontSize: session.task ? 13.5 : 12.5,
        fontWeight: (selected || wants ? 650 : 500) + (session.task ? 50 : 0),
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {session.title}
      </span>
      <span style={{
        // `overflow: hidden` is what makes the shrinkable cells below matter: without it a flex row
        // wider than its card simply paints past the edge, and the harness name ran out of the card.
        display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden',
        fontSize: 10.5, color: wants ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
      }}>
        <span style={{ flexShrink: 0, color: metaColor }}>{session.stateLabel}</span>
        <span style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
        <span style={{
          color: (HARNESS_COLORS as Record<string, string>)[session.harness] ?? 'var(--text-tertiary)',
          fontWeight: 650, minWidth: 0, flexShrink: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {(HARNESS_LABELS as Record<string, string>)[session.harness] ?? session.harness}
        </span>
        {/* The model, when the row knows one. A row that does not is not "some default model" —
            it is unknown, and inventing a name there is the confident-zero defect in words. */}
        {session.model && (
          <>
            <span style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
            {/* Shrinks first (`flexShrink: 3`): the model is the fact a person can least do without
                the least — the state and the assistant's name are what they scan for. */}
            <span style={{ minWidth: 0, flexShrink: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {shortModel(session.model)}
            </span>
          </>
        )}
        {withEffort && session.effort && (
          <>
            <span style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
            <span style={{ flexShrink: 0 }}>{session.effort}</span>
          </>
        )}
      </span>
    </span>
  )
}
