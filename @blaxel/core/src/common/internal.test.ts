import { describe, expect, it } from 'vitest';
import { getAlphanumericLimitedHash, getGlobalUniqueHash } from './internal';



describe('getAlphanumericLimitedHash', () => {
  it('returns correct MD5 hash for a known string', () => {
    // MD5 of 'hello' is 5d41402abc4b2a76b9719d911017c592
    expect(getAlphanumericLimitedHash('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('respects the maxSize parameter', () => {
    const hash = getAlphanumericLimitedHash('hello', 8);
    expect(hash.length).toBe(8);
    expect(hash).toBe('5d41402a');
  });

  it('returns full hash if maxSize is larger than hash', () => {
    const hash = getAlphanumericLimitedHash('hello', 64);
    expect(hash).toBe('5d41402abc4b2a76b9719d911017c592');
  });
});

const testCases = [
  {
    workspace: 'charlou-dev',
    type: 'function',
    name: 'blaxel-search',
    expected: '594d9322779f4a07a55a7bf1050360c6'
  }, {
    workspace: 'charlou-dev',
    type: 'agent',
    name: 'toto',
    expected: '1bb3a151bda194751b062df8edb59eaf',
  }
]


describe('getGlobalUniqueHash', () => {
  testCases.forEach(({ workspace, type, name, expected }) => {
    it(`returns ${expected} for ${workspace}-${type}-${name}`, () => {
      expect(getGlobalUniqueHash(workspace, type, name)).toBe(expected);
    });
  });
});
