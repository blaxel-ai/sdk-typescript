import crypto from "crypto";

export function getAlphanumericLimitedHash(input: string, maxSize: number): string {
  const hash = crypto.createHash("sha256").update(input).digest("base64");
  const alphanumeric = hash.replace(/[^a-z0-9]+/g, "");
  return alphanumeric.length > maxSize
    ? alphanumeric.substring(0, maxSize)
    : alphanumeric;
}

export function getGlobalUniqueHash(
  workspace: string,
  type: string,
  name: string
): string {
  const globalUniqueName = `${workspace}-${type}-${name}`;
  return getAlphanumericLimitedHash(globalUniqueName, 48);
}
