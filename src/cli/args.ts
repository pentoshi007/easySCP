import { parseArgs } from 'node:util';
import { AppError } from '../core/errors.js';
import type { ConflictPolicy } from '../transfer/run.js';

export type CommandName =
  | 'send'
  | 'receive'
  | 'browse'
  | 'add'
  | 'edit'
  | 'remove'
  | 'list'
  | 'test'
  | 'import'
  | 'history'
  | 'completion';

export interface CommandInfo {
  name: CommandName;
  aliases: string[];
  args: string;
  summary: string;
  group: 'Transfer' | 'Machines' | 'Other';
  flags: OptionName[];
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  yes: { type: 'boolean', short: 'y' },
  to: { type: 'string', short: 't' },
  overwrite: { type: 'boolean' },
  skip: { type: 'boolean' },
  newer: { type: 'boolean' },
  rename: { type: 'boolean' },
  resume: { type: 'boolean' },
  json: { type: 'boolean' },
  clear: { type: 'boolean' },
} as const;

export type OptionName = keyof typeof OPTIONS;

const POLICY_FLAGS: OptionName[] = ['overwrite', 'skip', 'newer', 'rename', 'resume'];
const GLOBAL_FLAGS: OptionName[] = ['help', 'version', 'yes'];

export const COMMANDS: CommandInfo[] = [
  {
    name: 'send',
    aliases: ['up', 'push', 'upload'],
    args: '[host] [files...]',
    summary: 'Upload files or folders to a machine',
    group: 'Transfer',
    flags: ['to', ...POLICY_FLAGS],
  },
  {
    name: 'receive',
    aliases: ['get', 'down', 'pull', 'download'],
    args: '[host] [paths...]',
    summary: 'Download files or folders from a machine',
    group: 'Transfer',
    flags: ['to', ...POLICY_FLAGS],
  },
  {
    name: 'browse',
    aliases: ['open', 'files'],
    args: '[host]',
    summary: 'Side-by-side file browser for this computer and a machine',
    group: 'Transfer',
    flags: [],
  },
  {
    name: 'add',
    aliases: ['new'],
    args: '[user@host[:port]]',
    summary: 'Save a machine and how to log in',
    group: 'Machines',
    flags: [],
  },
  {
    name: 'edit',
    aliases: [],
    args: '[name]',
    summary: 'Change a saved machine',
    group: 'Machines',
    flags: [],
  },
  {
    name: 'remove',
    aliases: ['rm', 'delete'],
    args: '[name...]',
    summary: 'Forget saved machines',
    group: 'Machines',
    flags: [],
  },
  {
    name: 'list',
    aliases: ['ls', 'hosts'],
    args: '',
    summary: 'Show saved machines',
    group: 'Machines',
    flags: ['json'],
  },
  {
    name: 'test',
    aliases: ['ping', 'check'],
    args: '[name]',
    summary: 'Check that a machine is reachable and you can log in',
    group: 'Machines',
    flags: [],
  },
  {
    name: 'import',
    aliases: [],
    args: '',
    summary: 'Import machines from ~/.ssh/config',
    group: 'Machines',
    flags: [],
  },
  {
    name: 'history',
    aliases: ['log'],
    args: '',
    summary: 'Recent transfers; pick one to run it again',
    group: 'Other',
    flags: ['json', 'clear'],
  },
  {
    name: 'completion',
    aliases: [],
    args: '<bash|zsh|fish|powershell>',
    summary: 'Print a shell completion script',
    group: 'Other',
    flags: [],
  },
];

export interface ParsedArgs {
  command: CommandInfo | undefined;
  word: string | undefined;
  positionals: string[];
  help: boolean;
  version: boolean;
  yes: boolean;
  to: string | undefined;
  policy: ConflictPolicy | undefined;
  json: boolean;
  clear: boolean;
}

export function findCommand(word: string): CommandInfo | undefined {
  const lower = word.toLowerCase();
  return COMMANDS.find((command) => command.name === lower || command.aliases.includes(lower));
}

export function suggestCommand(word: string): string | undefined {
  const lower = word.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const command of COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      const distance = editDistance(lower, name);
      if (!best || distance < best.distance) best = { name: command.name, distance };
    }
  }
  return best && best.distance <= 2 ? best.name : undefined;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number;
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] as number;
}

function usageError(message: string, hint = 'Run `easyscp --help` to see what is available.') {
  return new AppError(message, hint);
}

export function parseCommandLine(argv: string[]): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    const message = (error as Error).message.replace(/\. To specify a positional.*$/s, '');
    throw usageError(message.replace(/^Unknown option '(.+)'$/, 'Unknown option $1'));
  }
  const { values, positionals } = parsed;
  const [word, ...rest] = positionals;
  const command = word ? findCommand(word) : undefined;

  const allowed = new Set<OptionName>([...GLOBAL_FLAGS, ...(command?.flags ?? [])]);
  for (const name of Object.keys(values) as OptionName[]) {
    if (values[name] !== undefined && !allowed.has(name)) {
      throw usageError(
        `--${name} can't be used ${command ? `with ${command.name}` : 'here'}`,
        command ? `Run \`easyscp ${command.name} --help\` for its options.` : undefined,
      );
    }
  }

  const policies = POLICY_FLAGS.filter((name) => values[name] === true);
  if (policies.length > 1) {
    throw usageError(`Choose only one of ${policies.map((name) => `--${name}`).join(', ')}`);
  }

  return {
    command,
    word,
    positionals: command ? rest : positionals,
    help: values.help === true,
    version: values.version === true,
    yes: values.yes === true,
    to: values.to,
    policy: policies[0] as ConflictPolicy | undefined,
    json: values.json === true,
    clear: values.clear === true,
  };
}
