import type { Key } from 'ink';
import { useCallback, useState } from 'react';

export interface ListCursor {
  index: number;
  offset: number;
}

export function clampCursor(cursor: ListCursor, count: number, pageSize: number): ListCursor {
  if (count <= 0) return { index: 0, offset: 0 };
  const index = Math.max(0, Math.min(cursor.index, count - 1));
  let offset = Math.max(0, Math.min(cursor.offset, Math.max(0, count - pageSize)));
  if (index < offset) offset = index;
  if (index >= offset + pageSize) offset = index - pageSize + 1;
  return { index, offset };
}

export function moveCursor(
  cursor: ListCursor,
  key: Key,
  input: string,
  count: number,
  pageSize: number,
): ListCursor | undefined {
  if (count === 0) return undefined;
  let index: number;
  if (key.upArrow || (key.ctrl && input === 'p')) {
    index = cursor.index === 0 ? count - 1 : cursor.index - 1;
  } else if (key.downArrow || (key.ctrl && input === 'n')) {
    index = cursor.index >= count - 1 ? 0 : cursor.index + 1;
  } else if (key.pageUp) {
    index = Math.max(0, cursor.index - pageSize);
  } else if (key.pageDown) {
    index = Math.min(count - 1, cursor.index + pageSize);
  } else {
    return undefined;
  }
  return clampCursor({ index, offset: cursor.offset }, count, pageSize);
}

export function useListCursor(count: number, pageSize: number, initialIndex = 0) {
  const [raw, setRaw] = useState<ListCursor>(() =>
    clampCursor({ index: initialIndex, offset: 0 }, count, pageSize),
  );
  const cursor = clampCursor(raw, count, pageSize);

  const handle = useCallback(
    (input: string, key: Key) => {
      const next = moveCursor(clampCursor(raw, count, pageSize), key, input, count, pageSize);
      if (!next) return false;
      setRaw(next);
      return true;
    },
    [raw, count, pageSize],
  );

  const jump = useCallback(
    (index: number) => setRaw((current) => clampCursor({ ...current, index }, count, pageSize)),
    [count, pageSize],
  );

  return { ...cursor, handle, jump };
}
