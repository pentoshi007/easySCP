import type { ReactNode } from 'react';
import { displayPath } from '../../fs/ops.js';
import type { FileSystem } from '../../fs/types.js';
import type { Ui } from '../ui.js';
import { Browser } from './Browser.js';
import type { Shortcut } from './model.js';

export interface PickOptions {
  fs: FileSystem;
  start: string;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: string;
  shortcuts?: Shortcut[];
}

export function summarizePaths(fs: FileSystem, paths: string[]): string {
  const shown = paths.slice(0, 3).map((path) => displayPath(fs, path));
  const rest = paths.length - shown.length;
  const prefix = fs.local ? '' : `${fs.label}:`;
  return `${prefix}${shown.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

export function pickFiles(ui: Ui, options: PickOptions): Promise<string[]> {
  return ui.prompt<string[]>({
    title: options.title,
    subtitle: options.subtitle,
    body: (controls) => (
      <Browser
        fs={options.fs}
        start={options.start}
        mode="files"
        action={options.action}
        shortcuts={options.shortcuts}
        onSubmit={controls.submit}
        onCancel={controls.cancel}
      />
    ),
    summary: (paths) => summarizePaths(options.fs, paths),
  });
}

export function pickFile(ui: Ui, options: PickOptions): Promise<string> {
  return ui.prompt<string>({
    title: options.title,
    subtitle: options.subtitle,
    body: (controls) => (
      <Browser
        fs={options.fs}
        start={options.start}
        mode="file"
        action={options.action}
        onSubmit={([path]) => (path ? controls.submit(path) : controls.cancel())}
        onCancel={controls.cancel}
      />
    ),
    summary: (path) => summarizePaths(options.fs, [path]),
  });
}

export function pickDirectory(ui: Ui, options: PickOptions): Promise<string> {
  return ui.prompt<string>({
    title: options.title,
    subtitle: options.subtitle,
    body: (controls) => (
      <Browser
        fs={options.fs}
        start={options.start}
        mode="dir"
        action={options.action}
        shortcuts={options.shortcuts}
        onSubmit={([path]) => (path ? controls.submit(path) : controls.cancel())}
        onCancel={controls.cancel}
      />
    ),
    summary: (path) => summarizePaths(options.fs, [path]),
  });
}
