/**
 * The person's own NAMES for secret kinds ("Token do Mongo" over API key). A type is a LABEL over one of
 * the five base kinds: the sealed record keeps the base kind (its fields, its "só uso" default, its
 * validation) and only carries `typeId`, a pointer to the definition kept here. A definition that is gone
 * (removed, or not loaded yet) makes the secret read as its base kind — never as an error.
 *
 * Stored per person through `/api/user-prefs` (`vaultKinds`), like every choice; nothing here is a secret.
 */
import { useSyncExternalStore } from 'react'
import { createSharedPref } from './sharedPref'
import { PERSONAL_KINDS, type PersonalKind } from './vaultPersonal'

export interface VaultType { id: string; name: string; base: PersonalKind }
export interface VaultKinds { types: VaultType[] }

export const MAX_TYPES = 30
export const MAX_TYPE_NAME = 40
/** The select's last row: it opens the "create type" dialog and is never a value. */
export const NEW_TYPE = '__new_type__'

const EMPTY: VaultKinds = { types: [] }
const ID = /^kt_[a-z0-9]{4,24}$/

/** Total: anything unrecognised yields what is usable of it (a hand-edited or newer document). */
export function parseVaultKinds(raw: unknown): VaultKinds | null {
  if (raw === undefined || raw === null) return { types: [] }
  if (typeof raw !== 'object') return null
  const list = (raw as Record<string, unknown>).types
  if (!Array.isArray(list)) return { types: [] }
  const seen = new Set<string>()
  const types: VaultType[] = []
  for (const x of list) {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_TYPE_NAME) : ''
    if (typeof o.id !== 'string' || !ID.test(o.id) || seen.has(o.id) || !name || !(PERSONAL_KINDS as readonly string[]).includes(String(o.base))) continue
    seen.add(o.id)
    types.push({ id: o.id, name, base: o.base as PersonalKind })
    if (types.length >= MAX_TYPES) break
  }
  return { types }
}

const store = createSharedPref<VaultKinds>({ key: 'agentistics-vault-kinds', prefKey: 'vaultKinds', fallback: EMPTY, parse: parseVaultKinds })
export const useVaultTypes = (): VaultType[] => useSyncExternalStore(store.subscribe, store.get, store.serverSnapshot).types

/** Why a name cannot be used, or null when it can. `except` is the type being renamed. */
export function typeNameProblem(name: string, types: readonly VaultType[], except?: string): 'empty' | 'long' | 'taken' | null {
  const n = name.trim()
  if (!n) return 'empty'
  if (n.length > MAX_TYPE_NAME) return 'long'
  return types.some(t => t.id !== except && t.name.trim().toLowerCase() === n.toLowerCase()) ? 'taken' : null
}
/** A fresh id (`kt_` + 10 base-36 characters). */
export function newTypeId(rand: () => number = Math.random): string {
  let s = ''
  while (s.length < 10) s += Math.floor(rand() * 36).toString(36)
  return `kt_${s}`
}

/** PURE. The list with one type added (refused when the name is unusable or the list is full). */
export function withType(types: readonly VaultType[], name: string, base: PersonalKind, id = newTypeId()): { types: VaultType[]; created: VaultType | null } {
  if (typeNameProblem(name, types) || types.length >= MAX_TYPES) return { types: [...types], created: null }
  const created = { id, name: name.trim(), base }
  return { types: [...types, created], created }
}
export const renameType = (types: readonly VaultType[], id: string, name: string): VaultType[] =>
  typeNameProblem(name, types, id) ? [...types] : types.map(t => (t.id === id ? { ...t, name: name.trim() } : t))
export const removeType = (types: readonly VaultType[], id: string): VaultType[] => types.filter(t => t.id !== id)

/** Create / rename / remove through the shared store (written once the load has armed it). */
export function addVaultType(name: string, base: PersonalKind): VaultType | null {
  const r = withType(store.get().types, name, base)
  if (r.created) store.set({ types: r.types })
  return r.created
}
export const renameVaultType = (id: string, name: string): void => store.set({ types: renameType(store.get().types, id, name) })
export const removeVaultType = (id: string): void => store.set({ types: removeType(store.get().types, id) })

/** A secret's kind as the person reads it: its type's name when the definition exists, else the base kind's word. */
export function kindName(m: { kind: PersonalKind; typeId?: string }, types: readonly VaultType[], baseLabel: (k: PersonalKind) => string): string {
  const t = m.typeId ? types.find(x => x.id === m.typeId) : undefined
  return t ? t.name : baseLabel(m.kind)
}

/** The selector's options: the five base kinds, then the person's types, then "Criar tipo…". */
export function kindChoices(types: readonly VaultType[], baseLabel: (k: PersonalKind) => string, createLabel: string): { value: string; label: string }[] {
  return [
    ...PERSONAL_KINDS.map(k => ({ value: k as string, label: baseLabel(k) })),
    ...types.map(t => ({ value: t.id, label: `${t.name} · ${baseLabel(t.base)}` })),
    { value: NEW_TYPE, label: createLabel },
  ]
}
/** The selector's value for a row: the type when it still exists, else the base kind. */
export function choiceValue(c: { kind?: PersonalKind; typeId?: string }, types: readonly VaultType[], fallback: PersonalKind = 'env'): string {
  return c.typeId && types.some(t => t.id === c.typeId) ? c.typeId : c.kind ?? fallback
}
/** What a picked selector value means: a base kind (no label) or a type (its base + the label). */
export function resolveChoice(value: string, types: readonly VaultType[]): { kind: PersonalKind; typeId: string | null } | null {
  const t = types.find(x => x.id === value)
  if (t) return { kind: t.base, typeId: t.id }
  return (PERSONAL_KINDS as readonly string[]).includes(value) ? { kind: value as PersonalKind, typeId: null } : null
}
