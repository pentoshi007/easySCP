import { Box, type Key, Text, useInput, useWindowSize } from 'ink';
import { type ReactNode, useMemo, useState } from 'react';
import { fuzzyFilter } from '../../util/fuzzy.js';
import { Highlight } from '../components/Highlight.js';
import { type Hint, KeyHints } from '../components/KeyHints.js';
import { TextField } from '../components/TextField.js';
import { applyKey, createEditor } from '../editor.js';
import { useListCursor } from '../list.js';
import { colors, symbols } from '../theme.js';
import type { PromptControls } from '../ui.js';

export interface Choice<T> {
  value: T;
  key?: string;
  label: string;
  hint?: string;
  description?: string;
  disabled?: string | false;
  color?: string;
}

export interface SelectOptions<T> {
  choices: Choice<T>[];
  initial?: T;
  filter?: boolean;
  limit?: number;
  emptyText?: string;
}

export interface MultiSelectOptions<T> extends SelectOptions<T> {
  selected?: T[];
  required?: boolean;
}

function pageSize(rows: number, limit = 10): number {
  return Math.max(3, Math.min(limit, rows - 8));
}

function initialIndex<T>(options: SelectOptions<T>): number {
  const start = options.choices.findIndex(
    (choice) => choice.value === options.initial && !choice.disabled,
  );
  if (start >= 0) return start;
  return Math.max(
    0,
    options.choices.findIndex((choice) => !choice.disabled),
  );
}

function useChoices<T>(options: SelectOptions<T>) {
  const { rows } = useWindowSize();
  const filterable = options.filter ?? options.choices.length > 7;
  const [query, setQuery] = useState(createEditor());
  const matches = useMemo(
    () =>
      fuzzyFilter(
        options.choices,
        filterable ? query.value : '',
        (choice) => `${choice.label} ${choice.hint ?? ''}`,
      ),
    [options.choices, filterable, query.value],
  );
  const size = pageSize(rows, options.limit);
  const cursor = useListCursor(matches.length, size, initialIndex(options));
  return { filterable, query, setQuery, matches, size, cursor };
}

function keyOf<T>(choice: Choice<T>): string {
  const { value } = choice;
  if (choice.key) return choice.key;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : choice.label;
}

interface ChoiceRowsProps<T> {
  state: ReturnType<typeof useChoices<T>>;
  emptyText?: string;
  marker?: (choice: Choice<T>, active: boolean) => ReactNode;
}

function ChoiceRows<T>({ state, emptyText, marker }: ChoiceRowsProps<T>) {
  const { matches, cursor, size, filterable, query } = state;
  const { columns } = useWindowSize();
  const visible = matches.slice(cursor.offset, cursor.offset + size);
  const active = matches[cursor.index]?.item;
  return (
    <>
      {filterable && query.value ? (
        <Text>
          <Text color={colors.muted}>filter </Text>
          <TextField value={query.value} cursor={query.cursor} width={columns - 12} />
        </Text>
      ) : null}
      {cursor.offset > 0 ? (
        <Text color={colors.muted}>
          {symbols.arrowUp} {cursor.offset} more
        </Text>
      ) : null}
      {visible.length === 0 ? (
        <Text color={colors.muted}>{emptyText ?? 'No matches'}</Text>
      ) : (
        visible.map(({ item, positions }) => {
          const isActive = item === active;
          const disabled = Boolean(item.disabled);
          return (
            <Box key={keyOf(item)}>
              <Box flexShrink={0}>
                <Text color={isActive ? colors.accent : undefined}>
                  {isActive ? symbols.pointer : ' '}{' '}
                </Text>
                {marker ? marker(item, isActive) : null}
              </Box>
              <Box flexShrink={1}>
                <Text wrap="truncate-end">
                  <Highlight
                    text={item.label}
                    positions={positions.filter((position) => position < item.label.length)}
                    color={disabled ? colors.muted : isActive ? colors.accent : item.color}
                    bold={isActive}
                  />
                  {item.hint ? <Text color={colors.muted}>{`  ${item.hint}`}</Text> : null}
                  {disabled ? <Text color={colors.muted}> ({item.disabled})</Text> : null}
                </Text>
              </Box>
            </Box>
          );
        })
      )}
      {cursor.offset + size < matches.length ? (
        <Text color={colors.muted}>
          {symbols.arrowDown} {matches.length - cursor.offset - size} more
        </Text>
      ) : null}
      {active?.description ? (
        <Text color={colors.muted} wrap="wrap">
          {active.description}
        </Text>
      ) : null}
    </>
  );
}

