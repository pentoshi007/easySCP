import { Box, Text, useWindowSize } from 'ink';
import type { TransferProgress } from '../../transfer/run.js';
import { formatBytes, formatDuration, formatSpeed, truncateMiddle } from '../../util/format.js';
import { colors, symbols } from '../theme.js';
import { Frame } from './Frame.js';
import { KeyHints } from './KeyHints.js';
import { ProgressBar } from './ProgressBar.js';
import { Spinner } from './Spinner.js';

interface TransferViewProps {
  title: string;
  progress: TransferProgress | undefined;
  cancelling?: boolean;
  scanned?: number;
}

const MAX_ACTIVE_ROWS = 4;

function percent(done: number, total: number): string {
  if (total <= 0) return '100%';
  return `${Math.floor((done / total) * 100)}%`.padStart(4);
}

export function TransferView({ title, progress, cancelling, scanned }: TransferViewProps) {
  const { columns } = useWindowSize();
  const width = Math.max(20, columns - 4);
  const barWidth = Math.max(10, Math.min(48, width - 8));

  if (!progress) {
    return (
      <Frame title={title} marker={<Spinner />}>
        <Text color={colors.muted}>
          {scanned
            ? `Scanning${symbols.ellipsis} ${scanned.toLocaleString()} items`
            : `Preparing${symbols.ellipsis}`}
        </Text>
      </Frame>
    );
  }

  const { totalBytes, doneBytes, totalFiles, doneFiles, failedFiles, speed, etaMs } = progress;
  const fraction = totalBytes > 0 ? doneBytes / totalBytes : doneFiles / Math.max(1, totalFiles);
  const stats = [
    `${formatBytes(doneBytes)} of ${formatBytes(totalBytes)}`,
    formatSpeed(speed),
    etaMs !== undefined && speed > 0 ? `${formatDuration(etaMs)} left` : undefined,
    `${doneFiles}/${totalFiles} files`,
  ].filter(Boolean);

  const nameWidth = Math.max(12, width - 30);
  const rows = progress.active.slice(0, MAX_ACTIVE_ROWS);
  const hidden = progress.active.length - rows.length;

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
      <Text>
        <ProgressBar value={fraction} width={barWidth} />{' '}
        <Text bold>{percent(doneBytes, totalBytes)}</Text>
      </Text>
      <Text color={colors.muted} wrap="truncate-end">
        {stats.join(` ${symbols.dot} `)}
        {failedFiles > 0 ? (
          <Text color={colors.danger}>
            {' '}
            {symbols.dot} {failedFiles} failed
          </Text>
        ) : null}
      </Text>
      {rows.length > 0 ? <Text> </Text> : null}
      {rows.map((file) => (
        <Box key={file.relative}>
          <Box width={nameWidth} flexShrink={1}>
            <Text wrap="truncate-end">{truncateMiddle(file.relative, nameWidth - 1)}</Text>
          </Box>
          <Box width={10} justifyContent="flex-end">
            <Text color={colors.muted}>{formatBytes(file.size)}</Text>
          </Box>
          <Text> </Text>
          <ProgressBar value={file.size > 0 ? file.done / file.size : 1} width={10} />
          <Text color={colors.muted}>{percent(file.done, file.size)}</Text>
        </Box>
      ))}
      {hidden > 0 ? (
        <Text color={colors.muted}>
          {symbols.ellipsis} and {hidden} more
        </Text>
      ) : null}
    </Frame>
  );
}
