import { fuzzyMatch } from '../../util/fuzzy.js';

export interface RankedIndex {
  index: number;
  score: number;
  positions: number[];
}

function isSubsequence(needle: string, haystack: string): boolean {
  let position = 0;
  for (let index = 0; index < haystack.length && position < needle.length; index++) {
    if (haystack.charCodeAt(index) === needle.charCodeAt(position)) position++;
  }
  return position === needle.length;
}

export function rankTop(
  count: number,
  query: string,
  text: (index: number) => string,
  lower: (index: number) => string,
  limit: number,
): RankedIndex[] {
  const needle = query.replace(/\s+/g, '');
  if (!needle || limit <= 0) return [];
  const caseSensitive = needle !== needle.toLowerCase();
  const best: (RankedIndex & { length: number })[] = [];
  const worse = (a: { score: number; length: number }, b: { score: number; length: number }) =>
    a.score < b.score || (a.score === b.score && a.length >= b.length);

  for (let index = 0; index < count; index++) {
    const value = text(index);
    if (!isSubsequence(needle, caseSensitive ? value : lower(index))) continue;
    const match = fuzzyMatch(needle, value);
    if (!match) continue;
    const entry = { index, score: match.score, positions: match.positions, length: value.length };
    const last = best.at(-1);
    if (best.length >= limit && last && worse(entry, last)) continue;
    let at = best.length;
    while (at > 0 && worse(best[at - 1] as typeof entry, entry)) at--;
    best.splice(at, 0, entry);
    if (best.length > limit) best.pop();
  }
  return best.map(({ index, score, positions }) => ({ index, score, positions }));
}
