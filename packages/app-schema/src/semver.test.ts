import { describe, expect, it } from 'vitest';
import { compareSemver, isSemver, isSemverRange, satisfiesSemverRange } from './index.js';

describe('semver', () => {
  it('validates versions', () => {
    for (const v of ['0.0.0', '1.2.3', '1.0.0-alpha.1', '1.0.0+build.5', '10.20.30-rc.1+meta']) expect(isSemver(v), v).toBe(true);
    for (const v of ['1', '1.2', '1.2.3.4', '01.2.3', 'v1.2.3', '1.2.3-', '1.2.3-01']) expect(isSemver(v), v).toBe(false);
  });

  it('compares by precedence', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareSemver('1.0.0-beta', '1.0.0-alpha.1')).toBe(1);
    expect(compareSemver('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(() => compareSemver('x', '1.0.0')).toThrow();
  });

  it('validates ranges', () => {
    for (const r of ['*', '1.2.3', '^1.2.3', '~1.2.3', '>=1.0.0 <2.0.0', '>1.0.0', '<=2.0.0', '=1.0.0']) expect(isSemverRange(r), r).toBe(true);
    for (const r of ['', '^1', '1.x', '^1.0.0 ~1.0.0', '>= 1.0.0', 'latest', '1.0.0 || 2.0.0']) expect(isSemverRange(r), r).toBe(false);
  });

  it('checks satisfaction', () => {
    expect(satisfiesSemverRange('1.4.0', '^1.0.0')).toBe(true);
    expect(satisfiesSemverRange('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfiesSemverRange('0.2.5', '^0.2.0')).toBe(true);
    expect(satisfiesSemverRange('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfiesSemverRange('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfiesSemverRange('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfiesSemverRange('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfiesSemverRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesSemverRange('9.9.9', '*')).toBe(true);
    expect(satisfiesSemverRange('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesSemverRange('bad', '*')).toBe(false);
  });
});
