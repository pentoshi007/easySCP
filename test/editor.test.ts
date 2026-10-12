import { describe, expect, it } from 'vitest';
import { applyKey, createEditor, type EditorState, insertText } from '../src/ui/editor.js';
import { clampCursor, moveCursor } from '../src/ui/list.js';
import { key } from './helpers/ink.js';

function type(state: EditorState, ...inputs: (string | Parameters<typeof key>[0])[]) {
  let current = state;
  for (const input of inputs) {
    const next =
      typeof input === 'string'
        ? applyKey(current, input, key())
        : applyKey(current, '', key(input));
    if (next) current = next;
  }
  return current;
}

describe('editor', () => {
  it('inserts at the cursor and moves', () => {
    const state = type(createEditor('ac'), { leftArrow: true }, 'b');
    expect(state).toEqual({ value: 'abc', cursor: 2 });
  });

  it('deletes backwards and forwards', () => {
    let state = type(createEditor('hello'), { backspace: true });
    expect(state.value).toBe('hell');
    state = type({ value: 'hello', cursor: 0 }, { delete: true });
    expect(state).toEqual({ value: 'ello', cursor: 0 });
  });

  it('handles emacs shortcuts', () => {
    const base = createEditor('/var/www/html');
    expect(applyKey(base, 'w', key({ ctrl: true }))?.value).toBe('/var/www/');
    expect(applyKey(base, 'u', key({ ctrl: true }))?.value).toBe('');
    expect(applyKey({ value: 'abc', cursor: 1 }, 'k', key({ ctrl: true }))?.value).toBe('a');
    expect(applyKey(base, 'a', key({ ctrl: true }))?.cursor).toBe(0);
  });

  it('jumps words with meta arrows', () => {
    const state = applyKey(createEditor('one two three'), '', key({ leftArrow: true, meta: true }));
    expect(state?.cursor).toBe(8);
  });

  it('sanitizes pasted text', () => {
    expect(insertText(createEditor(), 'a\nb\u0007c').value).toBe('a bc');
  });

  it('ignores navigation keys it does not own', () => {
    expect(applyKey(createEditor('x'), '', key({ return: true }))).toBeUndefined();
    expect(applyKey(createEditor('x'), '', key({ upArrow: true }))).toBeUndefined();
  });

  it('works with multi-byte characters', () => {
    const state = type(createEditor('héllo👋'), { backspace: true }, { backspace: true });
    expect(state.value).toBe('héll');
  });
});

describe('list cursor', () => {
  it('wraps around and scrolls', () => {
    const start = clampCursor({ index: 0, offset: 0 }, 20, 5);
    const up = moveCursor(start, key({ upArrow: true }), '', 20, 5);
    expect(up).toEqual({ index: 19, offset: 15 });
    const down = moveCursor({ index: 4, offset: 0 }, key({ downArrow: true }), '', 20, 5);
    expect(down).toEqual({ index: 5, offset: 1 });
  });

  it('clamps when items shrink', () => {
    expect(clampCursor({ index: 10, offset: 8 }, 3, 5)).toEqual({ index: 2, offset: 0 });
  });
});
