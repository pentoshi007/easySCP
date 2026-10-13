import { Box, Text } from 'ink';
import { AppError, CancelledError, InterruptedError } from '../core/errors.js';
import { hostLabel } from '../core/hosts.js';
import type { HostKeyQuestion, Interaction, SecretQuestion } from '../ssh/interaction.js';
import { Spinner } from '../ui/components/Spinner.js';
import { ConfirmPrompt } from '../ui/prompts/ConfirmPrompt.js';
import { colors, symbols } from '../ui/theme.js';
import type { TaskHandle, Ui } from '../ui/ui.js';

function keyLabel(type: string): string {
  const name = type.replace(/^ssh-/, '').replace(/^ecdsa-sha2-/, 'ecdsa-');
  return name.toUpperCase();
}

export class UiInteraction implements Interaction {
  private task: TaskHandle | undefined;
  private label = '';
  private active = false;
  private fixed = false;

  constructor(
    private readonly ui: Ui,
    private readonly options: { acceptNewHostKeys: boolean },
  ) {}

  begin(label: string, options: { fixed?: boolean } = {}): void {
    this.active = true;
    this.fixed = options.fixed === true;
    this.label = label;
    this.show();
  }

  end(): void {
    this.active = false;
    this.hide();
  }

  status(message: string): void {
    if (this.fixed) return;
    this.label = message;
    if (this.task) this.task.update(this.view());
  }

  async confirmHostKey(question: HostKeyQuestion): Promise<boolean> {
    const { key, status, address, host } = question;
    if (status === 'unknown' && this.options.acceptNewHostKeys) return true;
    if (!this.ui.interactive) {
      throw new AppError(
        status === 'changed'
          ? `The host key for ${address} has changed`
          : `${address} is not a trusted machine yet`,
        status === 'changed'
          ? 'Refusing to connect. Verify the new fingerprint and connect once interactively.'
          : 'Connect once in a terminal to trust it, or pass --yes.',
      );
    }
    const changed = status === 'changed';
    return this.paused(() =>
      this.ui.prompt<boolean>({
        title: changed ? (
          <Text color={colors.danger} bold>
            The identity of {host.name} has changed
          </Text>
        ) : (
          `First connection to ${host.name}`
        ),
        subtitle: changed ? undefined : address,
        body: (controls) => (
          <>
            {changed ? (
              <Box flexDirection="column">
                <Text color={colors.danger}>
                  {symbols.warning} This could mean someone is intercepting your connection.
                </Text>
                <Text color={colors.muted}>
                  It can also happen after the server was reinstalled. Only continue if you trust
                  this new fingerprint.
                </Text>
              </Box>
            ) : (
              <Text color={colors.muted}>
                easyscp can't confirm this machine's identity yet. Check the fingerprint if you can.
              </Text>
            )}
            <Text> </Text>
            <Text>
              <Text color={colors.muted}>{keyLabel(key.type)} </Text>
              <Text bold>{key.fingerprint}</Text>
            </Text>
            <Text> </Text>
            <ConfirmPrompt
              controls={controls}
              options={{
                initial: !changed,
                yes: changed ? 'Trust the new key' : 'Trust and connect',
                no: 'Cancel',
                danger: changed,
              }}
            />
          </>
        ),
        summary: (trusted) => (trusted ? `Trusted ${key.fingerprint}` : 'Not trusted'),
      }),
    );
  }

  async askSecret(question: SecretQuestion): Promise<string | undefined> {
    const { host, kind, message, retry, echo, instructions } = question;
    if (!this.ui.interactive) {
      if (kind === 'passphrase') return undefined;
      throw new AppError(
        `${hostLabel(host)} asked for a ${kind === 'password' ? 'password' : 'response'}`,
        `Run in a terminal, or save the password with \`easyscp edit ${host.name}\`.`,
      );
    }
    const error = retry
      ? kind === 'passphrase'
        ? 'Wrong passphrase, try again'
        : 'That didn’t work, try again'
      : undefined;
    try {
      return await this.paused(() =>
        echo
          ? this.ui.text(message, { error, hint: instructions })
          : this.ui.password(message, {
              error,
              hint:
                instructions ?? (kind === 'passphrase' ? 'Press esc to skip this key' : undefined),
            }),
      );
    } catch (failure) {
      if (failure instanceof InterruptedError) throw failure;
      if (failure instanceof CancelledError) return undefined;
      throw failure;
    }
  }

  private async paused<T>(work: () => Promise<T>): Promise<T> {
    this.hide();
    try {
      return await work();
    } finally {
      if (this.active) this.show();
    }
  }

  private view() {
    return (
      <Text>
        <Spinner />
        {'  '}
        {this.label}
        <Text color={colors.muted}>{symbols.ellipsis}</Text>
      </Text>
    );
  }

  private show(): void {
    if (this.task) return;
    this.task = this.ui.task(this.view());
  }

  private hide(): void {
    this.task?.close();
    this.task = undefined;
  }
}
