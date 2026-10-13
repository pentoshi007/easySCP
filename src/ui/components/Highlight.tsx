import { Text } from 'ink';
import { printable } from '../../util/format.js';
import { colors } from '../theme.js';

interface HighlightProps {
  text: string;
  positions: readonly number[];
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

interface Segment {
  start: number;
  text: string;
  match: boolean;
}

function segments(text: string, positions: readonly number[]): Segment[] {
  const marks = new Set(positions);
  const parts: Segment[] = [];
  let index = 0;
  for (const char of text) {
    const match = marks.has(index);
    const last = parts.at(-1);
    if (last && last.match === match) last.text += char;
    else parts.push({ start: index, text: char, match });
    index += char.length;
  }
  return parts;
}

export function Highlight({ text: raw, positions, color, bold, dim }: HighlightProps) {
  const text = printable(raw);
  return (
    <Text color={color} bold={bold} dimColor={dim}>
      {positions.length === 0
        ? text
        : segments(text, positions).map((part) =>
            part.match ? (
              <Text key={part.start} color={colors.match} bold>
                {part.text}
              </Text>
            ) : (
              <Text key={part.start}>{part.text}</Text>
            ),
          )}
    </Text>
  );
}
