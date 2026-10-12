import { Box, Text } from 'ink';
import type { Context } from '../app/context.js';
import { type Host, hostLabel, listHosts } from '../core/hosts.js';
import { collapseHome } from '../core/paths.js';
import { colors } from '../ui/theme.js';
import { formatRelative, plural } from '../util/format.js';
import { AUTH_LABELS } from './hostForm.js';
import { done, type Outcome } from './outcome.js';

function loginLabel(host: Host): string {
  const base = AUTH_LABELS[host.auth];
  return host.identityFile ? `${base} (${collapseHome(host.identityFile)})` : base;
}

function HostTable({ hosts }: { hosts: Host[] }) {
  const nameWidth = Math.max(4, ...hosts.map((host) => host.name.length)) + 2;
  const addressWidth = Math.max(7, ...hosts.map((host) => hostLabel(host).length)) + 2;
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={nameWidth}>
          <Text color={colors.muted}>NAME</Text>
        </Box>
        <Box width={addressWidth}>
          <Text color={colors.muted}>ADDRESS</Text>
        </Box>
        <Box width={12}>
          <Text color={colors.muted}>USED</Text>
        </Box>
        <Text color={colors.muted}>LOGIN</Text>
      </Box>
      {hosts.map((host) => (
        <Box key={host.id}>
          <Box width={nameWidth}>
            <Text bold color={colors.accent}>
              {host.name}
            </Text>
          </Box>
          <Box width={addressWidth}>
            <Text>{hostLabel(host)}</Text>
          </Box>
          <Box width={12}>
            <Text color={colors.muted}>
              {host.lastUsedAt ? formatRelative(host.lastUsedAt) : 'never'}
            </Text>
          </Box>
          <Text color={colors.muted} wrap="truncate-end">
            {loginLabel(host)}
            {host.jump ? ` via ${host.jump}` : ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export async function listCommand(ctx: Context): Promise<Outcome | undefined> {
  const hosts = await listHosts();
  if (ctx.args.json) {
    process.stdout.write(`${JSON.stringify(hosts, null, 2)}\n`);
    return undefined;
  }
  if (hosts.length === 0) {
    ctx.ui.note('No machines saved yet. Add one with: easyscp add');
    return undefined;
  }
  ctx.ui.print(<HostTable hosts={hosts} />);
  return ctx.ui.interactive ? done(plural(hosts.length, 'machine')) : undefined;
}
