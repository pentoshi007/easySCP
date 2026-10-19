import { AppError } from '../core/errors.js';
import type { Entry, FileSystem } from '../fs/types.js';

export async function renameEntry(fs: FileSystem, entry: Entry, name: string): Promise<string> {
  const dir = fs.path.dirname(entry.path);
  const target = fs.path.join(dir, name.trim());
  if (target === entry.path) return target;
  if (target.toLowerCase() !== entry.path.toLowerCase()) {
    if (await fs.stat(target)) throw new AppError(`${name.trim()} already exists`);
    await fs.rename(entry.path, target);
    return target;
  }
  const step = fs.path.join(dir, `.${entry.name}.easyscp-rename`);
  await fs.rename(entry.path, step);
  await fs.rename(step, target);
  return target;
}
