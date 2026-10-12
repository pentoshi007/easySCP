import { Text } from 'ink';
import { colors } from '../theme.js';

interface TextFieldProps {
  value: string;
  cursor: number;
  width: number;
  focus?: boolean;
  placeholder?: string;
  mask?: string;
}

function visibleWindow(length: number, cursor: number, width: number): [number, number] {
  if (length < width) return [0, length];
  const room = Math.max(1, width - 1);
  const start = Math.max(0, Math.min(cursor - Math.floor(room * 0.7), length - room + 1));
  return [start, Math.min(length, start + room)];
}

export function TextField({
  value,
  cursor,
  width,
  focus = true,
  placeholder,
  mask,
}: TextFieldProps) {
  const list = Array.from(mask === undefined ? value : mask.repeat(Array.from(value).length));

  if (list.length === 0) {
    if (!placeholder) return focus ? <Text inverse> </Text> : <Text> </Text>;
    const [first = ' ', ...rest] = Array.from(placeholder);
    return (
      <Text color={colors.muted} wrap="truncate-end">
        {focus ? <Text inverse>{first}</Text> : first}
        {rest.join('')}
      </Text>
    );
  }

  const [start, end] = visibleWindow(list.length, cursor, Math.max(4, width));
  const before = list.slice(start, cursor).join('');
  const at = list[cursor] ?? ' ';
  const after = list.slice(cursor + 1, end).join('');
  const leading = start > 0 ? '…' : '';
  const trailing = end < list.length ? '…' : '';

  if (!focus) {
    return (
      <Text wrap="truncate-end">
        {leading}
        {list.slice(start, end).join('')}
        {trailing}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text color={colors.muted}>{leading}</Text>
      {before}
      <Text inverse>{at}</Text>
      {cursor < end ? after : ''}
      <Text color={colors.muted}>{trailing}</Text>
    </Text>
  );
}
