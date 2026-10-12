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
  const prefix = fs.local ? '' : `${fs.label}:`;
  const [first] = paths;
  if (!first) return '';
  if (paths.length === 1) return `${prefix}${displayPath(fs, first)}`;
  const parent = fs.path.dirname(first);
  const shared = paths.every((path) => fs.path.dirname(path) === parent);
  const names = paths
    .slice(0, 3)
    .map((path) => (shared ? fs.path.basename(path) : displayPath(fs, path)));
  const rest = paths.length - names.length;
  const list = `${names.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
  return shared ? `${list} in ${prefix}${displayPath(fs, parent)}` : `${prefix}${list}`;
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
