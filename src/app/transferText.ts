import { isIdentical, type TransferPlan } from '../transfer/plan.js';
import type { ConflictPolicy, TransferResult } from '../transfer/run.js';
import type { Choice } from '../ui/prompts/SelectPrompt.js';
import { symbols, type Tone } from '../ui/theme.js';
import { formatBytes, formatDuration, formatSpeed, plural } from '../util/format.js';

export interface ConflictQuestion {
  title: string;
  choices: Choice<ConflictPolicy>[];
  initial: ConflictPolicy;
}

export function conflictQuestion(plan: TransferPlan, where: string): ConflictQuestion {
  const { conflicts, files } = plan;
  const identical = conflicts.filter(isIdentical).length;
  const shorter = conflicts.filter(
    (file) => file.existing && file.existing.size < file.size && file.existing.size > 0,
  ).length;
  const one = conflicts.length === 1;
  const same = identical === conflicts.length;
  const choices: Choice<ConflictPolicy>[] = [
    {
      value: 'skip',
      label: one ? 'Skip it' : 'Skip them',
      hint: same ? (one ? 'it looks identical' : 'they look identical') : 'keep what is there',
    },
    { value: 'overwrite', label: one ? 'Replace it' : 'Replace them' },
    {
      value: 'newer',
      label: one ? 'Replace it if older' : 'Replace only older ones',
      hint: 'compares modification time',
    },
    { value: 'rename', label: 'Keep both', hint: 'new copies get a number, like file (1).txt' },
  ];
  if (shorter > 0) {
    choices.push({
      value: 'resume',
      label: 'Resume',
      hint: `continue ${plural(shorter, 'file')} that stopped part way`,
    });
  }
  const what =
    conflicts.length === files.length
      ? conflicts.length === 1
        ? 'This file already exists'
        : `All ${conflicts.length} files already exist`
      : `${conflicts.length} of ${files.length} files already exist`;
  return {
    title: `${what} ${where}`,
    choices,
    initial: shorter > 0 && shorter === conflicts.length ? 'resume' : 'skip',
  };
}

export interface ResultSummary {
  tone: Tone;
  message: string;
  detail: string;
}

export function summarizeResult(
  result: TransferResult,
  verb: string,
  where: string,
): ResultSummary {
  const files = plural(result.files, 'file');
  const rate = result.durationMs > 0 ? (result.bytes * 1000) / result.durationMs : 0;
  const join = (parts: (string | false | undefined)[]) =>
    parts.filter(Boolean).join(` ${symbols.dot} `);
  const skipped = result.skipped > 0 && `${plural(result.skipped, 'existing file')} skipped`;

  switch (result.status) {
    case 'done':
      if (result.files === 0) {
        return {
          tone: 'success',
          message: 'Everything is already up to date',
          detail: join([skipped]),
        };
      }
      return {
        tone: 'success',
        message: `${verb} ${files} ${where}`,
        detail: join([
          formatBytes(result.bytes),
          `in ${formatDuration(result.durationMs)}`,
          result.bytes > 0 && result.durationMs >= 200 && formatSpeed(rate),
          skipped,
        ]),
      };
    case 'cancelled':
      return {
        tone: 'warning',
        message: `Cancelled after ${files}`,
        detail:
          result.keptPartials > 0 ? 'Run the same transfer again to resume where it stopped.' : '',
      };
    default:
      return {
        tone: 'danger',
        message:
          result.error?.message ??
          `${plural(result.failed.length, 'file')} failed${result.files > 0 ? `, ${files} done` : ''}`,
        detail: result.error?.hint ?? result.failed[0]?.message ?? '',
      };
  }
}
