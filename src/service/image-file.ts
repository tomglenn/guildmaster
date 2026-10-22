import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Open an already canonical absolute path without following replacement symlinks. */
export async function openImageWithoutSymlinks(path: string) {
  if (process.platform === 'darwin') {
    // Darwin sys/fcntl.h: O_NOFOLLOW_ANY rejects symlinks in all components.
    return open(path, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  }
  if (process.platform !== 'linux') throw new Error('Secure image file references are unavailable on this platform. Use a conversation attachment.');
  const parts = path.split('/').filter(Boolean);
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    return await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } finally { await directory.close(); }
}
