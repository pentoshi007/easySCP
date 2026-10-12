import { existsSync } from 'node:fs';
import os from 'node:os';
import type { Context } from '../app/context.js';
import {
  createHost,
  type HostDraft,
  listHosts,
  sameName,
  sanitizeHostName,
  updateHost,
  validateHostName,
} from '../core/hosts.js';
import { collapseHome, sshDir } from '../core/paths.js';
import { readSshConfig, type SshConfigHost } from '../ssh/sshConfig.js';
import { plural } from '../util/format.js';
import { done, type Outcome, warn } from './outcome.js';

interface Candidate {
  entry: SshConfigHost;
  draft: HostDraft;
  jumpAlias?: string;
}

function toDraft(entry: SshConfigHost): Candidate {
  const identityFile = entry.identityFiles.find((file) => existsSync(file));
  const draft: HostDraft = {
    name: sanitizeHostName(entry.alias),
    hostname: entry.hostname,
    port: entry.port ?? 22,
    user: entry.user ?? os.userInfo().username,
    auth: 'auto',
  };
  if (identityFile) draft.identityFile = identityFile;
  const jumpAlias = entry.proxyJump?.split(',')[0]?.trim();
  return jumpAlias ? { entry, draft, jumpAlias } : { entry, draft };
}

export async function importCandidates(): Promise<Candidate[]> {
  const existing = await listHosts();
  const entries = await readSshConfig();
  return entries
    .map(toDraft)
    .filter(
      ({ draft }) =>
        draft.name &&
        !existing.some(
          (host) =>
            sameName(host.name, draft.name) ||
            (host.hostname === draft.hostname &&
              host.user === draft.user &&
              host.port === draft.port),
        ),
    );
}

export async function importCommand(ctx: Context): Promise<Outcome> {
  const candidates = await importCandidates();
  if (candidates.length === 0) {
    return warn(`Nothing new to import from ${collapseHome(sshDir())}/config`, 0);
  }

  const chosen = ctx.args.yes
    ? candidates
    : await ctx.ui.multiselect('Which machines should be imported?', {
        choices: candidates.map((candidate) => ({
          value: candidate,
          label: candidate.draft.name,
          hint: `${candidate.draft.user}@${candidate.draft.hostname}${candidate.draft.port === 22 ? '' : `:${candidate.draft.port}`}${candidate.draft.identityFile ? `  ${collapseHome(candidate.draft.identityFile)}` : ''}`,
        })),
        selected: candidates,
      });

  const imported: string[] = [];
  const skipped: string[] = [];
  for (const candidate of chosen) {
    const hosts = await listHosts();
    if (validateHostName(candidate.draft.name, hosts)) {
      skipped.push(candidate.entry.alias);
      continue;
    }
    await createHost(candidate.draft);
    imported.push(candidate.draft.name);
  }

  const hosts = await listHosts();
  for (const candidate of chosen) {
    const { jumpAlias } = candidate;
    if (!jumpAlias) continue;
    const jump = hosts.find((host) => sameName(host.name, sanitizeHostName(jumpAlias)));
    const host = hosts.find((entry) => sameName(entry.name, candidate.draft.name));
    if (jump && host && jump.id !== host.id) {
      await updateHost(host.id, { jump: jump.name });
    } else if (host) {
      ctx.ui.note(
        `${host.name} uses ProxyJump ${jumpAlias}; set it with easyscp edit ${host.name}`,
        'warning',
      );
    }
  }

  if (skipped.length > 0) ctx.ui.note(`Skipped ${skipped.join(', ')}`, 'warning');
  return done(`Imported ${plural(imported.length, 'machine')}`);
}
