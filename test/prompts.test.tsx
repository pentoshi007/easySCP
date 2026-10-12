import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmPrompt } from '../src/ui/prompts/ConfirmPrompt.js';
import { MultiSelectPrompt, SelectPrompt } from '../src/ui/prompts/SelectPrompt.js';
import { TextPrompt } from '../src/ui/prompts/TextPrompt.js';
import { BACKSPACE, DOWN, ENTER, ESC, strip, tick, UP } from './helpers/ink.js';

function controls<T>() {
  return { submit: vi.fn<(value: T) => void>(), cancel: vi.fn() };
}

async function press(stdin: { write(data: string): void }, ...keys: string[]) {
  for (const value of keys) {
    stdin.write(value);
    await tick();
  }
}

describe('TextPrompt', () => {
  it('edits and submits', async () => {
    const ctl = controls<string>();
    const { stdin, lastFrame } = render(<TextPrompt controls={ctl} options={{ initial: 'ab' }} />);
    await tick();
    await press(stdin, 'c', BACKSPACE, 'd');
    expect(strip(lastFrame())).toContain('abd');
    await press(stdin, ENTER);
    expect(ctl.submit).toHaveBeenCalledWith('abd');
  });

  it('validates and refuses empty input', async () => {
    const ctl = controls<string>();
    const { stdin, lastFrame } = render(
      <TextPrompt
        controls={ctl}
        options={{ validate: (value) => (value === 'bad' ? 'Nope' : undefined) }}
      />,
    );
    await tick();
    await press(stdin, ENTER);
    expect(strip(lastFrame())).toContain('can’t be empty');
    await press(stdin, 'bad', ENTER);
    expect(strip(lastFrame())).toContain('Nope');
    expect(ctl.submit).not.toHaveBeenCalled();
  });

  it('masks secrets and cancels on escape', async () => {
    const ctl = controls<string>();
    const { stdin, lastFrame } = render(
      <TextPrompt controls={ctl} options={{ mask: '*', allowEmpty: true }} />,
    );
    await tick();
    await press(stdin, 'pw');
    expect(strip(lastFrame())).toContain('**');
    expect(strip(lastFrame())).not.toContain('pw');
    await press(stdin, ESC);
    await tick(80);
    expect(ctl.cancel).toHaveBeenCalled();
  });
});

describe('SelectPrompt', () => {
  const choices = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map(
    (label) => ({ value: label, label }),
  );

  it('navigates with arrows and wraps', async () => {
    const ctl = controls<string>();
    const { stdin } = render(
      <SelectPrompt controls={ctl} options={{ choices, initial: 'beta' }} />,
    );
    await tick();
    await press(stdin, DOWN, ENTER);
    expect(ctl.submit).toHaveBeenCalledWith('gamma');
  });

  it('filters by typing', async () => {
    const ctl = controls<string>();
    const { stdin, lastFrame } = render(<SelectPrompt controls={ctl} options={{ choices }} />);
    await tick();
    await press(stdin, 'th');
    expect(strip(lastFrame())).toContain('theta');
    expect(strip(lastFrame())).not.toContain('alpha');
    await press(stdin, ENTER);
    expect(ctl.submit).toHaveBeenCalledWith('theta');
  });

  it('skips disabled choices', async () => {
    const ctl = controls<number>();
    const { stdin } = render(
      <SelectPrompt
        controls={ctl}
        options={{
          choices: [
            { value: 1, label: 'one', disabled: 'unavailable' },
            { value: 2, label: 'two' },
          ],
        }}
      />,
    );
    await tick();
    await press(stdin, ENTER);
    expect(ctl.submit).toHaveBeenCalledWith(2);
    await press(stdin, UP, ENTER);
    expect(ctl.submit).toHaveBeenCalledTimes(1);
  });
});

describe('MultiSelectPrompt', () => {
  it('toggles and requires a selection', async () => {
    const ctl = controls<string[]>();
    const choices = ['a', 'b', 'c'].map((label) => ({ value: label, label }));
    const { stdin, lastFrame } = render(<MultiSelectPrompt controls={ctl} options={{ choices }} />);
    await tick();
    await press(stdin, ENTER);
    expect(strip(lastFrame())).toContain('Select at least one');
    await press(stdin, ' ', DOWN, DOWN, ' ', ENTER);
    expect(ctl.submit).toHaveBeenCalledWith(['a', 'c']);
  });

  it('selects all with ctrl+a', async () => {
    const ctl = controls<string[]>();
    const choices = ['a', 'b'].map((label) => ({ value: label, label }));
    const { stdin } = render(<MultiSelectPrompt controls={ctl} options={{ choices }} />);
    await tick();
    await press(stdin, '\u0001', ENTER);
    expect(ctl.submit).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('ConfirmPrompt', () => {
  it('answers with y and n', async () => {
    const ctl = controls<boolean>();
    const { stdin } = render(<ConfirmPrompt controls={ctl} options={{}} />);
    await tick();
    await press(stdin, 'n');
    expect(ctl.submit).toHaveBeenCalledWith(false);
  });
});

describe('TransferView', () => {
  it('renders overall and per-file progress', async () => {
    const { TransferView } = await import('../src/ui/components/TransferView.js');
    const { lastFrame } = render(
      <TransferView
        title="Uploading to prod"
        progress={{
          totalBytes: 2048,
          doneBytes: 1024,
          totalFiles: 2,
          doneFiles: 1,
          failedFiles: 0,
          active: [{ relative: 'docs/report.pdf', size: 1024, done: 512 }],
          speed: 512,
          etaMs: 2000,
          elapsedMs: 2000,
        }}
      />,
    );
    await tick();
    const frame = strip(lastFrame());
    expect(frame).toContain('Uploading to prod');
    expect(frame).toContain('50%');
    expect(frame).toContain('1.00 KB of 2.00 KB');
    expect(frame).toContain('512 B/s');
    expect(frame).toContain('docs/report.pdf');
  });
});
