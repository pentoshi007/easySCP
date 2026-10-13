import { Box, type Instance, render, renderToString, Static, Text, useInput } from 'ink';
import { type ReactNode, useSyncExternalStore } from 'react';
import { AppError, CancelledError, InterruptedError } from '../core/errors.js';
import { Frame, Line } from './components/Frame.js';
import { Spinner } from './components/Spinner.js';
import { type ConfirmOptions, ConfirmPrompt } from './prompts/ConfirmPrompt.js';
import {
  type MultiSelectOptions,
  MultiSelectPrompt,
  type SelectOptions,
  SelectPrompt,
} from './prompts/SelectPrompt.js';
import { type TextOptions, TextPrompt } from './prompts/TextPrompt.js';
import { Store } from './store.js';
import { colors, symbols, type Tone, toneColor, toneSymbol } from './theme.js';

export interface PromptControls<T> {
  submit(value: T): void;
  cancel(): void;
}

export interface PromptSpec<T> {
  title: ReactNode;
  subtitle?: ReactNode;
  body: (controls: PromptControls<T>) => ReactNode;
  summary?: (value: T) => ReactNode;
}

export interface TaskHandle {
  update(node: ReactNode): void;
  close(): void;
}

interface Entry {
  id: number;
  node: ReactNode;
}

interface HostState {
  log: Entry[];
  tasks: Entry[];
  prompts: Entry[];
}

export interface UiStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

const FORCE_EXIT_WINDOW = 2000;

function HostView({ store, onInterrupt }: { store: Store<HostState>; onInterrupt: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onInterrupt();
  });
  const prompt = state.prompts[0];
  return (
    <>
      <Static items={state.log}>{(entry) => <Box key={entry.id}>{entry.node}</Box>}</Static>
      {state.tasks.map((task) => (
        <Box key={task.id}>{task.node}</Box>
      ))}
      {prompt ? <Box key={prompt.id}>{prompt.node}</Box> : null}
    </>
  );
}

function FullscreenView({
  children,
  onInterrupt,
}: {
  children: ReactNode;
  onInterrupt: () => void;
}) {
  useInput((input, key) => {
    if (key.ctrl && input === 'c') onInterrupt();
  });
  return <>{children}</>;
}

export class Ui {
  readonly interactive: boolean;
  private readonly store = new Store<HostState>({ log: [], tasks: [], prompts: [] });
  private readonly controller = new AbortController();
  private readonly interrupts: (() => void)[] = [];
  private readonly rejecters = new Map<number, (error: Error) => void>();
  private instance: Instance | undefined;
  private screen: Instance | undefined;
  private ids = 0;
  private lastInterrupt = 0;

