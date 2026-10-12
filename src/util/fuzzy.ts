export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export interface FuzzyResult<T> extends FuzzyMatch {
  item: T;
}

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 10;
const BONUS_PATH_BOUNDARY = 12;
const BONUS_CAMEL = 8;
const BONUS_CONSECUTIVE = 12;
const BONUS_BASENAME = 4;
const BONUS_BASENAME_START = 10;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTEND = 1;

function isPathSeparator(char: string | undefined): boolean {
  return char === '/' || char === '\\';
}

function isBoundary(char: string | undefined): boolean {
  return (
    char === undefined ||
    char === '_' ||
    char === '-' ||
    char === '.' ||
    char === ' ' ||
    char === ':'
  );
}

function basenameStart(text: string): number {
  let index = text.length - 1;
  while (index > 0 && isPathSeparator(text[index])) index--;
  while (index > 0 && !isPathSeparator(text[index - 1])) index--;
  return Math.max(0, index);
}

function scorePositions(text: string, positions: number[], baseStart: number): number {
  let score = 0;
  let previous = -2;
  for (const position of positions) {
    const char = text[position] ?? '';
    const before = position > 0 ? text[position - 1] : undefined;
    score += SCORE_MATCH;
    if (position === 0 || isPathSeparator(before)) score += BONUS_PATH_BOUNDARY;
    else if (isBoundary(before)) score += BONUS_BOUNDARY;
    else if (before && before === before.toLowerCase() && char !== char.toLowerCase()) {
      score += BONUS_CAMEL;
    }
    if (position === previous + 1) score += BONUS_CONSECUTIVE;
    else if (previous >= 0) {
      score -= PENALTY_GAP_START + (position - previous - 2) * PENALTY_GAP_EXTEND;
    }
    if (position >= baseStart) score += BONUS_BASENAME;
    if (position === baseStart) score += BONUS_BASENAME_START;
    previous = position;
  }
  return score;
}

function compactMatch(haystack: string, needle: string, from: number): number[] | undefined {
  let cursor = from;
  let end = -1;
  for (let index = 0; index < needle.length; index++) {
    const found = haystack.indexOf(needle[index] as string, cursor);
    if (found < 0) return undefined;
    end = found;
    cursor = found + 1;
  }
  const positions = new Array<number>(needle.length);
  let back = end;
  for (let index = needle.length - 1; index >= 0; index--) {
    while (haystack[back] !== needle[index]) back--;
    positions[index] = back;
    back--;
  }
  return positions;
}

function consecutive(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

function matchTerm(text: string, haystack: string, term: string, baseStart: number) {
  const candidates: number[][] = [];
  const fromStart = compactMatch(haystack, term, 0);
  if (!fromStart) return undefined;
  candidates.push(fromStart);
  if (baseStart > 0) {
    const inBase = compactMatch(haystack, term, baseStart);
    if (inBase) candidates.push(inBase);
  }
  const first = haystack.indexOf(term);
  if (first >= 0) {
    candidates.push(consecutive(first, term.length));
    const last = haystack.lastIndexOf(term);
    if (last !== first) candidates.push(consecutive(last, term.length));
  }

  let best: FuzzyMatch | undefined;
  for (const positions of candidates) {
    const score = scorePositions(text, positions, baseStart);
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { score: 0, positions: [] };

  const caseSensitive = query !== query.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();
  const baseStart = basenameStart(text);
  let score = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const result = matchTerm(text, haystack, term, baseStart);
    if (!result) return undefined;
    score += result.score;
    for (const position of result.positions) positions.add(position);
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  toText: (item: T) => string,
  limit = Number.POSITIVE_INFINITY,
): FuzzyResult<T>[] {
  if (!query.trim()) {
    return items.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
  }
  const results: (FuzzyResult<T> & { index: number; length: number })[] = [];
  items.forEach((item, index) => {
    const text = toText(item);
    const match = fuzzyMatch(query, text);
    if (match) results.push({ item, ...match, index, length: text.length });
  });
  results.sort((a, b) => b.score - a.score || a.length - b.length || a.index - b.index);
  return results.slice(0, limit).map(({ item, score, positions }) => ({ item, score, positions }));
}
