import type { Key } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';

export function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

export const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

export const ESC = '\u001B';
export const ENTER = '\r';
export const UP = '\u001B[A';
export const DOWN = '\u001B[B';
export const LEFT = '\u001B[D';
export const RIGHT = '\u001B[C';
export const BACKSPACE = '\u007F';
export const TAB = '\t';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

export function strip(frame: string | undefined): string {
  return (frame ?? '').replace(ANSI, '');
}

export async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected frame');
    await tick(20);
  }
}

export function renderScreen(tree: ReactElement, rows = 24) {
  const app = render(tree);
  Object.defineProperty(app.stdout, 'rows', { value: rows, configurable: true });
  app.stdout.emit('resize');
  return { ...app, frame: () => strip(app.lastFrame()) };
}
