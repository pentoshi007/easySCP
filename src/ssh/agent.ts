export const WINDOWS_OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

export function agentSockets(): string[] {
  const fromEnv = process.env.SSH_AUTH_SOCK;
  if (fromEnv) return [fromEnv];
  if (process.platform === 'win32') return [WINDOWS_OPENSSH_PIPE, 'pageant'];
  return [];
}
