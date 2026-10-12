import type { AnyAuthMethod, AuthenticationType, AuthHandlerMiddleware, Prompt } from 'ssh2';
import { AppError, CancelledError } from '../core/errors.js';
import { type Host, hostLabel } from '../core/hosts.js';
import { collapseHome, expandHome } from '../core/paths.js';
import { getSecret, type SecretKind, setSecret } from '../core/secrets.js';
import { agentSockets } from './agent.js';
import type { SecretQuestion } from './interaction.js';
import { defaultIdentityFiles, loadPrivateKey } from './keys.js';

type Method = 'publickey' | 'password' | 'keyboard-interactive';

interface Step {
  method: Method;
  next(): Promise<AnyAuthMethod | undefined>;
}

export interface AuthOptions {
  host: Host;
  ask: (question: Omit<SecretQuestion, 'host'>) => Promise<string | undefined>;
  onStatus: (message: string) => void;
}

const MAX_PASSWORD_PROMPTS = 3;

export class Authenticator {
  readonly handler: AuthHandlerMiddleware;
  private readonly host: Host;
  private readonly steps: Step[];
  private readonly notes: string[] = [];
  private readonly updates = new Map<SecretKind, string>();
  private index = 0;
  private methods: AuthenticationType[] = [];
  private passwordPrompts = 0;
  private storedPassword: Promise<string | undefined> | undefined;
  private storedPasswordUsed = false;
  private fallbackAdded = false;
  private fatal: Error | undefined;
  exhausted = false;

  constructor(private readonly options: AuthOptions) {
    this.host = options.host;
    this.steps = this.plan();
    this.handler = (methodsLeft, partialSuccess, next) => {
      const proceed = next as (method: AnyAuthMethod | false) => void;
      if (methodsLeft === null) {
        proceed({ type: 'none', username: this.host.user });
        return;
      }
      this.methods = methodsLeft;
      if (partialSuccess && !this.fallbackAdded) {
        this.fallbackAdded = true;
        this.steps.push(this.passwordStep(), this.keyboardStep());
      }
      this.advance().then(
        (method) => proceed(method ?? this.giveUp()),
        (error: Error) => {
          this.fatal = error;
          proceed(this.giveUp());
        },
      );
    };
  }

  note(message: string): void {
    if (!this.notes.includes(message)) this.notes.push(message);
  }

  failure(): Error {
    if (this.fatal) return this.fatal;
    const allowed = this.methods.filter((method) => method !== 'none');
    const details = allowed.length ? ` (${allowed.join(', ')})` : '';
    return new AppError(`Permission denied for ${hostLabel(this.host)}${details}`, this.hint());
  }

  async commit(): Promise<void> {
    await Promise.all(
      [...this.updates].map(([kind, value]) =>
        setSecret(this.host.id, kind, value).catch(() => undefined),
      ),
    );
  }

  private giveUp(): false {
    this.exhausted = true;
    return false;
  }

  private hint(): string {
    const lines = [...this.notes];
    const allowed = this.methods;
    if (this.host.auth === 'password' && !allowed.includes('password')) {
      if (!allowed.includes('keyboard-interactive')) {
        lines.push('This server does not accept passwords; use a key instead.');
      }
    } else if (this.host.auth === 'agent') {
      lines.push('Make sure your key is loaded in the agent (ssh-add -l).');
    } else if (this.host.auth === 'key') {
      lines.push('Is the matching public key in ~/.ssh/authorized_keys on the server?');
    } else if (this.host.auth === 'password') {
      lines.push('Double-check the username and password.');
    }
    lines.push(`Run \`easyscp edit ${this.host.name}\` to change how you log in.`);
    return lines.join('\n');
  }

  private async advance(): Promise<AnyAuthMethod | undefined> {
    while (this.index < this.steps.length) {
      const step = this.steps[this.index] as Step;
      if (this.methods.includes(step.method)) {
        const method = await step.next();
        if (method) return method;
      }
      this.index++;
    }
    return undefined;
  }

  private plan(): Step[] {
    const { auth, identityFile } = this.host;
    const explicitKey = identityFile ? [this.keyStep(identityFile, true)] : [];
    switch (auth) {
      case 'agent':
        return this.agentSteps(true);
      case 'key':
        if (!identityFile) {
          this.note('No identity file is configured for this host.');
          return [];
        }
        return explicitKey;
      case 'password':
        return [this.passwordStep(), this.keyboardStep()];
      default:
        return [
          ...explicitKey,
          ...this.agentSteps(false),
          ...defaultIdentityFiles()
            .filter((file) => !identityFile || expandHome(identityFile) !== file)
            .map((file) => this.keyStep(file, false)),
          this.passwordStep(),
          this.keyboardStep(),
        ];
    }
  }

