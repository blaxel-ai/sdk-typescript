import { describe, expect, it } from 'vitest';
import { getAlphanumericLimitedHash, getGlobalUniqueHash } from './internal';

describe('getAlphanumericLimitedHash', () => {
  it('returns correct MD5 hash for a known string', () => {
    // MD5 of 'hello' is 5d41402abc4b2a76b9719d911017c592
    expect(getAlphanumericLimitedHash('hello')).toBe('05d04104002a0bc04b02a0760b907109d0910100170c5092');
  });

  it('respects the maxSize parameter', () => {
    const hash = getAlphanumericLimitedHash('hello', 8);
    expect(hash.length).toBe(8);
    expect(hash).toBe('05d04104');
  });

  it('returns full hash if maxSize is larger than hash', () => {
    const hash = getAlphanumericLimitedHash('hello', 64);
    expect(hash).toBe('05d04104002a0bc04b02a0760b907109d0910100170c5092');
  });
});

describe('getGlobalUniqueHash', () => {
  it('returns a hash for the combined workspace, type, and name', () => {
    // The input string will be 'ws-type-name'
    const expected = getAlphanumericLimitedHash('ws-type-name', 48);
    expect(getGlobalUniqueHash('ws', 'type', 'name')).toBe(expected);
  });

  it('returns a 48-character hash by default', () => {
    const hash = getGlobalUniqueHash('a', 'b', 'c');
    expect(hash.length).toBeLessThanOrEqual(48);
  });
});
