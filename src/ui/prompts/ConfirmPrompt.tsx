import { Text, useInput } from 'ink';
import { useState } from 'react';
import { KeyHints } from '../components/KeyHints.js';
import { isPlain } from '../keys.js';
import { colors, symbols } from '../theme.js';
import type { PromptControls } from '../ui.js';

export interface ConfirmOptions {
  initial?: boolean;
  yes?: string;
  no?: string;
  danger?: boolean;
}

export function ConfirmPrompt({
  controls,
  options,
}: {
  controls: PromptControls<boolean>;
  options: ConfirmOptions;
}) {
  const [value, setValue] = useState(options.initial ?? true);

  useInput((input, key) => {
    if (key.return) controls.submit(value);
    else if (key.escape) controls.cancel();
    else if (key.leftArrow || key.rightArrow || key.tab || key.upArrow || key.downArrow) {
      setValue((current) => !current);
    } else if (isPlain(key)) {
      const answer = input.toLowerCase();
      if (answer === 'y') controls.submit(true);
      else if (answer === 'n') controls.submit(false);
    }
  });

  const yesColor = options.danger ? colors.danger : colors.success;
  return (
    <>
      <Text>
        <Text color={value ? yesColor : colors.muted}>
          {value ? symbols.radioOn : symbols.radioOff} {options.yes ?? 'Yes'}
        </Text>
        <Text color={colors.muted}> / </Text>
        <Text color={value ? colors.muted : colors.accent}>
          {value ? symbols.radioOff : symbols.radioOn} {options.no ?? 'No'}
        </Text>
      </Text>
      <KeyHints
        hints={[
          ['y/n', 'answer'],
          ['←→', 'toggle'],
          ['enter', 'confirm'],
        ]}
      />
    </>
  );
}
