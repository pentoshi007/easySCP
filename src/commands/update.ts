import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { Context } from '../app/context.js';
import { AppError } from '../core/errors.js';
import {
  downloadBinary,
  removeRetiredExecutable,
  replaceExecutable,
  reportedVersion,
  stagingPath,
} from '../update/binary.js';
import { rememberLatest } from '../update/check.js';
import { type InstallMethod, installMethod } from '../update/method.js';
import {
  binaryAssetName,
  compareVersions,
  latestRelease,
  type Release,
} from '../update/release.js';
import { formatBytes } from '../util/format.js';
import { done, type Outcome } from './outcome.js';

const TOOL_NAMES = { npm: 'npm', brew: 'Homebrew' } as const;

function lastLines(text: string, count = 6): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}

function runTool(tool: keyof typeof TOOL_NAMES, args: string[], signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(tool, args, {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      signal,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (signal.aborted) reject(error);
      else if (error.code === 'ENOENT') reject(new AppError(`Couldn't find ${TOOL_NAMES[tool]}`));
      else reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const permission = /EACCES|EPERM|permission denied/i.test(output);
      reject(
        new AppError(
          `${TOOL_NAMES[tool]} couldn't update easyscp`,
          permission && tool === 'npm'
            ? 'Your global npm folder needs admin rights. Run `sudo npm install -g easyscp@latest`.'
            : lastLines(output) || undefined,
        ),
      );
    });
  });
}

async function updateBinary(ctx: Context, executable: string, release: Release): Promise<void> {
  const asset = binaryAssetName();
  if (!asset)
    throw new AppError(`There is no easyscp download for ${process.platform} ${process.arch}`);
  const staged = stagingPath(executable);
  await removeRetiredExecutable(executable);
  try {
    await ctx.ui.spin(`Downloading easyscp ${release.version}`, (setLabel) =>
      downloadBinary(release, asset, staged, {
        signal: ctx.ui.signal,
        onProgress: (received, total) =>
          setLabel(
            `Downloading easyscp ${release.version} · ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ''}`,
          ),
      }),
    );
    const reported = await ctx.ui
      .spin('Checking the new version', () => reportedVersion(staged))
      .catch(() => '');
    if (reported !== release.version) {
      throw new AppError(
        "The downloaded easyscp didn't start correctly",
        'Nothing was changed. Try again, or reinstall from the releases page.',
      );
    }
    await replaceExecutable(executable, staged);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError(
        `easyscp can't replace ${executable}`,
        process.platform === 'win32'
          ? 'Close other easyscp windows and try again, or run it as administrator.'
          : 'Run `sudo easyscp update`, or reinstall it somewhere you own.',
      );
    }
    throw error;
  } finally {
    await rm(staged, { force: true });
  }
}

async function apply(ctx: Context, method: InstallMethod, release: Release): Promise<void> {
  const { ui } = ctx;
  switch (method.kind) {
    case 'npm':
      return ui.spin(`Installing easyscp ${release.version} with npm`, () =>
        runTool('npm', ['install', '--global', `easyscp@${release.version}`], ui.signal),
      );
    case 'homebrew':
      await ui.spin('Updating Homebrew', () => runTool('brew', ['update', '--quiet'], ui.signal));
      return ui.spin(`Upgrading easyscp to ${release.version}`, () =>
        runTool('brew', ['upgrade', 'easyscp'], ui.signal),
      );
    case 'binary':
      return updateBinary(ctx, method.executable, release);
    case 'source':
      throw new AppError(
        `easyscp ${release.version} is available`,
        'This copy was built from source. Run `git pull && npm ci && npm run build` in its folder, or install the release with `npm install -g easyscp`.',
      );
  }
}

export async function updateCommand(ctx: Context): Promise<Outcome> {
  const { ui, args } = ctx;
  const method = installMethod();
  const release = await ui.spin('Checking for updates', () => latestRelease({ signal: ui.signal }));
  await rememberLatest(release.version).catch(() => undefined);
  if (compareVersions(release.version, __VERSION__) <= 0) {
    return done(`easyscp ${__VERSION__} is up to date`);
  }
  if (ui.interactive && !args.yes && method.kind !== 'source') {
    const proceed = await ui.confirm(`Update easyscp ${__VERSION__} to ${release.version}?`, {
      initial: true,
    });
    if (!proceed) return done(`Staying on ${__VERSION__}`);
  }
  await apply(ctx, method, release);
  return done(`Updated easyscp to ${release.version}`, `Was ${__VERSION__}`);
}
