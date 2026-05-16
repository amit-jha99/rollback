import { coerceFinding, coerceResult, extractJson } from '../src/ai/nvidia';

describe('extractJson', () => {
  it('returns raw JSON unchanged when there is no fence', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts JSON from prose-prefixed responses', () => {
    expect(extractJson('Here is the review:\n{"a":1}\nend')).toBe('{"a":1}');
  });

  it('grabs the outermost braces when nested', () => {
    expect(extractJson('{"a":1,"b":{"c":2}}')).toBe('{"a":1,"b":{"c":2}}');
  });
});

describe('coerceFinding', () => {
  it('parses a complete finding', () => {
    expect(coerceFinding({ file: 'src/x.ts', line: 5, description: 'd', fix: 'f' })).toEqual({
      file: 'src/x.ts',
      line: 5,
      description: 'd',
      fix: 'f',
    });
  });

  it('omits empty file string', () => {
    const f = coerceFinding({ file: '', line: 5, description: 'd', fix: 'f' });
    expect(f?.file).toBeUndefined();
  });

  it('omits non-string file', () => {
    const f = coerceFinding({ file: 42, line: 5, description: 'd', fix: 'f' });
    expect(f?.file).toBeUndefined();
  });

  it('coerces stringified line numbers', () => {
    expect(coerceFinding({ line: '7', description: 'd', fix: 'f' })?.line).toBe(7);
  });

  it('falls back to 0 for non-finite line numbers', () => {
    expect(coerceFinding({ line: 'NaN', description: 'd', fix: 'f' })?.line).toBe(0);
  });

  it('returns null when description is missing', () => {
    expect(coerceFinding({ line: 5, fix: 'f' })).toBeNull();
  });

  it('returns null on non-object input', () => {
    expect(coerceFinding(null)).toBeNull();
    expect(coerceFinding('string')).toBeNull();
    expect(coerceFinding(undefined)).toBeNull();
  });
});

describe('coerceResult', () => {
  const valid = {
    score: 8,
    riskLevel: 'low' as const,
    bugs: [],
    security: [],
    quality: [],
    summary: 'Looks good',
    approved: true,
  };

  it('parses a complete valid result', () => {
    expect(coerceResult(valid)).toEqual(valid);
  });

  it('clamps score to 1-10', () => {
    expect(coerceResult({ ...valid, score: 15 }).score).toBe(10);
    expect(coerceResult({ ...valid, score: -3 }).score).toBe(1);
  });

  it('rounds fractional scores', () => {
    expect(coerceResult({ ...valid, score: 7.6 }).score).toBe(8);
  });

  it('defaults unknown risk levels to medium', () => {
    expect(coerceResult({ ...valid, riskLevel: 'catastrophic' }).riskLevel).toBe('medium');
  });

  it('coerces non-array findings lists to empty arrays', () => {
    const result = coerceResult({ ...valid, bugs: 'not an array' });
    expect(result.bugs).toEqual([]);
  });

  it('filters invalid findings out of the list', () => {
    const result = coerceResult({
      ...valid,
      bugs: [
        { line: 5, description: 'real bug', fix: 'fix' },
        { line: 1 }, // no description - drops
        null,
        { line: 2, description: 'another', fix: 'another fix' },
      ],
    });
    expect(result.bugs).toHaveLength(2);
    expect(result.bugs[0].description).toBe('real bug');
  });

  it('coerces stringified score', () => {
    expect(coerceResult({ ...valid, score: '6' }).score).toBe(6);
  });

  it('throws when score is missing', () => {
    const { score: _omit, ...withoutScore } = valid;
    expect(() => coerceResult(withoutScore)).toThrow(/score/);
  });

  it('throws on non-object input', () => {
    expect(() => coerceResult(null)).toThrow(/JSON object/);
    expect(() => coerceResult('hello')).toThrow(/JSON object/);
  });

  it('defaults summary to empty string when missing', () => {
    const { summary: _omit, ...withoutSummary } = valid;
    expect(coerceResult(withoutSummary).summary).toBe('');
  });

  it('coerces approved to boolean', () => {
    expect(coerceResult({ ...valid, approved: 'yes' }).approved).toBe(true);
    expect(coerceResult({ ...valid, approved: 0 }).approved).toBe(false);
  });
});
