/**
 * model-catalog-fields.ts — PURE: the model fields a harness option carries on the wire, from the
 * catalog (`model-catalog.ts`). One function so the wizard (`/api/fleet/new`) and `spawn-web.ts`
 * cannot drift apart on what they offer.
 *
 * `modelSuggestions` is what a client SENDS (the VS Code extension reads it), `models` is what a
 * person READS. Where the list is the CLI's own, both follow it; where it is the fallback table,
 * `modelSuggestions` keeps the spawn spec's ids, which `harnessModels.test.ts` pins equal to it.
 */

import type { ModelOption } from '@agentistics/core'

export interface CatalogFieldsInput {
  models: ModelOption[]
  source: 'cli' | 'table'
  freeText: boolean
}

export interface CatalogFields {
  modelSuggestions: string[]
  models: ModelOption[]
  modelsSource: 'cli' | 'table'
  modelFreeText: boolean
}

export function catalogFields(specSuggestions: readonly string[], catalog: CatalogFieldsInput | undefined): CatalogFields {
  if (!catalog) return { modelSuggestions: [...specSuggestions], models: [], modelsSource: 'table', modelFreeText: true }
  return {
    modelSuggestions: catalog.source === 'cli' ? catalog.models.map(m => m.id) : [...specSuggestions],
    models: catalog.models,
    modelsSource: catalog.source,
    modelFreeText: catalog.freeText,
  }
}
