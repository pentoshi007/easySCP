import type { PlatformPath } from 'node:path';

export type EntryKind = 'file' | 'dir' | 'other';

export interface Entry {
  name: string;
  path: string;
  kind: EntryKind;
  link: boolean;
  size: number;
  mtime: number;
  mode: number;
}

export interface ScanEntry {
  name: string;
  dir: boolean;
}

export interface Attributes {
  mode?: number;
  mtime?: number;
}

export interface Reader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}

export interface Writer {
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<void>;
  finish(attributes: Attributes): Promise<void>;
  close(): Promise<void>;
}

export interface FileSystem {
  readonly local: boolean;
  readonly label: string;
  readonly path: PlatformPath;
  readonly home: string;
  readonly chunkSize: number;
  readonly parallelChunks: number;
  roots(): Promise<string[]>;
  stat(target: string): Promise<Entry | undefined>;
  list(dir: string): Promise<Entry[]>;
  scan(dir: string): Promise<ScanEntry[]>;
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  removeFile(target: string): Promise<void>;
  removeDir(target: string): Promise<void>;
  openRead(file: string): Promise<Reader>;
  openWrite(file: string, append: boolean): Promise<Writer>;
}
