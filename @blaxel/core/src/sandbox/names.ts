// The control plane rejects a sandbox name with a 400 unless it is made of
// lowercase letters and digits, optionally separated by single hyphens, with no
// leading or trailing hyphen, and at most SANDBOX_NAME_MAX_LENGTH characters.

/** Longest sandbox name the API accepts. */
export const SANDBOX_NAME_MAX_LENGTH = 49;

const VALID_SANDBOX_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INVALID_CHARACTERS = /[^a-z0-9]+/g;

/**
 * True when the API accepts `name` as a sandbox name.
 *
 * Valid names use lowercase letters, digits and single hyphens between them
 * (`my-sandbox-1`), and are at most SANDBOX_NAME_MAX_LENGTH characters.
 * Uppercase letters, underscores, dots, spaces and leading, trailing or
 * doubled hyphens are rejected.
 */
export function isValidSandboxName(name: unknown): name is string {
  return typeof name === "string" && name.length <= SANDBOX_NAME_MAX_LENGTH && VALID_SANDBOX_NAME.test(name);
}

/**
 * Derive a valid sandbox name from any string, such as an external id.
 *
 * Lowercases `name`, replaces each run of other characters (underscores, dots,
 * spaces, ...) with one hyphen, trims hyphens at both ends and cuts the result
 * to SANDBOX_NAME_MAX_LENGTH characters. A valid name is returned unchanged, so
 * `sanitizeSandboxName("sesn_01AbC")` gives `"sesn-01abc"`.
 *
 * The mapping is lossy: ids that differ only by case or punctuation give the
 * same name. Keep the original id yourself (for example in a label) if you need
 * to map back to it.
 *
 * @throws Error when `name` has no letter or digit to build a name from.
 */
export function sanitizeSandboxName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(INVALID_CHARACTERS, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SANDBOX_NAME_MAX_LENGTH)
    .replace(/-+$/, "");
  if (!sanitized) {
    throw new Error(`Cannot derive a sandbox name from ${JSON.stringify(name)}: it has no letter or digit.`);
  }
  return sanitized;
}

/** Hint added to a rejected creation when the requested name breaks the rule. */
export function invalidSandboxNameHint(name: string | undefined): string {
  if (!name || isValidSandboxName(name)) return "";
  const hint = ` Sandbox names use lowercase letters, digits and single hyphens (at most ${SANDBOX_NAME_MAX_LENGTH} characters).`;
  try {
    return `${hint} sanitizeSandboxName(${JSON.stringify(name)}) gives ${JSON.stringify(sanitizeSandboxName(name))}.`;
  } catch {
    return hint;
  }
}
