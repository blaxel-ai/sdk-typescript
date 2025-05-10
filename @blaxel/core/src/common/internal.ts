import crypto from "crypto";

export function getAlphanumericLimitedHash(input: string, maxSize: number = 48): string {
  const hash = crypto.createHash('md5').update(input).digest('hex');
  return hash.length > maxSize ? hash.substring(0, maxSize) : hash;
}

export function getGlobalUniqueHash(
  workspace: string,
  type: string,
  name: string
): string {
  const globalUniqueName = `${workspace}-${type}-${name}`;
  return getAlphanumericLimitedHash(globalUniqueName, 48);
}
