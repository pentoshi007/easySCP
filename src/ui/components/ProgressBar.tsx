import { Text } from 'ink';
import { colors, symbols, unicode } from '../theme.js';

interface ProgressBarProps {
  value: number;
  width: number;
  color?: string;
}

export function ProgressBar({ value, width, color = colors.accent }: ProgressBarProps) {
  const size = Math.max(4, Math.floor(width));
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const exact = fraction * size;
  const full = Math.floor(exact);
  const head = full < size && exact - full >= 0.5 ? 1 : 0;
  const empty = size - full - head;
  return (
    <Text>
      <Text color={color}>{symbols.barFull.repeat(full)}</Text>
      {head ? <Text color={color}>{symbols.barHead}</Text> : null}
      <Text color={colors.muted} dimColor={unicode}>
        {symbols.barEmpty.repeat(empty)}
      </Text>
    </Text>
  );
}
