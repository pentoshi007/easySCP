import { Box, type DOMElement, type Key, Text, useBoxMetrics, useInput, useWindowSize } from 'ink';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { conflictQuestion, summarizeResult } from '../app/transferText.js';
import { AppError, describeError } from '../core/errors.js';
import { displayPath } from '../fs/ops.js';
import type { Entry, FileSystem } from '../fs/types.js';
import type { Direction } from '../transfer/history.js';
import { planTransfer } from '../transfer/plan.js';
import {
  type ConflictPolicy,
  runTransfer,
  type TransferProgress,
  type TransferResult,
} from '../transfer/run.js';
import { Frame } from '../ui/components/Frame.js';
import { type Hint, KeyHints } from '../ui/components/KeyHints.js';
import { Spinner } from '../ui/components/Spinner.js';
import { TransferView } from '../ui/components/TransferView.js';
import { applyKey } from '../ui/editor.js';
import { moveCursor } from '../ui/list.js';
import { Browser } from '../ui/picker/Browser.js';
import { ConfirmPrompt } from '../ui/prompts/ConfirmPrompt.js';
import { SelectPrompt } from '../ui/prompts/SelectPrompt.js';
import { TextPrompt } from '../ui/prompts/TextPrompt.js';
import { colors, symbols, type Tone, toneColor, toneSymbol } from '../ui/theme.js';
import type { PromptControls } from '../ui/ui.js';
import { formatBytes, formatDate, formatMode } from '../util/format.js';
import { createFolder, deleteEntries, renameEntry } from './actions.js';
import { describeItems, invalidName, pickTargets } from './model.js';
import { PaneView } from './PaneView.js';
import { type Pane, usePane } from './usePane.js';

export interface ExplorerSide {
  fs: FileSystem;
  label: string;
  dir: string;
  onClose?: (listener: () => void) => () => void;
}

export interface CopyRecord {
  direction: Direction;
  sources: string[];
  destination: string;
  result: TransferResult;
}

export type Side = 0 | 1;

export interface ExplorerExit {
  reason: 'quit' | 'reconnect';
  active: Side;
  dirs: [string, string];
  files: number;
  bytes: number;
}

export interface ExplorerProps {
  title: string;
  subtitle?: string;
  sides: [ExplorerSide, ExplorerSide];
  initialActive?: Side;
  onInterrupt?: (handler: () => void) => () => void;
  onCopy?: (record: CopyRecord) => Promise<void>;
  onExit: (result: ExplorerExit) => void;
}

interface Modal {
  id: number;
  title: ReactNode;
  subtitle?: ReactNode;
  body: ReactNode;
}

type Job =
  | {
      kind: 'transfer';
      title: string;
      progress?: TransferProgress;
      scanned?: number;
      cancelling: boolean;
    }
  | { kind: 'task'; label: string };

interface Status {
  tone: Tone;
  message: string;
  detail?: string;
}

const TWO_PANES_MIN_WIDTH = 72;
const CHROME_ROWS = 3;

const HELP: Hint[] = [
  ['↑↓ pgup pgdn', 'move'],
  ['enter →', 'open folder'],
  ['← backspace', 'parent folder'],
  ['tab', 'switch side'],
  ['space', 'select or unselect'],
  ['a', 'select all or none'],
  ['c', 'copy selection to the other side'],
  ['n', 'new folder'],
  ['r', 'rename'],
  ['d delete', 'delete'],
  ['/', 'filter by name'],
  ['g', 'go to a folder'],
  ['~', 'home folder'],
  ['.', 'show or hide hidden files'],
  ['ctrl+r', 'refresh, or reconnect'],
  ['esc', 'clear filter or selection'],
  ['q', 'quit'],
];

