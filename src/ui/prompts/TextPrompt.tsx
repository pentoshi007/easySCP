import { Text, useInput, usePaste, useWindowSize } from 'ink';
import { useState } from 'react';
import { KeyHints } from '../components/KeyHints.js';
import { TextField } from '../components/TextField.js';
import { applyKey, createEditor, insertText } from '../editor.js';
import { colors } from '../theme.js';
import type { PromptControls } from '../ui.js';

export interface TextOptions {
  initial?: string;
  placeholder?: string;
  hint?: string;
  mask?: string;
  allowEmpty?: boolean;
  error?: string;
  validate?: (value: string) => string | undefined;
}

export function TextPrompt({
  controls,
  options,
}: {
  controls: PromptControls<string>;
  options: TextOptions;
}) {
  const [state, setState] = useState(() => createEditor(options.initial ?? ''));
  const [error, setError] = useState(options.error);
  const { columns } = useWindowSize();

  usePaste((text) => {
    setState((current) => insertText(current, text));
    setError(undefined);
  });

  useInput((input, key) => {
    if (key.return) {
      const value = options.mask === undefined ? state.value.trim() : state.value;
      if (!value && !options.allowEmpty) {
        setError('This can’t be empty');
        return;
      }
      const problem = options.validate?.(value);
      if (problem) setError(problem);
      else controls.submit(value);
      return;
    }
    if (key.escape) {
      controls.cancel();
      return;
    }
    const next = applyKey(state, input, key);
    if (next) {
      setState(next);
      setError(undefined);
    }
  });

  return (
    <>
      <TextField
        value={state.value}
        cursor={state.cursor}
        width={columns - 4}
        placeholder={options.placeholder}
        mask={options.mask}
      />
      {error ? (
        <Text color={colors.danger}>{error}</Text>
      ) : options.hint ? (
        <Text color={colors.muted}>{options.hint}</Text>
      ) : null}
      <KeyHints
        hints={[
          ['enter', 'confirm'],
          ['esc', 'cancel'],
        ]}
      />
    </>
  );
}
