import type { Tone } from '../ui/theme.js';

export interface Outcome {
  message: string;
  tone: Tone;
  code: number;
  detail?: string;
}

export const done = (message: string, detail?: string): Outcome => ({
  message,
  tone: 'success',
  code: 0,
  ...(detail ? { detail } : {}),
});
export const warn = (message: string, code = 1): Outcome => ({ message, tone: 'warning', code });
export const fail = (message: string, detail?: string): Outcome => ({
  message,
  tone: 'danger',
  code: 1,
  ...(detail ? { detail } : {}),
});
