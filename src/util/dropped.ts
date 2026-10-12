export function parseDroppedPaths(text: string, windows = process.platform === 'win32'): string[] {
  const input = text.trim();
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && !windows && index + 1 < input.length) {
        current += input[++index];
      } else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && !windows && index + 1 < input.length) {
      current += input[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens.map((token) => fromFileUri(token)).filter((token) => token.length > 0);
}

function fromFileUri(token: string): string {
  if (!token.startsWith('file://')) return token;
  try {
    const { pathname, host } = new URL(token);
    const decoded = decodeURIComponent(pathname);
    if (/^\/[A-Za-z]:/.test(decoded)) return decoded.slice(1).replace(/\//g, '\\');
    return host ? `//${host}${decoded}` : decoded;
  } catch {
    return token;
  }
}
