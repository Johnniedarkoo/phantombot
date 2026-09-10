/**
 * User-editable short names for model ids used by `/model`.
 *
 * Aliases are deliberately a small config map, not a model registry. The
 * values are passed to the existing model-selection path unchanged.
 */

export type ModelAliases = Readonly<Record<string, string>>;

const ALIAS_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RESERVED_MODEL_WORDS = new Set([
  "list",
  "clear",
  "primary",
  "coding",
  "image",
]);

/**
 * Parse and validate `[models.aliases]` from TOML.
 *
 * Alias keys are normalized to lower case so slash-command lookup is
 * case-insensitive. A case-folded duplicate is rejected instead of silently
 * choosing whichever TOML key happened to be visited last.
 */
export function parseModelAliases(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isTable(value)) {
    throw new Error("[models.aliases] must be a TOML table of alias = model-id entries");
  }

  const aliases: Record<string, string> = {};
  for (const [rawName, rawModel] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (!ALIAS_NAME.test(rawName.trim())) {
      throw new Error(
        `invalid model alias '${rawName}': use letters, digits, '-' or '_' and start with a letter`,
      );
    }
    if (RESERVED_MODEL_WORDS.has(name)) {
      throw new Error(`invalid model alias '${rawName}': reserved by /model`);
    }
    if (Object.hasOwn(aliases, name)) {
      throw new Error(`duplicate model alias '${rawName}' (aliases are case-insensitive)`);
    }
    if (typeof rawModel !== "string" || rawModel.trim() === "") {
      throw new Error(`model alias '${rawName}' must point to a non-empty model id`);
    }
    aliases[name] = rawModel.trim();
  }
  return aliases;
}

export type ModelAliasResolution =
  | { ok: true; model: string; alias?: string }
  | { ok: false; error: string };

/**
 * Resolve an exact alias without fuzzy matching.
 *
 * A provider-qualified id (or a legacy bare id containing model punctuation)
 * remains a valid direct model selection. Bare alphabetic words are the
 * deliberately narrow alias-shaped form; rejecting an unknown one catches
 * `/model quwen` without taking away the existing `/model provider/model`
 * escape hatch.
 */
export function resolveModelAlias(
  input: string,
  aliases: ModelAliases | undefined,
): ModelAliasResolution {
  const trimmed = input.trim();
  const map = aliases ?? {};
  const key = trimmed.toLowerCase();
  const resolved = map[key];
  if (resolved !== undefined) return { ok: true, model: resolved, alias: key };

  if (Object.keys(map).length > 0 && /^[A-Za-z]+$/.test(trimmed)) {
    return {
      ok: false,
      error:
        `unknown model alias '${trimmed}' — available aliases: ` +
        Object.keys(map).sort().join(", "),
    };
  }
  return { ok: true, model: trimmed };
}

/** Find the configured alias for a model shown by a harness. */
export function modelAliasFor(
  model: string,
  aliases: ModelAliases | undefined,
  provider?: string,
): string | undefined {
  const shown = model.trim().toLowerCase();
  const providerPrefix = provider?.trim().toLowerCase();
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    const configured = target.trim().toLowerCase();
    if (configured === shown) return alias;
    if (providerPrefix && configured === `${providerPrefix}/${shown}`) return alias;
    if (providerPrefix && shown === `${providerPrefix}/${configured}`) return alias;
  }
  return undefined;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
