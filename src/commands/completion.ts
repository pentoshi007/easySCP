import type { Context } from '../app/context.js';
import { detectShell, shellNamed } from '../completion/detect.js';
import {
  type InstalledCompletion,
  installCompletion,
  uninstallCompletion,
} from '../completion/install.js';
import type { Shell } from '../completion/scripts.js';
import { AppError } from '../core/errors.js';
import { collapseHome } from '../core/paths.js';
import { joinNames } from '../util/format.js';
import { done, type Outcome } from './outcome.js';

const SHELL_NAMES: Record<Shell, string> = {
  bash: 'bash',
  zsh: 'zsh',
  fish: 'fish',
  powershell: 'PowerShell',
};

export function describeInstalled(installed: InstalledCompletion): {
  message: string;
  detail: string;
} {
  const message = `Tab completion is ready for ${SHELL_NAMES[installed.shell]}`;
  if (installed.profiles.length === 0) {
    return { message, detail: `It works in new ${SHELL_NAMES[installed.shell]} sessions.` };
  }
  const where = joinNames(installed.profiles.map(collapseHome));
  return { message, detail: `Added to ${where}. Open a new terminal to use it.` };
}

export async function completionCommand(ctx: Context): Promise<Outcome> {
  const [action, name] = ctx.args.positionals;
  const chosen = shellNamed(name);
  if (action === 'uninstall') {
    const removed = await uninstallCompletion(chosen);
    if (removed.length === 0) return done('Tab completion was not set up');
    return done('Removed tab completion', `Changed ${joinNames(removed.map(collapseHome))}`);
  }
  const shell = chosen ?? (await detectShell());
  if (!shell) {
    throw new AppError(
      "Couldn't tell which shell you use",
      'Name it, like `easyscp completion install zsh`. Supported: bash, zsh, fish and powershell.',
    );
  }
  const installed = await ctx.ui.spin('Setting up tab completion', () => installCompletion(shell));
  const { message, detail } = describeInstalled(installed);
  return done(message, detail);
}
