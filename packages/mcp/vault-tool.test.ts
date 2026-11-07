import { describe, expect, test } from "bun:test";
import { checkVaultPassword, VAULT_PASSWORD_RULES } from "@agentistics/core";
import { vaultStatusTool } from "./vault-tool.js";

const view = {
  state: "open", wrappers: ["keychain", "touchid", "password", "recovery"], presence: true,
  unlockMethods: [{ id: "touchid", advanced: false, gestures: { enroll: 2, unlock: 1 } }, { id: "password", advanced: false }, { id: "fido2", advanced: true }],
  legacyAppCode: true, recoveryCreatedAt: "2026-11-07T10:00:00Z", autoLockMinutes: 30,
  kid: "k-123", protectorLabel: "macOS Keychain", items: [{ kind: "github-backup", file: "/home/x/.agentistics/vault/a.sealed" }],
};

describe("agentistics_vault_status", () => {
  test("states the methods in use, the methods offered and the legacy flag", () => {
    const a = vaultStatusTool(view);
    expect(a.state).toBe("open");
    expect(a.confirmsWith).toEqual(["touchid", "password"]);
    expect(a.offered).toEqual([{ id: "touchid", advanced: false }, { id: "password", advanced: false }, { id: "fido2", advanced: true }]);
    expect(a.legacyAppCode).toBe(true);
    expect(a.recoveryKey).toBe(true);
    expect(a.autoLockMinutes).toBe(30);
  });
  test("an ALLOWLIST: no key id, no item, no file path, no label leaks through", () => {
    const s = JSON.stringify(vaultStatusTool(view));
    for (const leak of ["k-123", "github-backup", ".sealed", "macOS Keychain", "gestures"]) expect(s).not.toContain(leak);
  });
  test("the body that owes a proof is read from its `view`", () => {
    const a = vaultStatusTool({ needsStepUp: true, code: "stepup-required", state: "open", view: { ...view, legacyAppCode: false } });
    expect(a.state).toBe("open");
    expect(a.legacyAppCode).toBe(false);
  });
  test("the password rules are the SAME table the page and the server read", () => {
    const r = vaultStatusTool({ state: "locked" }).passwordRules;
    expect(r.rules.map(x => x.id)).toEqual([...VAULT_PASSWORD_RULES]);
    expect(r.minLength).toBe(9);
    expect(r.minSpecial).toBe(2);
    // a password exactly at the stated minimums passes the shared checker; one under fails it
    expect(checkVaultPassword("Abcdef!#1").ok).toBe(true);
    expect(checkVaultPassword("Abcdefg!1").ok).toBe(false);
  });
  test("junk is answered with facts it can stand behind, never a throw", () => {
    const a = vaultStatusTool(null);
    expect(a.state).toBe("unknown");
    expect(a.confirmsWith).toEqual([]);
    expect(a.offered).toEqual([]);
    expect(vaultStatusTool({ unlockMethods: [{ id: "totp" }, null, { id: "hello" }] }).offered).toEqual([{ id: "hello", advanced: false }]);
  });
});
