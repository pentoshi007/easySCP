import { Text } from 'ink';
import { Fragment } from 'react';
import { colors, symbols } from '../theme.js';

export type Hint = [keys: string, action: string];

export function KeyHints({ hints }: { hints: (Hint | false | undefined)[] }) {
  const visible = hints.filter((hint): hint is Hint => Array.isArray(hint));
  return (
    <Text color={colors.muted} wrap="truncate-end">
      {visible.map(([keys, action], index) => (
        <Fragment key={keys}>
          {index > 0 ? ` ${symbols.dot} ` : ''}
          <Text bold>{keys}</Text> {action}
        </Fragment>
      ))}
    </Text>
  );
}
