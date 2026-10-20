import type { Key } from 'ink';

export function isPlain(key: Key): boolean {
  return !key.ctrl && !key.meta && !key.super && !key.hyper;
}
