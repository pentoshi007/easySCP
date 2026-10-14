import {
  type CommandName,
  type ParsedArgs,
  parseCommandLine,
  suggestCommand,
} from '../cli/args.js';
import { renderHelp } from '../cli/help.js';
import { addCommand } from '../commands/add.js';
import { browseCommand } from '../commands/browse.js';
import { completionCommand, describeInstalled } from '../commands/completion.js';
import { copyCommand } from '../commands/copy.js';
import { editCommand } from '../commands/edit.js';
import { historyCommand } from '../commands/history.js';
import { homeCommand, hostMenu } from '../commands/home.js';
import { importCommand } from '../commands/import.js';
import { listCommand } from '../commands/list.js';
import type { Outcome } from '../commands/outcome.js';
import { removeCommand } from '../commands/remove.js';
import { testCommand } from '../commands/test.js';
import { transferCommand } from '../commands/transfer.js';
import { updateCommand } from '../commands/update.js';
import { detectShell, shellNamed } from '../completion/detect.js';
import { setUpCompletionAutomatically } from '../completion/install.js';
import { completionScript, isShell } from '../completion/scripts.js';
import { AppError, describeError, InterruptedError, wentBack } from '../core/errors.js';
import { findHost, listHosts } from '../core/hosts.js';
import { streamColors } from '../ui/theme.js';
import { Ui } from '../ui/ui.js';
import { removeRetiredExecutable } from '../update/binary.js';
import { availableUpdate, checkForUpdate, updateChecksAllowed } from '../update/check.js';
import { installMethod } from '../update/method.js';
import { type Context, createContext } from './context.js';

const TITLES: Record<CommandName, string> = {
  send: 'send files',
  receive: 'receive files',
  copy: 'copy between machines',
  browse: 'browse files',
  add: 'add a machine',
  edit: 'edit a machine',
  remove: 'remove machines',
  list: 'machines',
  test: 'test connection',
  import: 'import from ssh config',
  history: 'recent transfers',
  completion: 'shell completion',
  update: 'update',
};

const HANDLERS: Record<CommandName, (ctx: Context) => Promise<Outcome | undefined>> = {
  send: (ctx) => transferCommand(ctx, 'upload'),
  receive: (ctx) => transferCommand(ctx, 'download'),
  copy: copyCommand,
  browse: browseCommand,
  add: addCommand,
  edit: editCommand,
  remove: removeCommand,
  list: listCommand,
  test: testCommand,
  import: importCommand,
  history: historyCommand,
  completion: completionCommand,
  update: updateCommand,
};

function writeError(message: string, hint?: string): void {
  const color = streamColors(process.stderr);
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
    return HANDLERS[args.command.name](ctx);
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

  const color = streamColors(process.stdout);
  if (args.version) {
    process.stdout.write(`${__VERSION__}\n`);
    return 0;
  }
  if (args.help) {
    process.stdout.write(renderHelp(color, args.command));
    return 0;
  }
  if (args.command?.name === 'completion') {
    const [action, shell] = args.positionals;
    if (isShell(action) && shell === undefined) {
      process.stdout.write(completionScript(action));
      return 0;
    }
    const known = action === 'install' || action === 'uninstall';
    const chosen = action === undefined ? process.stdin.isTTY && process.stdout.isTTY : known;
    if (!chosen || (shell !== undefined && !shellNamed(shell))) {
      writeError(
        known ? 'Choose a shell: bash, zsh, fish or powershell' : 'Choose what to do',
        'Run `easyscp completion install` to set it up, or `easyscp completion zsh` to print the script.',
      );
      return 2;
    }
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
  const onSignal = () => ui.interrupt();
  const onHangup = () => process.exit(129);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onHangup);
  let code = 0;
  try {
    ui.intro(args.command ? TITLES[args.command.name] : args.word ? args.word : `v${__VERSION__}`);
    if (ui.interactive && args.command?.name !== 'completion') {
      const installed = await setUpCompletionAutomatically(detectShell).catch(() => undefined);
      if (installed) {
        const { message, detail } = describeInstalled(installed);
        ui.note(`${message}. ${detail}`);
      }
    }
    if (ui.interactive && updateChecksAllowed() && args.command?.name !== 'update') {
      const latest = await availableUpdate().catch(() => undefined);
      if (latest) ui.note(`easyscp ${latest} is available. Run \`easyscp update\` to get it.`);
      checkForUpdate().catch(() => undefined);
    }
    if (process.platform === 'win32') {
      const method = installMethod();
      if (method.kind === 'binary') await removeRetiredExecutable(method.executable);
    }
    const outcome = await dispatch(ctx, args);
    if (outcome) {
      if (ui.interactive) ui.outro(outcome.message, outcome.tone, outcome.detail);
      else if (outcome.tone === 'danger' || outcome.tone === 'warning')
        writeError(outcome.message, outcome.detail);
      else {
        const detail = outcome.detail ? ` (${outcome.detail})` : '';
        process.stdout.write(`${outcome.message}${detail}\n`);
      }
      code = outcome.code;
    }
  } catch (error) {
    code = reportFailure(ui, error);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onHangup);
    ctx.close();
    await ui.close();
  }
  return code;
}
