function wildcardToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

export function matchWildcard(pattern: string, text: string): boolean {
  return wildcardToRegExp(pattern).test(text);
}

export function hasWildcard(pattern: string): boolean {
  return /[*?!]/.test(pattern);
}

export function matchPatternList(patterns: readonly string[], text: string): boolean {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (!matchWildcard(pattern, text)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}
