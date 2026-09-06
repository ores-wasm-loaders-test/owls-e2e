// The pinned --pwa-strategy=none build emits a zero-byte disabled SW placeholder.
// Remove only that known inactive file from our downloaded fixture staging area.
// This does not relax the release contract or remove an active service worker.
import {stat, unlink} from 'node:fs/promises';
const path = new URL('./inputs/flutter/flutter_service_worker.js', import.meta.url);
try {
  const info = await stat(path);
  if (info.size !== 0) throw new Error('Unexpected active service worker in the no-PWA fixture');
  await unlink(path);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
