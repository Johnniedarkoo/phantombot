/**
 * Write a secret collected by an interactive wizard into a persona's encrypted
 * vault.
 *
 * Before #452 the wizards (`phantombot voice`, `phantombot harness`, the
 * OpenClaw importer) persisted the keys they collected to a plaintext `.env`
 * file. Nothing reads those files at runtime any more, so a wizard that still
 * wrote one would silently collect a key and drop it on the floor. This is the
 * single replacement path: the ACTIVE persona's vault, which
 * `loadVaultIntoEnv()` injects into `process.env` at startup and
 * `reloadVaultForPersona()` refreshes before every harness spawn.
 *
 * Per-persona by construction: voice, routing and API keys are persona-scoped
 * settings, so the secret lands beside the config.toml that references it
 * rather than in one host-wide file every persona shared.
 *
 * Never throws — a wizard must not die between "operator pasted a key" and
 * "config written". Callers report `ok: false` in their own UI idiom.
 */

import { type Config, personaDir } from "../config.ts";
import { log } from "./logger.ts";
import { openPersonaVault } from "./vault.ts";

export interface SetPersonaSecretResult {
  ok: boolean;
  /** Persona whose vault was written (resolved, never blank on ok). */
  persona?: string;
  error?: string;
}

/**
 * Store `name`=`value` in `persona`'s vault (default persona when omitted) and
 * verify it by reading it back through the decrypt path — the same validation
 * gate the plaintext migration uses, so a wizard never reports success for a
 * key that did not survive the round trip.
 *
 * Also mirrors the value into `process.env` so the CURRENT process (a wizard
 * that goes on to call `pi --list-models`, say) sees it without a restart.
 */
export async function setPersonaSecret(
  config: Config,
  name: string,
  value: string,
  persona?: string,
): Promise<SetPersonaSecretResult> {
  const target = persona || config.defaultPersona;
  try {
    const vault = await openPersonaVault(personaDir(config, target));
    try {
      vault.set(name, value);
      if (vault.get(name) !== value) {
        // Name only — never the value.
        log.warn("vault: read-back mismatch on wizard write", { name });
        return { ok: false, persona: target, error: "read-back mismatch" };
      }
    } finally {
      vault.close();
    }
  } catch (e) {
    log.warn("vault: wizard write failed", {
      name,
      error: (e as Error).message,
    });
    return { ok: false, persona: target, error: (e as Error).message };
  }
  process.env[name] = value;
  return { ok: true, persona: target };
}

/**
 * Remove `name` from `persona`'s vault (and from the current `process.env`) —
 * the counterpart to `setPersonaSecret` for a wizard that clears a credential
 * (e.g. switching Pi provider without supplying a new key). Absent name is a
 * no-op success. Never throws.
 */
export async function unsetPersonaSecret(
  config: Config,
  name: string,
  persona?: string,
): Promise<SetPersonaSecretResult> {
  const target = persona || config.defaultPersona;
  try {
    const vault = await openPersonaVault(personaDir(config, target));
    try {
      vault.unset(name);
    } finally {
      vault.close();
    }
  } catch (e) {
    log.warn("vault: wizard unset failed", {
      name,
      error: (e as Error).message,
    });
    return { ok: false, persona: target, error: (e as Error).message };
  }
  delete process.env[name];
  return { ok: true, persona: target };
}
