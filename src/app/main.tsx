import {
  type CommandName,
  type ParsedArgs,
  parseCommandLine,
  suggestCommand,
} from '../cli/args.js';
import { renderHelp } from '../cli/help.js';
import { addCommand } from '../commands/add.js';
import { browseCommand } from '../commands/browse.js';
import { completionScript, isShell } from '../commands/completion.js';
import { editCommand } from '../commands/edit.js';
import { historyCommand } from '../commands/history.js';
import { homeCommand, hostMenu } from '../commands/home.js';
import { importCommand } from '../commands/import.js';
import { listCommand } from '../commands/list.js';
import type { Outcome } from '../commands/outcome.js';
import { removeCommand } from '../commands/remove.js';
import { testCommand } from '../commands/test.js';
import { transferCommand } from '../commands/transfer.js';
import { AppError, describeError, InterruptedError, wentBack } from '../core/errors.js';
import { findHost, listHosts } from '../core/hosts.js';
import { Ui } from '../ui/ui.js';
import { type Context, createContext } from './context.js';

const TITLES: Record<CommandName, string> = {
  send: 'send files',
  receive: 'receive files',
  browse: 'browse files',
  add: 'add a machine',
  edit: 'edit a machine',
  remove: 'remove machines',
  list: 'machines',
  test: 'test connection',
  import: 'import from ssh config',
  history: 'recent transfers',
  completion: 'shell completion',
};

const HANDLERS: Record<
  Exclude<CommandName, 'completion'>,
  (ctx: Context) => Promise<Outcome | undefined>
> = {
  send: (ctx) => transferCommand(ctx, 'upload'),
  receive: (ctx) => transferCommand(ctx, 'download'),
  browse: browseCommand,
  add: addCommand,
  edit: editCommand,
  remove: removeCommand,
  list: listCommand,
  test: testCommand,
  import: importCommand,
  history: historyCommand,
};

function writeError(message: string, hint?: string): void {
  const color = process.stderr.isTTY && !process.env.NO_COLOR;
  const red = (text: string) => (color ? `\u001B[31m${text}\u001B[39m` : text);
  const dim = (text: string) => (color ? `\u001B[2m${text}\u001B[22m` : text);
  process.stderr.write(`${red('error')} ${message}\n`);
  if (hint)
    process.stderr.write(
      `${hint
        .split('\n')
        .map((line) => dim(`  ${line}`))
        .join('\n')}\n`,
    );
}

function reportFailure(ui: Ui, error: unknown): number {
  if (error instanceof InterruptedError) {
    if (ui.interactive) ui.outro('Interrupted', 'warning');
    return 130;
  }
  if (wentBack(error)) {
    if (ui.interactive) ui.outro('Cancelled', 'warning');
    return 1;
  }
  const report = describeError(error);
  if (process.env.EASYSCP_DEBUG && error instanceof Error && !(error instanceof AppError)) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }
  if (!ui.interactive) {
    writeError(report.message, report.hint);
    return 1;
  }
  ui.outro(report.message, 'danger', report.hint);
  return 1;
}

async function runHidden(word: string): Promise<number | undefined> {
  if (word !== '__hosts') return undefined;
  const hosts = await listHosts().catch(() => []);
  process.stdout.write(hosts.map((host) => `${host.name}\n`).join(''));
  return 0;
}

async function dispatch(ctx: Context, args: ParsedArgs): Promise<Outcome | undefined> {
  if (args.command) {
    return HANDLERS[args.command.name as Exclude<CommandName, 'completion'>](ctx);
  }
  if (args.word) {
    const host = await findHost(args.word);
    if (host) return hostMenu(ctx, host);
  }
  if (!ctx.ui.interactive) {
    process.stdout.write(renderHelp(false));
    return undefined;
  }
  return homeCommand(ctx);
}

export async function main(argv: string[]): Promise<number> {
  const hidden = argv[0] ? await runHidden(argv[0]) : undefined;
  if (hidden !== undefined) return hidden;

  let args: ParsedArgs;
  try {
    args = parseCommandLine(argv);
  } catch (error) {
    const report = describeError(error);
    writeError(report.message, report.hint);
    return 2;
  }

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (args.version) {
    process.stdout.write(`${__VERSION__}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(renderHelp(color, args.command));
    return 0;
  }
  if (args.command?.name === 'completion') {
    const [shell] = args.positionals;
    if (!isShell(shell)) {
      writeError(
        'Choose a shell: bash, zsh, fish or powershell',
        'Example: easyscp completion zsh >> ~/.zshrc',
      );
      return 2;
    }
    process.stdout.write(completionScript(shell));
    return 0;
  }
  if (args.word && !args.command) {
    const host = await findHost(args.word).catch(() => undefined);
    if (!host) {
      const suggestion = suggestCommand(args.word);
      writeError(
        `Unknown command or machine "${args.word}"`,
        suggestion
          ? `Did you mean \`easyscp ${suggestion}\`?`
          : 'Run `easyscp --help` for commands, or `easyscp list` for saved machines.',
      );
      return 2;
    }
  }

  const ui = new Ui();
  const ctx = createContext(ui, args);
  let code = 0;
  try {
    ui.intro(args.command ? TITLES[args.command.name] : args.word ? args.word : `v${__VERSION__}`);
    const outcome = await dispatch(ctx, args);
    if (outcome) {
      if (ui.interactive) ui.outro(outcome.message, outcome.tone, outcome.detail);
      else if (outcome.tone === 'danger' || outcome.tone === 'warning') writeError(outcome.message);
      else {
        const detail = outcome.detail ? ` (${outcome.detail})` : '';
        process.stdout.write(`${outcome.message}${detail}\n`);
      }
      code = outcome.code;
    }
  } catch (error) {
    code = reportFailure(ui, error);
  } finally {
    ctx.close();
    await ui.close();
  }
  return code;
}
