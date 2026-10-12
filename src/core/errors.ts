export class AppError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.hint = hint;
  }
}

export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export class InterruptedError extends CancelledError {
  constructor() {
    super('Interrupted');
    this.name = 'InterruptedError';
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError');
}

export interface ErrorReport {
  message: string;
  hint?: string;
}

const ERRNO: Record<string, ErrorReport> = {
  ENOTFOUND: {
    message: 'Host could not be resolved',
    hint: 'Check the hostname or your DNS / VPN connection.',
  },
  EAI_AGAIN: { message: 'DNS lookup timed out', hint: 'Check your network connection.' },
  ECONNREFUSED: {
    message: 'Connection refused',
    hint: 'Is the SSH server running and is the port correct?',
  },
  ECONNRESET: {
    message: 'Connection was reset',
    hint: 'The server or a firewall dropped the connection.',
  },
  ETIMEDOUT: {
    message: 'Connection timed out',
    hint: 'The host may be offline or blocked by a firewall.',
  },
  EHOSTUNREACH: { message: 'Host is unreachable', hint: 'Check your network route or VPN.' },
  ENETUNREACH: { message: 'Network is unreachable', hint: 'Check your internet connection.' },
  ENOSPC: { message: 'No space left on device', hint: 'Free up some disk space and retry.' },
  EACCES: { message: 'Permission denied' },
  EPERM: { message: 'Operation not permitted' },
  ENOENT: { message: 'No such file or directory' },
  EEXIST: { message: 'Already exists' },
  EISDIR: { message: 'Is a directory' },
  ENOTDIR: { message: 'Not a directory' },
  ENOTEMPTY: { message: 'Directory is not empty' },
};

export function describeError(error: unknown): ErrorReport {
  if (error instanceof AppError) return { message: error.message, hint: error.hint };
  if (!(error instanceof Error)) return { message: String(error) };

  const { code, path } = error as NodeJS.ErrnoException;
  const known = typeof code === 'string' ? ERRNO[code] : undefined;
  if (known) return { ...known, message: path ? `${known.message}: ${path}` : known.message };

  const level = (error as { level?: string }).level;
  if (level === 'client-authentication') {
    return {
      message: 'Authentication failed',
      hint: 'Check the username, key or password with `easyscp edit`.',
    };
  }
  if (level === 'client-timeout') {
    return { message: 'Timed out while connecting', hint: 'The host may be slow or unreachable.' };
  }
  if (/handshake/i.test(error.message)) {
    return {
      message: `SSH handshake failed: ${error.message}`,
      hint: 'The server may not support any of the offered algorithms.',
    };
  }
  return { message: error.message };
}
