import { formatRisk, ROLLBACK_VERSION, printWelcome } from '../src/utils/helpers';

describe('formatRisk', () => {
  it('renders low risk with green and safe-to-merge text', () => {
    const out = formatRisk('low');
    expect(out).toContain('Low Risk');
    expect(out).toContain('safe to merge');
  });

  it('renders medium risk with the review-carefully text', () => {
    const out = formatRisk('medium');
    expect(out).toContain('Medium Risk');
    expect(out).toContain('review carefully');
  });

  it('renders high risk with the do-not-merge text', () => {
    const out = formatRisk('high');
    expect(out).toContain('High Risk');
    expect(out).toContain('do not merge');
  });
});

describe('ROLLBACK_VERSION', () => {
  it('exposes a semver-shaped version string', () => {
    expect(ROLLBACK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('printWelcome', () => {
  it('emits the banner to stdout without throwing', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      printWelcome();
      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('Welcome to Rollback');
      expect(output).toContain("Amit Jha");
      expect(output).toContain(ROLLBACK_VERSION);
    } finally {
      spy.mockRestore();
    }
  });
});