function HelpView({ height, width }: { height: number; width: number }) {
  const perColumn = Math.max(1, height - 2);
  const keyWidth = Math.max(...HELP.map(([keys]) => keys.length)) + 2;
  const columns: Hint[][] = [];
  for (let index = 0; index < HELP.length; index += perColumn) {
    columns.push(HELP.slice(index, index + perColumn));
  }
  const columnWidth = Math.max(20, Math.floor((width - 2) / columns.length));
  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <Text bold>
        Keys <Text color={colors.muted}>press any key to go back</Text>
      </Text>
      <Text> </Text>
      <Box>
        {columns.map((column) => (
          <Box key={column[0]?.[0]} flexDirection="column" width={columnWidth} flexShrink={0}>
            {column.map(([keys, action]) => (
              <Box key={keys} height={1}>
                <Box width={keyWidth} flexShrink={0}>
                  <Text bold>{keys}</Text>
                </Box>
                <Text color={colors.muted} wrap="truncate-end">
                  {action}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function EntryDetails({ entry }: { entry: Entry }) {
  const parts = [
    entry.kind === 'file' && entry.size >= 0 ? formatBytes(entry.size) : '',
    entry.mode ? formatMode(entry.mode, entry.kind === 'dir') : '',
    entry.mtime > 0 ? formatDate(entry.mtime) : '',
  ].filter(Boolean);
  return (
    <Text color={colors.muted} wrap="truncate-middle">
      <Text color={entry.kind === 'dir' ? colors.dir : undefined}>{entry.name}</Text>
      {parts.length > 0 ? ` ${symbols.dot} ${parts.join(` ${symbols.dot} `)}` : ''}
    </Text>
  );
}

function isCancel(input: string, key: Key): boolean {
  return key.escape || (key.ctrl && input === 'c');
}

export function Explorer({
  title,
  subtitle,
  sides,
  initialActive = 0,
  onInterrupt,
  onCopy,
  onExit,
}: ExplorerProps) {
  const { columns, rows } = useWindowSize();
  const panesRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(panesRef);
  const [active, setActive] = useState<Side>(initialActive);
  const [showHidden, setShowHidden] = useState(true);
  const [filtering, setFiltering] = useState(false);
  const [modal, setModal] = useState<Modal>();
  const [job, setJob] = useState<Job>();
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<Status>();
  const [help, setHelp] = useState(false);
  const [lost, setLost] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const dismiss = useRef<(() => void) | undefined>(undefined);
  const modalIds = useRef(0);
  const totals = useRef({ files: 0, bytes: 0 });

  const height = Math.max(10, rows);
  const measured = metrics.hasMeasured ? metrics.height : height - CHROME_ROWS;
  const listHeight = Math.max(1, measured - 2);

  const left = usePane({ ...sides[0], start: sides[0].dir, showHidden, pageSize: listHeight });
  const right = usePane({ ...sides[1], start: sides[1].dir, showHidden, pageSize: listHeight });
  const panes: [Pane, Pane] = [left, right];
  const pane = panes[active];
  const other = panes[active === 0 ? 1 : 0];

  const finish = (reason: ExplorerExit['reason']) =>
    onExit({ reason, active, dirs: [left.dir, right.dir], ...totals.current });
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const cancelJob = () => {
    if (!controller.current) return;
    controller.current.abort();
    setJob((current) =>
      current?.kind === 'transfer' ? { ...current, cancelling: true } : current,
    );
  };
  const cancelRef = useRef(cancelJob);
  cancelRef.current = cancelJob;

  useEffect(() => {
    if (!onInterrupt) return;
    return onInterrupt(() => {
      if (controller.current) cancelRef.current();
      else if (dismiss.current) dismiss.current();
      else finishRef.current('quit');
    });
  }, [onInterrupt]);

  useEffect(() => {
    const stops = sides.map((side) => side.onClose?.(() => setLost(side.label)));
    return () => {
      for (const stop of stops) stop?.();
    };
  }, [sides]);

  function ask<T>(
    question: ReactNode,
    body: (controls: PromptControls<T>) => ReactNode,
    detail?: ReactNode,
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        dismiss.current = undefined;
        setModal(undefined);
        resolve(value);
      };
      dismiss.current = () => settle(undefined);
      const controls: PromptControls<T> = { submit: settle, cancel: () => settle(undefined) };
      setModal({ id: ++modalIds.current, title: question, subtitle: detail, body: body(controls) });
    });
  }

  async function askName(
    question: string,
    fs: FileSystem,
    initial: string,
    apply: (name: string) => Promise<void>,
  ): Promise<string | undefined> {
    let error: string | undefined;
    let value = initial;
    for (;;) {
      const answer = await ask<string>(question, (controls) => (
        <TextPrompt
          controls={controls}
          options={{ initial: value, error, validate: (input) => invalidName(fs, input) }}
        />
      ));
      if (answer === undefined) return undefined;
      const name = answer.trim();
      try {
        await apply(name);
        return name;
      } catch (failure) {
        if (!(failure instanceof AppError)) throw failure;
        error = failure.message;
        value = answer;
      }
    }
  }

  async function perform(action: () => Promise<void>) {
    setWorking(true);
    setStatus(undefined);
    try {
      await action();
    } catch (error) {
      if (controller.current?.signal.aborted) {
        setStatus({ tone: 'warning', message: 'Cancelled' });
      } else {
        const report = describeError(error);
        setStatus({ tone: 'danger', message: report.message, detail: report.hint });
      }
    } finally {
      controller.current = undefined;
      setJob(undefined);
      setWorking(false);
      const dropped = sides.find((side) => side.fs.closed);
      if (dropped) setLost(dropped.label);
    }
  }

  async function copy(from: Pane, to: Pane, direction: Direction) {
    const items = pickTargets(from.entries, from.selected, from.current);
    if (items.length === 0) {
      setStatus({ tone: 'warning', message: 'Nothing to copy here' });
      return;
    }
    const what = describeItems(items);
    const abort = new AbortController();
    controller.current = abort;
    const update = (patch: Partial<Extract<Job, { kind: 'transfer' }>>) =>
      setJob((current) => (current?.kind === 'transfer' ? { ...current, ...patch } : current));

    setJob({ kind: 'transfer', title: `Checking ${what}`, scanned: 0, cancelling: false });
    const plan = await planTransfer(
      {
        source: from.fs,
        target: to.fs,
        sources: items.map((entry) => entry.path),
        destination: to.dir,
        intoDirectory: true,
      },
      { signal: abort.signal, onScan: (scanned) => update({ scanned }) },
    );

    let policy: ConflictPolicy = 'skip';
    if (plan.conflicts.length > 0) {
      setJob(undefined);
      const question = conflictQuestion(plan, `in ${to.label}`);
      const picked = await ask<ConflictPolicy>(question.title, (controls) => (
        <SelectPrompt
          controls={controls}
          options={{ choices: question.choices, initial: question.initial, filter: false }}
        />
      ));
      if (picked === undefined) {
        setStatus({ tone: 'warning', message: 'Copy cancelled' });
        return;
      }
      policy = picked;
    }

    setJob({ kind: 'transfer', title: `Copying ${what} to ${to.label}`, cancelling: false });
    const result = await runTransfer(plan, {
      policy,
      signal: abort.signal,
      onProgress: (progress) => update({ progress }),
    });
    totals.current.files += result.files;
    totals.current.bytes += result.bytes;
    const where = `to ${to.label}:${displayPath(to.fs, to.dir)}`;
    const summary = summarizeResult(result, 'Copied', where);
    const detail =
      result.status === 'cancelled' && result.keptPartials > 0
        ? 'Copy again to resume where it stopped.'
        : summary.detail;
    setStatus({ tone: summary.tone, message: summary.message, detail });
    to.refresh(items.length === 1 ? items[0]?.name : undefined);
    if (result.status === 'done') from.clearSelection();
    if (onCopy && (result.files > 0 || result.status !== 'done')) {
      await onCopy({
        direction,
        sources: items.map((entry) => entry.path),
        destination: to.dir,
        result,
      }).catch(() => undefined);
    }
  }

  async function remove(target: Pane) {
    const items = pickTargets(target.entries, target.selected, target.current);
    if (items.length === 0) return;
    const what = describeItems(items);
    const confirmed = await ask<boolean>(
      `Delete ${what} from ${target.label}?`,
      (controls) => (
        <ConfirmPrompt
          controls={controls}
          options={{ initial: false, danger: true, yes: 'Delete', no: 'Keep' }}
        />
      ),
      'This can’t be undone.',
    );
    if (!confirmed) return;
    const abort = new AbortController();
    controller.current = abort;
    setJob({ kind: 'task', label: `Deleting ${what}` });
    try {
      await deleteEntries(target.fs, items, abort.signal, (done) =>
        setJob({ kind: 'task', label: `Deleting ${what} (${done}/${items.length})` }),
      );
    } finally {
      target.refresh();
      target.clearSelection();
    }
    setStatus({ tone: 'success', message: `Deleted ${what}` });
  }

  async function makeFolder(target: Pane) {
    const name = await askName(
      `New folder in ${target.label}:${displayPath(target.fs, target.dir)}`,
      target.fs,
      '',
      async (value) => {
        await createFolder(target.fs, target.dir, value);
      },
    );
    if (!name) return;
    target.refresh(name);
    setStatus({ tone: 'success', message: `Created ${name}/` });
  }

  async function rename(target: Pane) {
    const entry = target.current;
    if (!entry) return;
    const name = await askName(`Rename ${entry.name}`, target.fs, entry.name, async (value) => {
      await renameEntry(target.fs, entry, value);
    });
    if (!name || name === entry.name) return;
    target.refresh(name);
    setStatus({ tone: 'success', message: `Renamed ${entry.name} to ${name}` });
  }

  async function goTo(target: Pane) {
    const picked = await ask<string[]>(`Go to a folder on ${target.label}`, (controls) => (
      <Browser
        fs={target.fs}
        start={target.dir}
        mode="dir"
        action="go here"
        onSubmit={controls.submit}
        onCancel={controls.cancel}
      />
    ));
    const [dir] = picked ?? [];
    if (dir) target.open(dir);
  }

  function filterKey(input: string, key: Key) {
    if (key.return || key.tab) {
      setFiltering(false);
      return;
    }
    if (key.escape) {
      setFiltering(false);
      pane.setFilter('');
      return;
    }
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const next = moveCursor(pane.cursor, key, input, pane.rows.length, listHeight);
      if (next) pane.moveTo(next.index);
      return;
    }
    const edited = applyKey(
      { value: pane.filter, cursor: Array.from(pane.filter).length },
      input,
      key,
    );
    if (edited) pane.setFilter(edited.value);
  }

  useInput(
    (input, key) => {
      if (working) {
        if (isCancel(input, key)) cancelJob();
        return;
      }
      if (help) {
        setHelp(false);
        return;
      }
      if (filtering) {
        filterKey(input, key);
        return;
      }
      setStatus(undefined);
      const entry = pane.current;
      const next = moveCursor(pane.cursor, key, input, pane.rows.length, listHeight);
      if (next) {
        pane.moveTo(next.index);
      } else if (key.home) {
        pane.moveTo(0);
      } else if (key.end) {
        pane.moveTo(pane.rows.length - 1);
      } else if (key.tab) {
        setActive(active === 0 ? 1 : 0);
      } else if (key.return || key.rightArrow) {
        if (entry?.kind === 'dir') pane.open(entry.path);
      } else if (key.leftArrow || key.backspace) {
        pane.up();
      } else if (input === ' ') {
        if (entry) {
          pane.toggle(entry);
          pane.moveTo(Math.min(pane.cursor.index + 1, pane.rows.length - 1));
        }
      } else if (input === 'a' || (key.ctrl && input === 'a')) {
        pane.toggleAll();
      } else if (input === 'c') {
        void perform(() => copy(pane, other, active === 0 ? 'upload' : 'download'));
      } else if (input === 'n') {
        void perform(() => makeFolder(pane));
      } else if (input === 'r' && !key.ctrl) {
        void perform(() => rename(pane));
      } else if (input === 'd' || key.delete) {
        void perform(() => remove(pane));
      } else if (input === 'g') {
        void perform(() => goTo(pane));
      } else if (input === '/') {
        setFiltering(true);
      } else if (input === '.') {
        setShowHidden((value) => !value);
      } else if (input === '~') {
        pane.open(pane.fs.home);
      } else if (key.ctrl && input === 'r') {
        if (lost || sides.some((side) => side.fs.closed)) finish('reconnect');
        else for (const side of panes) side.refresh(side.current?.name);
      } else if (input === '?') {
        setHelp(true);
      } else if (input === 'q') {
        finish('quit');
      } else if (key.escape) {
        if (pane.filter) pane.setFilter('');
        else if (pane.selected.size > 0) pane.clearSelection();
        else finish('quit');
      }
    },
    { isActive: !modal },
  );

  const twoPanes = columns >= TWO_PANES_MIN_WIDTH;
  const leftWidth = twoPanes ? Math.floor(columns / 2) : columns;
  const widths = twoPanes ? [leftWidth, columns - leftWidth] : [columns, columns];
  const shown = twoPanes ? [0, 1] : [active];

  let panel: ReactNode = null;
  if (modal) {
    panel = (
      <Frame key={modal.id} title={modal.title} subtitle={modal.subtitle}>
        {modal.body}
      </Frame>
    );
  } else if (job?.kind === 'transfer') {
    panel = (
      <TransferView
        title={job.title}
        progress={job.progress}
        cancelling={job.cancelling}
        scanned={job.progress ? undefined : (job.scanned ?? 0)}
      />
    );
  }

  const target = other.label;
  const hints: (Hint | false)[] = filtering
    ? [
        ['type', 'filter'],
        ['enter', 'keep'],
        ['esc', 'clear'],
      ]
    : [
        ['tab', twoPanes ? 'switch side' : `show ${other.label}`],
        ['space', 'select'],
        ['c', `copy to ${target}`],
        ['d', 'delete'],
        ['r', 'rename'],
        ['n', 'new folder'],
        ['/', 'filter'],
        ['q', 'quit'],
      ];

  let footer: ReactNode;
  if (job?.kind === 'task') {
    footer = (
      <Text>
        <Spinner color={colors.accent} /> {job.label}
      </Text>
    );
  } else if (status) {
    footer = (
      <Text wrap="truncate-end">
        <Text color={toneColor[status.tone]}>
          {toneSymbol[status.tone]} {status.message}
        </Text>
        {status.detail ? <Text color={colors.muted}> {status.detail}</Text> : null}
      </Text>
    );
  } else if (lost) {
    footer = (
      <Text color={colors.warning} wrap="truncate-end">
        {symbols.warning} Connection to {lost} was lost <Text color={colors.muted}>·</Text>{' '}
        <Text bold>ctrl+r</Text> to reconnect
      </Text>
    );
  } else if (pane.current) {
    footer = <EntryDetails entry={pane.current} />;
  } else {
    footer = <Text> </Text>;
  }

  return (
    <Box flexDirection="column" width={columns} height={height}>
      <Box width={columns} flexShrink={0}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text bold color={colors.accent}>
              {' '}
              easyscp{' '}
            </Text>
            <Text bold>{title}</Text>
            {subtitle ? <Text color={colors.muted}> {subtitle}</Text> : null}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={colors.muted}>
            <Text bold>?</Text> help{' '}
          </Text>
        </Box>
      </Box>
      <Box ref={panesRef} flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
        {help ? (
          <HelpView height={measured} width={columns} />
        ) : (
          shown.map((index) => (
            <PaneView
              key={sides[index]?.label}
              pane={panes[index as Side]}
              active={index === active}
              width={widths[index] ?? columns}
              height={listHeight}
              filtering={filtering && index === active}
            />
          ))
        )}
      </Box>
      {panel ? <Box flexShrink={0}>{panel}</Box> : null}
      <Box flexShrink={0} paddingX={1}>
        {footer}
      </Box>
      <Box flexShrink={0} paddingX={1}>
        <KeyHints hints={hints} />
      </Box>
    </Box>
  );
}