  constructor(
    private readonly streams: UiStreams = { stdin: process.stdin, stdout: process.stdout },
  ) {
    this.interactive =
      Boolean(streams.stdin.isTTY && streams.stdout.isTTY) && process.env.TERM !== 'dumb';
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get columns(): number {
    return this.streams.stdout.columns || (this.streams.stdout.isTTY ? 80 : 200);
  }

  print(node: ReactNode, toStderr = false): void {
    if (!this.interactive) {
      const stream = toStderr ? (this.streams.stderr ?? process.stderr) : this.streams.stdout;
      stream.write(`${renderToString(<Box>{node}</Box>, { columns: this.columns })}\n`);
      return;
    }
    this.mount();
    this.store.set((state) => ({ ...state, log: [...state.log, { id: ++this.ids, node }] }));
  }

  intro(title: ReactNode): void {
    if (!this.interactive) return;
    this.print(
      <Box flexDirection="column">
        <Text>
          <Text color={colors.muted}>{symbols.start}</Text>
          {'  '}
          <Text inverse color={colors.accent}>
            {' easyscp '}
          </Text>{' '}
          <Text bold>{title}</Text>
        </Text>
        <Line />
      </Box>,
    );
  }

  outro(message: ReactNode, tone: Tone = 'success', hint?: string): void {
    this.print(
      <Box flexDirection="column">
        <Text>
          <Text color={colors.muted}>{symbols.end}</Text>
          {'  '}
          <Text color={toneColor[tone]}>{message}</Text>
        </Text>
        {hint
          ? hint.split('\n').map((line) => (
              <Text key={line} color={colors.muted}>
                {'   '}
                {line}
              </Text>
            ))
          : null}
      </Box>,
    );
  }

  step(title: ReactNode, detail?: ReactNode, tone?: Tone): void {
    if (!this.interactive) {
      this.print(
        <Box flexDirection="column">
          <Text>
            {tone ? <Text color={toneColor[tone]}>{toneSymbol[tone]} </Text> : null}
            {title}
          </Text>
          {detail ? (
            <Box flexDirection="column" paddingLeft={2}>
              {typeof detail === 'string' ? <Text color={colors.muted}>{detail}</Text> : detail}
            </Box>
          ) : null}
        </Box>,
        tone === 'danger' || tone === 'warning',
      );
      return;
    }
    this.print(
      <Frame
        title={title}
        state="done"
        marker={tone ? <Text color={toneColor[tone]}>{toneSymbol[tone]}</Text> : undefined}
        closed={false}
      >
        {detail ? (
          <Box flexDirection="column">
            {typeof detail === 'string' ? <Text color={colors.muted}>{detail}</Text> : detail}
            <Text> </Text>
          </Box>
        ) : undefined}
      </Frame>,
    );
  }

  note(message: ReactNode, tone: Tone = 'info'): void {
    if (!this.interactive) {
      this.print(<Text color={tone === 'info' ? undefined : toneColor[tone]}>{message}</Text>);
      return;
    }
    this.print(
      <Line>
        <Text color={toneColor[tone]}>
          {toneSymbol[tone]}{' '}
          <Text color={tone === 'info' ? undefined : toneColor[tone]}>{message}</Text>
        </Text>
      </Line>,
    );
  }

  prompt<T>(spec: PromptSpec<T>): Promise<T> {
    if (!this.interactive) {
      return Promise.reject(
        new AppError(
          'This step needs an interactive terminal',
          'Pass the missing details as arguments. See `easyscp --help`.',
        ),
      );
    }
    if (this.signal.aborted) return Promise.reject(new InterruptedError());
    this.mount();
    return new Promise<T>((resolve, reject) => {
      const id = ++this.ids;
      let settled = false;
      const settle = (log?: ReactNode) => {
        settled = true;
        this.rejecters.delete(id);
        this.store.set((state) => ({
          ...state,
          prompts: state.prompts.filter((entry) => entry.id !== id),
          log: log === undefined ? state.log : [...state.log, { id: ++this.ids, node: log }],
        }));
      };
      const controls: PromptControls<T> = {
        submit: (value) => {
          if (settled) return;
          const summary = spec.summary ? spec.summary(value) : undefined;
          settle(
            <Frame title={spec.title} state="done" closed={false}>
              <Box flexDirection="column">
                {summary !== undefined && summary !== null ? (
                  <Text color={colors.muted}>{summary}</Text>
                ) : null}
                <Text> </Text>
              </Box>
            </Frame>,
          );
          resolve(value);
        },
        cancel: () => {
          if (settled) return;
          settle();
          reject(new CancelledError());
        },
      };
      this.rejecters.set(id, (error) => {
        if (settled) return;
        settle();
        reject(error);
      });
      const node = (
        <Frame title={spec.title} subtitle={spec.subtitle}>
          {spec.body(controls)}
        </Frame>
      );
      this.store.set((state) => ({ ...state, prompts: [...state.prompts, { id, node }] }));
    });
  }

  text(title: ReactNode, options: TextOptions = {}): Promise<string> {
    return this.prompt({
      title,
      body: (controls) => <TextPrompt controls={controls} options={options} />,
      summary: (value) => (options.mask === undefined ? value || '—' : '••••••'),
    });
  }

  async password(title: ReactNode, options: Omit<TextOptions, 'mask'> = {}): Promise<string> {
    return this.text(title, { ...options, mask: symbols.mask, allowEmpty: true });
  }

  select<T>(title: ReactNode, options: SelectOptions<T>): Promise<T> {
    return this.prompt<T>({
      title,
      body: (controls) => <SelectPrompt controls={controls} options={options} />,
      summary: (value) => options.choices.find((choice) => choice.value === value)?.label,
    });
  }

  multiselect<T>(title: ReactNode, options: MultiSelectOptions<T>): Promise<T[]> {
    return this.prompt<T[]>({
      title,
      body: (controls) => <MultiSelectPrompt controls={controls} options={options} />,
      summary: (values) =>
        options.choices
          .filter((choice) => values.includes(choice.value))
          .map((choice) => choice.label)
          .join(', ') || 'none',
    });
  }

  confirm(title: ReactNode, options: ConfirmOptions = {}): Promise<boolean> {
    return this.prompt({
      title,
      body: (controls) => <ConfirmPrompt controls={controls} options={options} />,
      summary: (value) => (value ? (options.yes ?? 'Yes') : (options.no ?? 'No')),
    });
  }

  task(node: ReactNode): TaskHandle {
    if (!this.interactive) return { update: () => {}, close: () => {} };
    this.mount();
    const id = ++this.ids;
    this.store.set((state) => ({ ...state, tasks: [...state.tasks, { id, node }] }));
    return {
      update: (next) =>
        this.store.set((state) => ({
          ...state,
          tasks: state.tasks.map((entry) => (entry.id === id ? { id, node: next } : entry)),
        })),
      close: () =>
        this.store.set((state) => ({
          ...state,
          tasks: state.tasks.filter((entry) => entry.id !== id),
        })),
    };
  }

  async spin<T>(
    label: string,
    work: (setLabel: (label: string) => void) => Promise<T>,
  ): Promise<T> {
    const view = (text: string) => (
      <Text>
        <Spinner />
        {'  '}
        {text}
        <Text color={colors.muted}>{symbols.ellipsis}</Text>
      </Text>
    );
    const handle = this.task(view(label));
    try {
      return await work((next) => handle.update(view(next)));
    } finally {
      handle.close();
    }
  }

  onInterrupt(handler: () => void): () => void {
    this.interrupts.push(handler);
    return () => {
      const index = this.interrupts.lastIndexOf(handler);
      if (index >= 0) this.interrupts.splice(index, 1);
    };
  }

  async fullscreen<T>(view: (exit: (value: T) => void) => ReactNode): Promise<T> {
    if (!this.interactive) throw new AppError('The browser needs an interactive terminal');
    await this.unmount();
    return new Promise<T>((resolve) => {
      let done = false;
      const instance: Instance = render(
        <FullscreenView onInterrupt={() => this.interrupt()}>
          {view((value) => {
            if (done) return;
            done = true;
            this.screen = undefined;
            instance.unmount();
            instance.waitUntilExit().then(
              () => resolve(value),
              () => resolve(value),
            );
          })}
        </FullscreenView>,
        {
          stdin: this.streams.stdin,
          stdout: this.streams.stdout,
          exitOnCtrlC: false,
          patchConsole: false,
          interactive: true,
          alternateScreen: true,
          incrementalRendering: true,
          maxFps: 30,
        },
      );
      this.screen = instance;
    });
  }

  async close(): Promise<void> {
    await this.unmount();
  }

  interrupt(): void {
    const now = Date.now();
    const repeated = now - this.lastInterrupt < FORCE_EXIT_WINDOW;
    this.lastInterrupt = now;
    if (repeated) {
      this.screen?.unmount();
      this.instance?.unmount();
      process.exit(130);
    }
    const handler = this.interrupts.at(-1);
    if (handler) {
      handler();
      return;
    }
    this.controller.abort(new InterruptedError());
    for (const reject of [...this.rejecters.values()]) reject(new InterruptedError());
  }

  private mount(): void {
    if (this.instance || !this.interactive) return;
    this.instance = render(<HostView store={this.store} onInterrupt={() => this.interrupt()} />, {
      stdin: this.streams.stdin,
      stdout: this.streams.stdout,
      exitOnCtrlC: false,
      interactive: true,
      incrementalRendering: true,
      maxFps: 30,
    });
  }

  private async unmount(): Promise<void> {
    const instance = this.instance;
    if (!instance) return;
    this.instance = undefined;
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit().catch(() => undefined);
    this.store.set((state) => ({ ...state, log: [], tasks: [] }));
  }
}
