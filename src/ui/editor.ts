import type { Key } from 'ink';

export interface EditorState {
  value: string;
  cursor: number;
}

export interface EditOptions {
  wordSeparators?: string;
}

const DEFAULT_SEPARATORS = ' \t/\\.-_:@';

function chars(value: string): string[] {
  return Array.from(value);
}

function sanitize(input: string): string {
  return Array.from(input.replace(/\r\n|\r|\n/g, ' '))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('');
}

function wordStart(list: string[], cursor: number, separators: string): number {
  let index = cursor;
  while (index > 0 && separators.includes(list[index - 1] as string)) index--;
  while (index > 0 && !separators.includes(list[index - 1] as string)) index--;
  return index;
}

function wordEnd(list: string[], cursor: number, separators: string): number {
  let index = cursor;
  while (index < list.length && separators.includes(list[index] as string)) index++;
  while (index < list.length && !separators.includes(list[index] as string)) index++;
  return index;
}

export function createEditor(value = ''): EditorState {
  return { value, cursor: chars(value).length };
}

export function insertText(state: EditorState, text: string): EditorState {
  const clean = sanitize(text);
  if (!clean) return state;
  const list = chars(state.value);
  const inserted = chars(clean);
  list.splice(state.cursor, 0, ...inserted);
  return { value: list.join(''), cursor: state.cursor + inserted.length };
}

export function applyKey(
  state: EditorState,
  input: string,
  key: Key,
  options: EditOptions = {},
): EditorState | undefined {
  const separators = options.wordSeparators ?? DEFAULT_SEPARATORS;
  const list = chars(state.value);
  const { cursor } = state;
  const make = (next: string[], position: number): EditorState => ({
    value: next.join(''),
    cursor: Math.max(0, Math.min(position, next.length)),
  });

  if (key.backspace) {
    if (cursor === 0) return state;
    const start = key.meta || key.ctrl ? wordStart(list, cursor, separators) : cursor - 1;
    return make([...list.slice(0, start), ...list.slice(cursor)], start);
  }
  if (key.delete) {
    if (cursor >= list.length) return state;
    const end = key.meta ? wordEnd(list, cursor, separators) : cursor + 1;
    return make([...list.slice(0, cursor), ...list.slice(end)], cursor);
  }
  if (key.leftArrow) {
    return make(list, key.meta || key.ctrl ? wordStart(list, cursor, separators) : cursor - 1);
  }
  if (key.rightArrow) {
    return make(list, key.meta || key.ctrl ? wordEnd(list, cursor, separators) : cursor + 1);
  }
  if (key.home) return make(list, 0);
  if (key.end) return make(list, list.length);

  if (key.ctrl) {
    switch (input) {
      case 'a':
        return make(list, 0);
      case 'e':
        return make(list, list.length);
      case 'b':
        return make(list, cursor - 1);
      case 'f':
        return make(list, cursor + 1);
      case 'd':
        return cursor < list.length
          ? make([...list.slice(0, cursor), ...list.slice(cursor + 1)], cursor)
          : state;
      case 'u':
        return make(list.slice(cursor), 0);
      case 'k':
        return make(list.slice(0, cursor), cursor);
      case 'w': {
        const start = wordStart(list, cursor, separators);
        return make([...list.slice(0, start), ...list.slice(cursor)], start);
      }
      default:
        return undefined;
    }
  }
  if (key.meta) {
    if (input === 'b') return make(list, wordStart(list, cursor, separators));
    if (input === 'f') return make(list, wordEnd(list, cursor, separators));
    if (input === 'd') {
      const end = wordEnd(list, cursor, separators);
      return make([...list.slice(0, cursor), ...list.slice(end)], cursor);
    }
    return undefined;
  }
  if (key.return || key.escape || key.tab || key.upArrow || key.downArrow) return undefined;
  if (key.pageUp || key.pageDown) return undefined;
  if (!input) return undefined;
  return insertText(state, input);
}
