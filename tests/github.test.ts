import { parseRepo } from '../src/github/parse';

describe('parseRepo', () => {
  it('parses owner/repo', () => {
    expect(parseRepo('amitjha/rollback')).toEqual({ owner: 'amitjha', repo: 'rollback' });
  });

  it('parses hyphenated names', () => {
    expect(parseRepo('my-org/my-cool-repo')).toEqual({ owner: 'my-org', repo: 'my-cool-repo' });
  });

  it('parses dotted names', () => {
    expect(parseRepo('owner/repo.name')).toEqual({ owner: 'owner', repo: 'repo.name' });
  });

  it('rejects empty string', () => {
    expect(() => parseRepo('')).toThrow(/Invalid repo/);
  });

  it('rejects missing slash', () => {
    expect(() => parseRepo('just-a-name')).toThrow(/Invalid repo/);
  });

  it('rejects multiple slashes', () => {
    expect(() => parseRepo('a/b/c')).toThrow(/Invalid repo/);
  });

  it('rejects whitespace inside the name', () => {
    expect(() => parseRepo('owner name/repo')).toThrow(/Invalid repo/);
  });

  it('rejects an empty owner or repo segment', () => {
    expect(() => parseRepo('/repo')).toThrow(/Invalid repo/);
    expect(() => parseRepo('owner/')).toThrow(/Invalid repo/);
  });
});
