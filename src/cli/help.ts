import { COMMANDS, type CommandInfo } from './args.js';

interface Style {
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
}

function makeStyle(color: boolean): Style {
  const wrap = (open: number, close: number) => (text: string) =>
    color ? `\u001B[${open}m${text}\u001B[${close}m` : text;
  return { bold: wrap(1, 22), dim: wrap(2, 22), accent: wrap(36, 39) };
}

const POLICY_HELP: [string, string][] = [
  ['--overwrite', 'Replace files that already exist'],
  ['--skip', 'Keep existing files untouched'],
  ['--newer', 'Replace only when the source is newer'],
  ['--rename', 'Keep both, adding a number to the new copy'],
  ['--resume', 'Continue files that were cut short'],
];

const FLAG_HELP: Record<string, [string, string][]> = {
  send: [['-t, --to <dir>', 'Remote folder to upload into'], ...POLICY_HELP],
  receive: [['-t, --to <dir>', 'Local folder to download into'], ...POLICY_HELP],
  copy: [['-t, --to <dir>', 'Folder for machines listed without one'], ...POLICY_HELP],
  list: [['--json', 'Print machines as JSON']],
  history: [
    ['--json', 'Print history as JSON'],
    ['--clear', 'Forget all recorded transfers'],
  ],
};

const EXAMPLES: Record<string, string[]> = {
  send: [
    'easyscp send                        pick a machine, files and folder',
    'easyscp send prod                   pick files and folder for prod',
    'easyscp send prod ./dist -t /var/www',
  ],
  receive: [
    'easyscp get prod                    browse prod and pick what to download',
    "easyscp get prod '/var/log/*.log' -t ./logs",
  ],
  copy: [
    'easyscp copy                        pick the machines and files',
    'easyscp copy web1:/srv/app.tar web2 web3 -t /srv',
    'easyscp copy web1 logs/ web2:/backup web3:/backup',
  ],
  browse: ['easyscp browse prod                 copy, rename and delete on both sides'],
  add: ['easyscp add', 'easyscp add deploy@203.0.113.7:2222'],
};

function table(rows: [string, string][], style: Style, minWidth = 0): string[] {
  const width = Math.max(minWidth, ...rows.map(([left]) => left.length + 3));
  const indent = 2;
  return rows.map(
    ([left, right]) => `${' '.repeat(indent)}${style.bold(left.padEnd(width))}${right}`,
  );
}

export function renderHelp(color: boolean, command?: CommandInfo): string {
  const style = makeStyle(color);
  const lines: string[] = [];

  if (command) {
    lines.push(`${style.accent('easyscp')} ${style.bold(command.name)} ${command.args}`.trimEnd());
    lines.push('', `  ${command.summary}`);
    if (command.aliases.length > 0) {
      lines.push('', `  ${style.dim(`Aliases: ${command.aliases.join(', ')}`)}`);
    }
    const flags = FLAG_HELP[command.name] ?? [];
    const options: [string, string][] = [...flags, ['-y, --yes', 'Accept defaults without asking']];
    lines.push('', style.bold('Options'), ...table(options, style));
    const examples = EXAMPLES[command.name];
    if (examples) lines.push('', style.bold('Examples'), ...examples.map((line) => `  ${line}`));
    lines.push('', style.dim('Leave out anything and easyscp will ask for it.'));
    return `${lines.join('\n')}\n`;
  }

  lines.push(`${style.accent('easyscp')} ${style.dim('—')} friendly file transfers over SSH`);
  lines.push('', style.bold('Usage'));
  lines.push('  easyscp                 open the interactive menu');
  lines.push('  easyscp <command> [...] run a command directly');
  lines.push('  easyscp <machine>       actions for a saved machine');

  const label = (entry: CommandInfo) => [entry.name, ...entry.aliases.slice(0, 1)].join(', ');
  const width = Math.max(16, ...COMMANDS.map((entry) => label(entry).length + 3));
  for (const group of ['Transfer', 'Machines', 'Other'] as const) {
    const rows = COMMANDS.filter((entry) => entry.group === group).map(
      (entry): [string, string] => [label(entry), entry.summary],
    );
    lines.push('', style.bold(group), ...table(rows, style, width));
  }
  lines.push('', style.bold('Options'));
  lines.push(
    ...table(
      [
        ['-h, --help', 'Show help (also: easyscp <command> --help)'],
        ['-v, --version', 'Show the installed version'],
        ['-y, --yes', 'Accept defaults and trust new machines without asking'],
      ],
      style,
      width,
    ),
  );
  lines.push('', style.dim('Anything you leave out, easyscp will ask for interactively.'));
  return `${lines.join('\n')}\n`;
}
