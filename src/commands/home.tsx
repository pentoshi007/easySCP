import { Text } from 'ink';
import type { Context } from '../app/context.js';
import { hostChoice } from '../app/hostPicker.js';
import { describeError, InterruptedError, wentBack } from '../core/errors.js';
import { type Host, listHosts } from '../core/hosts.js';
import { listHistory } from '../transfer/history.js';
import type { Choice } from '../ui/prompts/SelectPrompt.js';
import { colors, toneColor } from '../ui/theme.js';
import { plural } from '../util/format.js';
import { addHost } from './add.js';
import { browseCommand, browseHost } from './browse.js';
import { copyFlow } from './copy.js';
import { editHostFields } from './edit.js';
import { describeEntry, historyCommand, repeatTransfer } from './history.js';
import { importCandidates, importCommand } from './import.js';
import { done, type Outcome } from './outcome.js';
import { removeHosts } from './remove.js';
import { probe } from './test.js';
import { transferFlow } from './transfer.js';

type Action = () => Promise<Outcome | 'quit' | undefined>;

async function guarded(ctx: Context, action: Action): Promise<'quit' | undefined> {
  try {
    const result = await action();
    if (result === 'quit') return 'quit';
    if (result) {
      ctx.ui.step(
        <Text color={toneColor[result.tone]}>{result.message}</Text>,
        result.detail ? <Text color={colors.muted}>{result.detail}</Text> : undefined,
        result.tone,
      );
    }
  } catch (error) {
    if (wentBack(error)) return undefined;
    if (error instanceof InterruptedError) throw error;
    const report = describeError(error);
    ctx.ui.step(
      <Text color={colors.danger}>{report.message}</Text>,
      report.hint ? <Text color={colors.muted}>{report.hint}</Text> : undefined,
      'danger',
    );
  }
  return undefined;
}

export async function hostMenu(ctx: Context, initial: Host): Promise<Outcome | undefined> {
  let host = initial;
  for (;;) {
    const current = (await listHosts()).find((entry) => entry.id === host.id);
    if (!current) return done(`Removed ${host.name}`);
    host = current;
    const others = (await listHosts()).length - 1;
    let removed = false;
    const choice = await ctx.ui.select(`${host.name}`, {
      filter: false,
      choices: [
        { value: 'send', label: `Send files to ${host.name}` },
        { value: 'receive', label: `Receive files from ${host.name}` },
        ...(others > 0
          ? [{ value: 'copy', label: `Copy files from ${host.name} to other machines` }]
          : []),
        { value: 'browse', label: 'Browse files', hint: 'side by side with this computer' },
        { value: 'test', label: 'Test connection' },
        { value: 'edit', label: 'Edit details' },
        { value: 'remove', label: 'Remove', color: colors.danger },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return undefined;
    const quit = await guarded(ctx, async () => {
      switch (choice) {
        case 'send':
          return transferFlow(ctx, { direction: 'upload', host });
        case 'receive':
          return transferFlow(ctx, { direction: 'download', host });
        case 'copy':
          return copyFlow(ctx, { source: host });
        case 'browse':
          return browseHost(ctx, host);
        case 'test':
          await probe(ctx, host);
          return undefined;
        case 'edit':
          host = await editHostFields(ctx, host);
          return undefined;
        default:
          removed = await removeHosts(ctx, [host]);
          return removed ? done(`Removed ${host.name}`) : undefined;
      }
    });
    if (quit || removed) return undefined;
  }
}

async function machinesMenu(ctx: Context): Promise<void> {
  for (;;) {
    const hosts = await listHosts();
    const imports = await importCandidates().catch(() => []);
    const choices: Choice<Host | string>[] = [
      ...hosts.map(hostChoice),
      { value: 'add', label: '+ Add a machine', color: colors.success },
    ];
    if (imports.length > 0) {
      choices.push({
        value: 'import',
        label: `Import from ~/.ssh/config`,
        hint: plural(imports.length, 'new machine'),
      });
    }
    choices.push({ value: 'back', label: 'Back' });
    const picked = await ctx.ui.select<Host | string>('Machines', { choices, initial: hosts[0] });
    if (picked === 'back') return;
    await guarded(ctx, async () => {
      if (picked === 'add') {
        const host = await addHost(ctx);
        return done(`Saved ${host.name}`);
      }
      if (picked === 'import') return importCommand(ctx);
      return hostMenu(ctx, picked as Host);
    });
  }
}

async function onboard(ctx: Context): Promise<void> {
  const imports = await importCandidates().catch(() => []);
  ctx.ui.note('Welcome! Save a machine once, then send and receive files by name.');
  if (imports.length > 0) {
    const choice = await ctx.ui.select('How do you want to start?', {
      filter: false,
      choices: [
        {
          value: 'import',
          label: 'Import from ~/.ssh/config',
          hint: plural(imports.length, 'machine'),
        },
        { value: 'add', label: 'Add a machine by hand' },
      ],
    });
    if (choice === 'import') {
      const outcome = await importCommand(ctx);
      ctx.ui.step(<Text color={colors.success}>{outcome.message}</Text>);
      return;
    }
  }
  const host = await addHost(ctx);
  ctx.ui.step(<Text color={colors.success}>Saved {host.name}</Text>);
}

export async function homeCommand(ctx: Context): Promise<Outcome | undefined> {
  const { ui } = ctx;
  if ((await listHosts()).length === 0) {
    await guarded(ctx, async () => {
      await onboard(ctx);
      return undefined;
    });
  }

  let last = 'send';
  for (;;) {
    const [hosts, history] = await Promise.all([listHosts(), listHistory()]);
    const [recent] = history;
    const choices: Choice<string>[] = [];
    if (recent && hosts.some((host) => host.id === recent.hostId)) {
      const { label } = describeEntry(recent);
      choices.push({ value: 'repeat', label: 'Repeat last transfer', hint: label });
    }
    choices.push(
      { value: 'send', label: 'Send files', hint: 'upload to one or more machines' },
      { value: 'receive', label: 'Receive files', hint: 'download from a machine' },
    );
    if (hosts.length > 1) {
      choices.push({
        value: 'copy',
        label: 'Copy between machines',
        hint: 'from one machine to others, through here',
      });
    }
    choices.push({
      value: 'browse',
      label: 'Browse files',
      hint: 'copy, rename and delete side by side',
    });
    if (history.length > 0) {
      choices.push({
        value: 'history',
        label: 'Recent transfers',
        hint: plural(history.length, 'transfer'),
      });
    }
    choices.push(
      {
        value: 'machines',
        label: 'Machines',
        hint: hosts.length ? `${hosts.length} saved` : 'add one',
      },
      { value: 'quit', label: 'Quit' },
    );

    const choice = await ui
      .select('What would you like to do?', { choices, initial: last, filter: false })
      .catch((error: unknown) => {
        if (wentBack(error)) return 'quit';
        throw error;
      });
    if (choice === 'quit') return done('See you next time');
    last = choice;

    const quit = await guarded(ctx, async () => {
      switch (choice) {
        case 'repeat':
          return repeatTransfer(ctx, recent as NonNullable<typeof recent>);
        case 'send':
          return transferFlow(ctx, { direction: 'upload' });
        case 'receive':
          return transferFlow(ctx, { direction: 'download' });
        case 'copy':
          return copyFlow(ctx, {});
        case 'browse':
          return browseCommand(ctx);
        case 'history':
          return historyCommand(ctx);
        default:
          await machinesMenu(ctx);
          return undefined;
      }
    });
    if (quit) return done('See you next time');
  }
}
