import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { AppError } from '../domain/types.ts';

export interface FolderListing {
  path: string;
  parentPath: string | null;
  homePath: string;
  directories: { name: string; path: string; isRepository: boolean }[];
  isRepository: boolean;
  truncated: boolean;
}

const compareNames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

async function isRepository(path: string): Promise<boolean> {
  try { const marker = await stat(join(path, '.git')); return marker.isDirectory() || marker.isFile(); }
  catch { return false; }
}

/** Read folder names only. Selecting or browsing a folder does not register or change it. */
export async function browseFolders(input: { path?: unknown; hidden?: boolean }, home = homedir()): Promise<FolderListing> {
  const value = input.path === undefined ? home : input.path;
  if (typeof value !== 'string' || !value || value.length > 4000 || value.includes('\0')) throw new AppError('Choose an absolute folder path.');
  const candidate = value.replace(/^~(?=\/|$)/, home);
  if (!isAbsolute(candidate)) throw new AppError('Choose an absolute folder path, or start it with ~/ for your home folder.');
  try {
    const path = await realpath(candidate);
    if (!(await stat(path)).isDirectory()) throw new AppError('The selected path is not a folder.');
    await access(path, constants.R_OK | constants.X_OK);
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter(entry => (input.hidden || !entry.name.startsWith('.')) && (entry.isDirectory() || entry.isSymbolicLink()))
      .sort((a, b) => compareNames(a.name, b.name) || a.name.localeCompare(b.name));
    const directories: FolderListing['directories'] = [];
    let truncated = false;
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      try {
        if (entry.isSymbolicLink() && !(await stat(childPath)).isDirectory()) continue;
        await access(childPath, constants.R_OK | constants.X_OK);
        if (directories.length === 1000) { truncated = true; break; }
        directories.push({ name: entry.name, path: childPath, isRepository: await isRepository(childPath) });
      } catch { /* Inaccessible, broken, or removed entries are not selectable. */ }
    }
    const parent = dirname(path);
    return {
      path, parentPath: parent === path ? null : parent,
      homePath: await realpath(home).catch(() => resolve(home)), directories,
      isRepository: await isRepository(path), truncated,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new AppError('This folder cannot be read. Check its permissions.', 403);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('This folder does not exist. Choose another folder.');
    throw new AppError('This folder could not be opened. Check the path and try again.');
  }
}
