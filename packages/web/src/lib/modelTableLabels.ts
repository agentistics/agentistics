/**
 * modelTableLabels.ts — PURE. The words of the per-model token/cost table (`ModelBreakdown.tsx`), in
 * the reader's language.
 *
 * The table was the one block of the Costs/Home pages still printing English headings (MODEL, INPUT,
 * C.READ, ESTIMATED TOTAL…) under a Portuguese UI. Each column's FULL name is the shared token term
 * (`tokenLabel`, the same words the TOKENS card prints); the heading itself stays short because the
 * numeric columns are 56–64px wide, and the full name rides along as the heading's `title`.
 */
import { tokenLabel } from '@agentistics/core'

export type ModelTableLang = 'pt' | 'en'

export interface ModelTableColumn { short: string; full: string }

export interface ModelTableLabels {
  model: ModelTableColumn
  input: ModelTableColumn
  output: ModelTableColumn
  cacheRead: ModelTableColumn
  cacheWrite: ModelTableColumn
  cost: ModelTableColumn
  estimatedTotal: string
  blended: string
  blendedNote: string
  empty: string
}

export function modelTableLabels(lang: ModelTableLang): ModelTableLabels {
  const pt = lang === 'pt'
  return {
    model: { short: pt ? 'Modelo' : 'Model', full: pt ? 'Modelo' : 'Model' },
    input: { short: pt ? 'Entrada' : 'Input', full: tokenLabel('input', lang) },
    output: { short: pt ? 'Saída' : 'Output', full: tokenLabel('output', lang) },
    cacheRead: { short: pt ? 'L.Cache' : 'C.Read', full: tokenLabel('cacheRead', lang) },
    cacheWrite: { short: pt ? 'E.Cache' : 'C.Write', full: tokenLabel('cacheWrite', lang) },
    cost: { short: pt ? 'Custo' : 'Cost', full: pt ? 'Custo' : 'Cost' },
    estimatedTotal: pt ? 'Total estimado' : 'Estimated Total',
    blended: pt ? 'Todos os modelos (média ponderada)' : 'All models (blended)',
    blendedNote: pt
      ? '* Custo e tokens estimados pela taxa média ponderada — as sessões não registram o modelo usado individualmente.'
      : '* Cost and tokens estimated via blended rate — sessions do not record the model used individually.',
    empty: pt ? 'Nenhum dado de modelo disponível' : 'No model data available',
  }
}