  private agentSteps(required: boolean): Step[] {
    const sockets = agentSockets();
    if (sockets.length === 0 && required) {
      this.note('No SSH agent found (SSH_AUTH_SOCK is not set).');
    }
    return sockets.map((agent) => {
      let used = false;
      return {
        method: 'publickey',
        next: async () => {
          if (used) return undefined;
          used = true;
          this.options.onStatus('Trying SSH agent keys');
          return { type: 'agent', username: this.host.user, agent };
        },
      };
    });
  }

  private keyStep(file: string, explicit: boolean): Step {
    let used = false;
    const label = collapseHome(expandHome(file));
    return {
      method: 'publickey',
      next: async () => {
        if (used) return undefined;
        used = true;
        let result = await loadPrivateKey(file);
        if (result.status === 'missing') {
          if (explicit) this.note(`Identity file not found: ${label}`);
          return undefined;
        }
        if (result.status === 'invalid') {
          this.note(`Could not use ${label}: ${result.message}`);
          return undefined;
        }
        if (result.status === 'encrypted') {
          const stored = explicit ? await getSecret(this.host.id, 'passphrase') : undefined;
          if (stored) result = await loadPrivateKey(file, stored);
          for (
            let attempt = 0;
            result.status !== 'ok' && attempt < MAX_PASSWORD_PROMPTS;
            attempt++
          ) {
            const passphrase = await this.options.ask({
              kind: 'passphrase',
              message: `Passphrase for ${label}`,
              retry: attempt > 0 || stored !== undefined,
              echo: false,
            });
            if (passphrase === undefined) return undefined;
            result = await loadPrivateKey(file, passphrase);
            if (result.status === 'ok' && explicit && stored !== undefined) {
              this.updates.set('passphrase', passphrase);
            }
          }
          if (result.status !== 'ok') {
            this.note(`Wrong passphrase for ${label}`);
            return undefined;
          }
        }
        if (result.status !== 'ok') return undefined;
        this.options.onStatus(`Trying key ${label}`);
        return { type: 'publickey', username: this.host.user, key: result.key };
      },
    };
  }

  private savedPassword(): Promise<string | undefined> {
    this.storedPassword ??= getSecret(this.host.id, 'password');
    return this.storedPassword;
  }

  private async nextPassword(instructions?: string): Promise<string | undefined> {
    const stored = await this.savedPassword();
    if (stored !== undefined && !this.storedPasswordUsed) {
      this.storedPasswordUsed = true;
      this.options.onStatus('Logging in with saved password');
      return stored;
    }
    if (this.passwordPrompts >= MAX_PASSWORD_PROMPTS) return undefined;
    const retry = this.passwordPrompts > 0 || this.storedPasswordUsed;
    this.passwordPrompts++;
    const password = await this.options.ask({
      kind: 'password',
      message: `Password for ${hostLabel(this.host)}`,
      instructions,
      retry,
      echo: false,
    });
    if (password === undefined) throw new CancelledError();
    if (this.storedPasswordUsed) this.updates.set('password', password);
    return password;
  }

  private passwordStep(): Step {
    return {
      method: 'password',
      next: async () => {
        const password = await this.nextPassword();
        if (password === undefined) return undefined;
        return { type: 'password', username: this.host.user, password };
      },
    };
  }

  private keyboardStep(): Step {
    let rounds = 0;
    return {
      method: 'keyboard-interactive',
      next: async () => {
        if (rounds > MAX_PASSWORD_PROMPTS || this.passwordPrompts >= MAX_PASSWORD_PROMPTS) {
          return undefined;
        }
        rounds++;
        return {
          type: 'keyboard-interactive',
          username: this.host.user,
          prompt: (name, instructions, _lang, prompts, finish) => {
            this.answerPrompts(name, instructions, prompts).then(finish, (error: Error) => {
              this.fatal = error;
              finish([]);
            });
          },
        };
      },
    };
  }

  private async answerPrompts(name: string, instructions: string, prompts: Prompt[]) {
    if (prompts.length === 0) return [];
    const context = [name, instructions].filter(Boolean).join('\n') || undefined;
    const [single] = prompts;
    if (
      prompts.length === 1 &&
      single &&
      !single.echo &&
      /pass(word|code|phrase)?\b/i.test(single.prompt)
    ) {
      return [(await this.nextPassword(context)) ?? ''];
    }
    const answers: string[] = [];
    for (const prompt of prompts) {
      const answer = await this.options.ask({
        kind: 'challenge',
        message: prompt.prompt.trim().replace(/:$/, '') || 'Response',
        instructions: context,
        retry: false,
        echo: prompt.echo === true,
      });
      if (answer === undefined) throw new CancelledError();
      answers.push(answer);
    }
    return answers;
  }
}
