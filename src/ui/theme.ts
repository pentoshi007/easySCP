function detectUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.EASYSCP_ASCII === '1') return false;
  if (process.platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(
    env.WT_SESSION ||
      env.TERMINUS_SUBLIME ||
      env.ConEmuTask === '{cmd::Cmder}' ||
      env.TERM_PROGRAM === 'vscode' ||
      env.TERM_PROGRAM === 'Terminus-Sublime' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'alacritty' ||
      env.TERM === 'rxvt-unicode',
  );
}

export const unicode = detectUnicode();

const fancy = {
  start: '┌',
  mask: '•',
  active: '◆',
  done: '◇',
  bar: '│',
  end: '└',
  pointer: '›',
  checked: '◼',
  unchecked: '◻',
  radioOn: '●',
  radioOff: '○',
  success: '✔',
  error: '✖',
  warning: '▲',
  info: '●',
  arrowUp: '↑',
  arrowDown: '↓',
  arrowRight: '→',
  ellipsis: '…',
  dot: '·',
  barFull: '━',
  barEmpty: '━',
  barHead: '╸',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const plain: typeof fancy = {
  start: '+',
  mask: '*',
  active: '*',
  done: 'o',
  bar: '|',
  end: '`',
  pointer: '>',
  checked: '[x]',
  unchecked: '[ ]',
  radioOn: '(*)',
  radioOff: '( )',
  success: 'v',
  error: 'x',
  warning: '!',
  info: 'i',
  arrowUp: '^',
  arrowDown: 'v',
  arrowRight: '->',
  ellipsis: '...',
  dot: '-',
  barFull: '#',
  barEmpty: '-',
  barHead: '#',
  spinner: ['-', '\\', '|', '/'],
};

export const symbols = unicode ? fancy : plain;

export function colorsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NO_COLOR) && env.FORCE_COLOR === undefined;
}

export function streamColors(stream: NodeJS.WriteStream): boolean {
  return !colorsDisabled() && (Boolean(stream.isTTY) || Boolean(process.env.FORCE_COLOR));
}

const palette = {
  accent: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  muted: 'gray',
  dir: 'blue',
  link: 'magenta',
  match: 'yellow',
};

export const colors: Record<keyof typeof palette, string> = colorsDisabled()
  ? (Object.fromEntries(Object.keys(palette).map((name) => [name, ''])) as typeof palette)
  : palette;

export type Tone = 'success' | 'warning' | 'danger' | 'info';

export const toneColor: Record<Tone, string> = {
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
  info: colors.accent,
};

export const toneSymbol: Record<Tone, string> = {
  success: symbols.success,
  warning: symbols.warning,
  danger: symbols.error,
  info: symbols.info,
};
