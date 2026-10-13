import { Box, Text, useWindowSize } from 'ink';
import type { RelayProgress, TargetProgress } from '../../relay/run.js';
import { formatBytes, formatDuration, formatSpeed, plural } from '../../util/format.js';
import { colors, symbols, toneColor, toneSymbol } from '../theme.js';
import { Frame } from './Frame.js';
import { KeyHints } from './KeyHints.js';
import { ProgressBar } from './ProgressBar.js';
import { Spinner } from './Spinner.js';

interface RelayViewProps {
  title: string;
  source: string;
  progress: RelayProgress | undefined;
  cancelling?: boolean;
}

function percent(fraction: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`.padStart(4);
}

function joinStats(parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(` ${symbols.dot} `);
}

function targetLine(target: TargetProgress): { text: string; color?: string } {
  const { progress, result, state } = target;
  if (state === 'retrying') {
    return { text: `Connection lost, retrying (${target.attempt})`, color: colors.warning };
  }
  if (result && state !== 'running') {
    if (state === 'done') {
      return {
        text:
          result.files > 0 ? `Done ${symbols.dot} ${plural(result.files, 'file')}` : 'Up to date',
        color: toneColor.success,
      };
    }
    if (state === 'cancelled') return { text: 'Cancelled', color: colors.warning };
    const message = result.error?.message ?? `${plural(result.failed.length, 'file')} failed`;
    return { text: message, color: toneColor.danger };
  }
  if (!progress) return { text: `Preparing${symbols.ellipsis}`, color: colors.muted };
  return {
    text: joinStats([
      `${formatBytes(progress.doneBytes)} of ${formatBytes(progress.totalBytes)}`,
      formatSpeed(progress.speed),
      progress.etaMs !== undefined &&
        progress.speed > 0 &&
        `${formatDuration(progress.etaMs)} left`,
      `${progress.doneFiles}/${progress.totalFiles} files`,
    ]),
    color: colors.muted,
  };
}

function targetFraction(target: TargetProgress): number {
  if (target.state === 'done') return 1;
  const progress = target.progress;
  if (!progress) return 0;
  if (progress.totalBytes > 0) return progress.doneBytes / progress.totalBytes;
  return progress.doneFiles / Math.max(1, progress.totalFiles);
}

function marker(target: TargetProgress) {
  switch (target.state) {
    case 'running':
    case 'retrying':
      return <Spinner color={target.state === 'retrying' ? colors.warning : colors.accent} />;
    case 'done':
      return <Text color={toneColor.success}>{toneSymbol.success}</Text>;
    case 'cancelled':
    case 'partial':
      return <Text color={toneColor.warning}>{toneSymbol.warning}</Text>;
    default:
      return <Text color={toneColor.danger}>{toneSymbol.danger}</Text>;
  }
}

export function RelayView({ title, source, progress, cancelling }: RelayViewProps) {
  const { columns } = useWindowSize();
  const width = Math.max(30, columns - 4);
  if (!progress) {
    return (
      <Frame title={title} marker={<Spinner />}>
        <Text color={colors.muted}>Preparing{symbols.ellipsis}</Text>
      </Frame>
    );
  }

  const labels = [source, ...progress.targets.map((target) => target.label)];
  const nameWidth = Math.min(20, Math.max(...labels.map((label) => label.length)) + 1);
  const barWidth = Math.max(10, Math.min(30, width - nameWidth - 12));
  const fetched = Math.min(progress.fetchedBytes, progress.neededBytes);
  const sourceDone = progress.neededBytes === 0 || fetched >= progress.neededBytes;

  return (
    <Frame
      title={title}
      marker={<Spinner color={cancelling ? colors.warning : colors.accent} />}
      footer={
        cancelling ? (
          <Text color={colors.warning}>Cancelling{symbols.ellipsis}</Text>
        ) : (
          <KeyHints hints={[['ctrl+c', 'cancel']]} />
        )
      }
    >
      <Box>
        <Box width={2} flexShrink={0}>
          {sourceDone ? (
            <Text color={colors.muted}>{symbols.arrowDown}</Text>
          ) : (
            <Spinner color={colors.muted} />
          )}
        </Box>
        <Box width={nameWidth} flexShrink={0}>
          <Text bold wrap="truncate-end">
            {source}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <ProgressBar
            value={progress.neededBytes > 0 ? fetched / progress.neededBytes : 1}
            width={barWidth}
            color="white"
          />
          <Text color={colors.muted}>
            {percent(progress.neededBytes > 0 ? fetched / progress.neededBytes : 1)}{' '}
          </Text>
        </Box>
        <Text color={colors.muted} wrap="truncate-end">
          {sourceDone
            ? `fetched ${formatBytes(progress.fetchedBytes)}`
            : joinStats([
                `${formatBytes(fetched)} of ${formatBytes(progress.neededBytes)}`,
                formatSpeed(progress.speed),
              ])}
        </Text>
      </Box>
      <Text> </Text>
      {progress.targets.map((target) => {
        const line = targetLine(target);
        return (
          <Box key={target.key}>
            <Box width={2} flexShrink={0}>
              {marker(target)}
            </Box>
            <Box width={nameWidth} flexShrink={0}>
              <Text wrap="truncate-end">{target.label}</Text>
            </Box>
            <Box flexShrink={0}>
              <ProgressBar
                value={targetFraction(target)}
                width={barWidth}
                color={target.state === 'retrying' ? colors.warning : colors.accent}
              />
              <Text bold>{percent(targetFraction(target))} </Text>
            </Box>
            <Text color={line.color} wrap="truncate-end">
              {line.text}
            </Text>
          </Box>
        );
      })}
    </Frame>
  );
}