function handleFilterKey<T>(
  state: ReturnType<typeof useChoices<T>>,
  input: string,
  key: Key,
): boolean {
  if (!state.filterable || key.upArrow || key.downArrow) return false;
  const next = applyKey(state.query, input, key);
  if (!next || next === state.query) return Boolean(next);
  state.setQuery(next);
  state.cursor.jump(0);
  return true;
}

export function SelectPrompt<T>({
  controls,
  options,
}: {
  controls: PromptControls<T>;
  options: SelectOptions<T>;
}) {
  const state = useChoices(options);

  useInput((input, key) => {
    if (key.return) {
      const choice = state.matches[state.cursor.index]?.item;
      if (choice && !choice.disabled) controls.submit(choice.value);
      return;
    }
    if (key.escape) {
      if (state.query.value) state.setQuery(createEditor());
      else controls.cancel();
      return;
    }
    if (state.cursor.handle(input, key)) return;
    handleFilterKey(state, input, key);
  });

  const hints: Hint[] = [
    ['↑↓', 'move'],
    ['enter', 'select'],
  ];
  if (state.filterable && !state.query.value) hints.push(['type', 'to filter']);
  hints.push(['esc', state.query.value ? 'clear' : 'back']);

  return (
    <>
      <ChoiceRows state={state} emptyText={options.emptyText} />
      <KeyHints hints={hints} />
    </>
  );
}

export function MultiSelectPrompt<T>({
  controls,
  options,
}: {
  controls: PromptControls<T[]>;
  options: MultiSelectOptions<T>;
}) {
  const state = useChoices(options);
  const [selected, setSelected] = useState(() => new Set(options.selected ?? []));
  const [error, setError] = useState<string>();

  const toggle = (value: T) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  useInput((input, key) => {
    if (key.return) {
      const values = options.choices
        .filter((choice) => selected.has(choice.value))
        .map((choice) => choice.value);
      if (values.length === 0 && options.required !== false) {
        setError('Select at least one with space');
        return;
      }
      controls.submit(values);
      return;
    }
    if (key.escape) {
      if (state.query.value) state.setQuery(createEditor());
      else controls.cancel();
      return;
    }
    if (input === ' ' && !key.ctrl) {
      const choice = state.matches[state.cursor.index]?.item;
      if (choice && !choice.disabled) toggle(choice.value);
      setError(undefined);
      return;
    }
    if (key.ctrl && input === 'a') {
      const enabled = state.matches
        .filter(({ item }) => !item.disabled)
        .map(({ item }) => item.value);
      const all = enabled.every((value) => selected.has(value));
      setSelected((current) => {
        const next = new Set(current);
        for (const value of enabled) {
          if (all) next.delete(value);
          else next.add(value);
        }
        return next;
      });
      return;
    }
    if (state.cursor.handle(input, key)) return;
    handleFilterKey(state, input, key);
  });

  return (
    <>
      <ChoiceRows
        state={state}
        emptyText={options.emptyText}
        marker={(choice, active) => (
          <Text
            color={
              selected.has(choice.value) ? colors.success : active ? colors.accent : colors.muted
            }
          >
            {selected.has(choice.value) ? symbols.checked : symbols.unchecked}{' '}
          </Text>
        )}
      />
      {error ? <Text color={colors.danger}>{error}</Text> : null}
      <KeyHints
        hints={[
          ['space', 'toggle'],
          ['ctrl+a', 'all'],
          ['enter', `confirm${selected.size ? ` (${selected.size})` : ''}`],
          ['esc', 'back'],
        ]}
      />
    </>
  );
}
