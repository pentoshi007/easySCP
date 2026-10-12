import { Text, useAnimation } from 'ink';
import { colors, symbols } from '../theme.js';

export function Spinner({ color = colors.accent }: { color?: string }) {
  const { frame } = useAnimation({ interval: 80 });
  return <Text color={color}>{symbols.spinner[frame % symbols.spinner.length]}</Text>;
}
