import React from 'react'
import type { SurfaceHarnessId } from '@agentistics/core'
import { HARNESS_LABELS } from '../lib/harness'

interface NAtagProps {
  harness: SurfaceHarnessId
  /** Short label for the metric that is not available (e.g. "Agent metrics"). */
  label: string
}

/**
 * Muted placeholder rendered in place of a metric that the active harness
 * cannot produce. Only shown when a harness filter is active and
 * `!capable(harness, metric)` — never in the unified (all-harness) view.
 */
export function NAtag({ harness, label }: NAtagProps) {
  const harnessLabel = HARNESS_LABELS[harness] ?? harness
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: '28px 16px',
      color: 'var(--text-tertiary)',
      fontSize: 13,
    }}>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-tertiary)',
        letterSpacing: '0.03em',
      }}>
        N/A
      </span>
      <span style={{ fontSize: 12 }}>
        {label} — not available for {harnessLabel}
      </span>
    </div>
  )
}
