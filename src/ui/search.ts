import { useCallback, useState } from 'react';

export interface SearchFocus {
  typing: boolean;
  resume(): void;
  leave(): void;
}

export const REFINE_HINT = 'type to refine';

export function useSearchFocus(query: string): SearchFocus {
  const [active, setActive] = useState(false);
  const resume = useCallback(() => setActive(true), []);
  const leave = useCallback(() => setActive(false), []);
  return { typing: active && query.trim() !== '', resume, leave };
}

export function appendQuery(query: string, text: string): string {
  return query ? query + text : text.trimStart();
}
