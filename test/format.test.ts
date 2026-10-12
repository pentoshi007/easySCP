import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatMode,
  formatRelative,
  truncateMiddle,
} from '../src/util/format.js';

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536 * 1024)).toBe('1.50 MB');
    expect(formatBytes(150 * 1024 ** 3)).toBe('150 GB');
  });

  it('handles invalid input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats short and long durations', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
});

describe('formatRelative', () => {
  it('describes elapsed time', () => {
    const now = 1_000_000_000_000;
    expect(formatRelative(now - 5_000, now)).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
});

describe('formatMode', () => {
  it('renders unix permissions', () => {
    expect(formatMode(0o755, true)).toBe('drwxr-xr-x');
    expect(formatMode(0o640, false)).toBe('-rw-r-----');
  });
});

describe('truncateMiddle', () => {
  it('keeps both ends', () => {
    expect(truncateMiddle('abcdef', 10)).toBe('abcdef');
    const result = truncateMiddle('/very/long/path/to/some/file.txt', 16);
    expect(result).toHaveLength(16);
    expect(result).toContain('…');
    expect(result.endsWith('file.txt')).toBe(true);
  });
});
