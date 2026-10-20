import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { displayPath, isHidden } from '../fs/ops.js';
import type { Entry } from '../fs/types.js';
import { Highlight } from '../ui/components/Highlight.js';
import { Spinner } from '../ui/components/Spinner.js';
import { colors, symbols, unicode } from '../ui/theme.js';
import { formatBytes, formatRelative, plural, truncateMiddle } from '../util/format.js';
import { selectionInfo } from './model.js';
import type { Pane } from './usePane.js';

const edge = unicode
  ? { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', line: '─' }
  : { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', line: '-' };

const SIZE_WIDTH = 10;
const AGE_WIDTH = 10;
const POINTER_WIDTH = 2;
const MARK_WIDTH = symbols.checked.length + 1;

interface PaneViewProps {
  pane: Pane;
  active: boolean;
  width: number;
  height: number;
  filtering: boolean;
}

function entryColor(entry: Entry): string | undefined {
  if (entry.kind === 'dir') return colors.dir;
  if (entry.link) return colors.link;
  return undefined;
}

function suffix(entry: Entry): string {
  if (entry.kind === 'dir') return '/';
  if (entry.link) return '@';
  return '';
}

function Rule({
  left,
  right,
  width,
  color,
  children,
  used,
}: {
  left: string;
  right: string;
  width: number;
  color: string;
  children: ReactNode;
  used: number;
}) {
  const fill = Math.max(1, width - used - 5);
  return (
    <Box width={width} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text color={color}>
          {left}
          {edge.line}{' '}
        </Text>
        {children}
        <Text color={color}>
          {' '}
          {edge.line.repeat(fill)}
          {right}
        </Text>
      </Text>
    </Box>
  );
}

export function PaneView({ pane, active, width, height, filtering }: PaneViewProps) {
  const border = active ? colors.accent : colors.muted;
  const inner = Math.max(8, width - 4);
  const showSize = inner >= 32;
  const showAge = inner >= 50;
  const nameWidth =
    inner - POINTER_WIDTH - MARK_WIDTH - (showSize ? SIZE_WIDTH : 0) - (showAge ? AGE_WIDTH : 0);

  const location = displayPath(pane.fs, pane.dir);
  const room = Math.max(4, width - pane.label.length - 7);
  const shownLocation = truncateMiddle(location, room);

  const selection = pane.entries ? selectionInfo(pane.entries, pane.selected) : '';
  const info = filtering
    ? `/${pane.filter}`
    : [
        pane.filter
          ? `${pane.rows.length} of ${pane.listed} match /${pane.filter}`
          : plural(pane.listed, 'item'),
        pane.hidden > 0 ? `${pane.hidden} hidden` : '',
        selection,
      ]
        .filter(Boolean)
        .join(` ${symbols.dot} `);
  const trailing = filtering && selection ? ` ${symbols.dot} ${selection}` : '';
  const shownInfo = truncateMiddle(info, Math.max(4, width - 7 - trailing.length));

  const visible = pane.rows.slice(pane.cursor.offset, pane.cursor.offset + height);

  let body: ReactNode;
  if (pane.error) {
    body = (
      <Text color={colors.danger} wrap="wrap">
        {pane.error}
      </Text>
    );
  } else if (!pane.entries) {
    body = (
      <Text color={colors.muted}>
        <Spinner color={colors.accent} /> Loading
      </Text>
    );
  } else if (pane.rows.length === 0) {
    body = (
      <Text color={colors.muted}>
        {pane.filter ? `Nothing matches “${pane.filter}”` : 'Empty folder'}
      </Text>
    );
  } else {
    body = visible.map(({ entry, positions }, index) => {
      const isCursor = index + pane.cursor.offset === pane.cursor.index;
      const isSelected = pane.selected.has(entry.path);
      const highlighted = isCursor && active;
      return (
        <Box key={entry.path} height={1}>
          <Box width={POINTER_WIDTH} flexShrink={0}>
            <Text color={active ? colors.accent : colors.muted}>
              {isCursor ? symbols.pointer : ' '}
            </Text>
          </Box>
          <Box width={MARK_WIDTH} flexShrink={0}>
            <Text color={colors.success}>{isSelected ? symbols.checked : ' '}</Text>
          </Box>
          <Box width={Math.max(1, nameWidth)} flexShrink={0}>
            <Text wrap="truncate-middle">
              <Highlight
                text={entry.name}
                positions={positions}
                color={
                  highlighted ? colors.accent : isSelected ? colors.success : entryColor(entry)
                }
                bold={highlighted}
                dim={isHidden(entry.name) && !highlighted}
              />
              <Text color={colors.muted}>{suffix(entry)}</Text>
            </Text>
          </Box>
          {showSize ? (
            <Box width={SIZE_WIDTH} flexShrink={0} justifyContent="flex-end">
              <Text color={colors.muted}>
                {entry.kind === 'file' && entry.size >= 0 ? formatBytes(entry.size) : ''}
              </Text>
            </Box>
          ) : null}
          {showAge ? (
            <Box width={AGE_WIDTH} flexShrink={0} justifyContent="flex-end">
              <Text color={colors.muted}>{entry.mtime > 0 ? formatRelative(entry.mtime) : ''}</Text>
            </Box>
          ) : null}
        </Box>
      );
    });
  }

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Rule
        left={edge.topLeft}
        right={edge.topRight}
        width={width}
        color={border}
        used={pane.label.length + 1 + shownLocation.length}
      >
        <Text color={active ? colors.accent : colors.muted} bold={active}>
          {pane.label}
        </Text>{' '}
        <Text bold={active} color={active ? undefined : colors.muted}>
          {shownLocation}
        </Text>
      </Rule>
      <Box
        flexDirection="column"
        height={height}
        borderStyle={unicode ? 'round' : 'classic'}
        borderTop={false}
        borderBottom={false}
        borderColor={border}
        borderDimColor={!active}
        paddingX={1}
        overflow="hidden"
      >
        {body}
      </Box>
      <Rule
        left={edge.bottomLeft}
        right={edge.bottomRight}
        width={width}
        color={border}
        used={shownInfo.length + (filtering ? 1 : 0) + trailing.length}
      >
        <Text color={filtering ? colors.warning : colors.muted}>{shownInfo}</Text>
        {filtering ? <Text inverse> </Text> : null}
        {trailing ? <Text color={colors.muted}>{trailing}</Text> : null}
      </Rule>
    </Box>
  );
}
