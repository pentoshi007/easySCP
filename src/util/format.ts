const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(Math.round(bytesPerSecond))}/s` : '—';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function formatDate(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = `${MONTHS[date.getMonth()]} ${pad(date.getDate())}`;
  return sameYear ? `${day} ${time}` : `${day}  ${date.getFullYear()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMode(mode: number, isDirectory: boolean): string {
  const bits = ['r', 'w', 'x'];
  let out = isDirectory ? 'd' : '-';
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let index = 0; index < 3; index++) {
      out += mode & (1 << (shift + 2 - index)) ? bits[index] : '-';
    }
  }
  return out;
}

export function joinNames(names: string[], limit = 4): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > limit)
    return `${names.slice(0, limit - 1).join(', ')} and ${names.length - limit + 1} more`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function printable(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    out += code < 32 || (code >= 127 && code < 160) ? '?' : char;
  }
  return out;
}

export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keepEnd = Math.ceil((max - 1) * 0.6);
  const keepStart = max - 1 - keepEnd;
  return `${text.slice(0, keepStart)}…${text.slice(text.length - keepEnd)}`;
}

export function truncateEnd(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return max <= 1 ? '…' : `${text.slice(0, max - 1)}…`;
}
