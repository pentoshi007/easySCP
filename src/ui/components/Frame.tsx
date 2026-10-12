import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { colors, symbols, unicode } from '../theme.js';

export type FrameState = 'active' | 'done' | 'error' | 'warning';

const stateColor: Record<FrameState, string> = {
  active: colors.accent,
  done: colors.muted,
  error: colors.danger,
  warning: colors.warning,
};

const stateSymbol: Record<FrameState, string> = {
  active: symbols.active,
  done: symbols.done,
  error: symbols.error,
  warning: symbols.warning,
};

interface FrameProps {
  title: ReactNode;
  subtitle?: ReactNode;
  state?: FrameState;
  marker?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  closed?: boolean;
}

export function Gutter({ children, color }: { children?: ReactNode; color: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle={unicode ? 'single' : 'classic'}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color}
      borderDimColor={color === colors.muted}
      paddingLeft={2}
    >
      {children ?? <Text> </Text>}
    </Box>
  );
}

export function Frame({
  title,
  subtitle,
  state = 'active',
  marker,
  children,
  footer,
  closed = state === 'active',
}: FrameProps) {
  const color = stateColor[state];
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {marker ?? <Text color={color}>{stateSymbol[state]}</Text>}
        {'  '}
        <Text bold={state === 'active'}>{title}</Text>
        {subtitle ? <Text color={colors.muted}> {subtitle}</Text> : null}
      </Text>
      <Gutter color={state === 'active' ? color : colors.muted}>
        {children}
        {footer}
      </Gutter>
      {closed ? <Text color={color}>{symbols.end}</Text> : null}
    </Box>
  );
}

export function Line({ children, color = colors.muted }: { children?: ReactNode; color?: string }) {
  return <Gutter color={color}>{children}</Gutter>;
}
