import { VAULT_PASSWORD_MIN_LENGTH, VAULT_PASSWORD_MIN_SPECIAL, VAULT_PASSWORD_RULES, VAULT_PASSWORD_RULE_TEXT } from "@agentistics/core";

/**
 * COFRE.DESBLOQUEIO — what the MCP says about the vault. PURE: it reduces the body of `GET /api/vault`
 * (the very view the `/vault` page draws) to an ALLOWLIST — never a spread-and-delete, so a field the
 * view gains later does not reach an agent by default. It carries facts about HOW the vault is
 * protected and never anything held inside it: no secret, no item list, no key id, no file path.
 *
 * Deliberately NOT tools: enrolling a way to confirm, unlocking, and generating a vault password. Each
 * of those either raises a confirmation only a person can give (Touch ID, Windows Hello, a key) or
 * would carry the vault password through an agent's transcript — a secret in clear, which this
 * product refuses everywhere. An agent reads the state and the rules, and may LOCK (locking only
 * reduces exposure, and the server's gate asks nothing for it).
 */

/** A way to confirm "it is you" that this machine offers (the server's `unlockMethodsFor`). */
export interface VaultMethodOffer { id: string; advanced: boolean }

export interface VaultStatusAnswer {
  /** `open` | `locked` | `uninitialized` | `corrupt` | `protector-lost`. */
  state: string;
  /** The ways to confirm this vault already uses (`touchid`, `hello`, `password`, `fido2`). */
  confirmsWith: string[];
  /** What this machine offers; `advanced` marks the security key (only when its tools are present). */
  offered: VaultMethodOffer[];
  /** True when the vault still carries an old app-code record: it is no longer asked anywhere, and
   *  is deleted as soon as a way to confirm is chosen. */
  legacyAppCode: boolean;
  /** Whether the 24-word recovery key exists. Never the words. */
  recoveryKey: boolean;
  autoLockMinutes: number | null;
  /** The rules a vault password must meet — the same table the page's live checklist and the
   *  server's refusal read (`@agentistics/core` vaultPassword.ts). */
  passwordRules: { minLength: number; minSpecial: number; rules: { id: string; en: string; pt: string }[] };
  /** Who decides: what a person has to do on the machine, said once. */
  note: string;
}

const PRESENCE = new Set(["touchid", "hello", "password", "fido2"]);

const rules = () => ({
  minLength: VAULT_PASSWORD_MIN_LENGTH,
  minSpecial: VAULT_PASSWORD_MIN_SPECIAL,
  rules: VAULT_PASSWORD_RULES.map(id => ({ id, ...VAULT_PASSWORD_RULE_TEXT[id] })),
});

/** The body of `GET /api/vault` — a view, or `{needsStepUp, view}` when the list owes a proof. */
export function vaultStatusTool(body: unknown): VaultStatusAnswer {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const v = (b.view && typeof b.view === "object" ? b.view : b) as Record<string, unknown>;
  const wrappers = Array.isArray(v.wrappers) ? v.wrappers.filter((w): w is string => typeof w === "string") : [];
  const offered = Array.isArray(v.unlockMethods)
    ? v.unlockMethods.flatMap(m => {
      const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
      return typeof o.id === "string" && PRESENCE.has(o.id) ? [{ id: o.id, advanced: o.advanced === true }] : [];
    })
    : [];
  const state = typeof v.state === "string" ? v.state : typeof b.state === "string" ? b.state : "unknown";
  return {
    state,
    confirmsWith: wrappers.filter(w => PRESENCE.has(w)),
    offered,
    legacyAppCode: v.legacyAppCode === true,
    recoveryKey: typeof v.recoveryCreatedAt === "string" && v.recoveryCreatedAt.length > 0,
    autoLockMinutes: typeof v.autoLockMinutes === "number" ? v.autoLockMinutes : null,
    passwordRules: rules(),
    note: "Setting up, unlocking and confirming are done by the person on the /vault page or with `agentop vault`; an agent never handles the vault password or the 24 words.",
  };
}
