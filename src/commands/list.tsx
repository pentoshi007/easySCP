import { Box, Text } from 'ink';
import type { Context } from '../app/context.js';
import { type Host, hostLabel, listHosts } from '../core/hosts.js';
import { collapseHome } from '../core/paths.js';
import { colors } from '../ui/theme.js';
import { formatRelative, plural } from '../util/format.js';
import { AUTH_LABELS } from './hostForm.js';
import { done, type Outcome } from './outcome.js';

function loginText(host: Host): string {
  const base = AUTH_LABELS[host.auth];
  const login = host.identityFile ? `${base} (${collapseHome(host.identityFile)})` : base;
  return host.jump ? `${login} via ${host.jump}` : login;
}

interface Columns {
  name: number;
  address: number;
  used: number;
  login: number;
}

function layout(hosts: Host[], width: number): Columns {
  const name = Math.max(4, ...hosts.map((host) => host.name.length)) + 2;
  const used = 10;
  const natural = Math.max(7, ...hosts.map((host) => hostLabel(host).length)) + 2;
  const rest = Math.max(0, width - name - used - 1);
  const address = Math.min(natural, Math.max(12, rest - 16));
  const login = Math.max(...hosts.map((host) => loginText(host).length), 5);
  return { name, address, used, login: Math.min(login, Math.max(0, rest - address)) };
}

function HostRow({
  cells,
  columns,
  header,
}: {
  cells: string[];
  columns: Columns;
  header?: boolean;
}) {
  const [name, address, used, login] = cells;
  return (
    <Box>
      <Box width={columns.name} flexShrink={0}>
        <Text bold={!header} color={header ? colors.muted : colors.accent} wrap="truncate-end">
          {name}
        </Text>
      </Box>
      <Box width={columns.address} flexShrink={0} paddingRight={2}>
        <Text color={header ? colors.muted : undefined} wrap="truncate-middle">
          {address}
        </Text>
      </Box>
      <Box width={columns.used} flexShrink={0}>
        <Text color={colors.muted}>{used}</Text>
      </Box>
      {columns.login > 4 ? (
        <Box width={columns.login} flexShrink={0}>
          <Text color={colors.muted} wrap="truncate-end">
            {login}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function HostTable({ hosts, width }: { hosts: Host[]; width: number }) {
  const columns = layout(hosts, width);
  return (
    <Box flexDirection="column">
      <HostRow header columns={columns} cells={['NAME', 'ADDRESS', 'USED', 'LOGIN']} />
      {hosts.map((host) => (
        <HostRow
          key={host.id}
          columns={columns}
          cells={[
            host.name,
            hostLabel(host),
            host.lastUsedAt ? formatRelative(host.lastUsedAt) : 'never',
            loginText(host),
          ]}
        />
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
  ctx.ui.print(<HostTable hosts={hosts} width={ctx.ui.columns} />);
  return ctx.ui.interactive ? done(plural(hosts.length, 'machine')) : undefined;
}
