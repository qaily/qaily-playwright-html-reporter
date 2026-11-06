// Rollups on this device, for reports that read their data from a bucket. A signed link changes every time, so the
// browser's own HTTP cache never hits. Holds private data: it is only used while credentials are remembered on the device.
// Every failure counts as a miss: the cache only saves downloads.

const CACHE = 'qaily-rollups-v1';

const open = (): Promise<Cache> | null => (typeof caches === 'undefined' ? null : caches.open(CACHE));
const keyOf = (path: string, hash: string) => `${globalThis.location?.origin}/__qaily-rollups/${path}?v=${hash}`;

export async function readCachedRollup(path: string, hash: string): Promise<Uint8Array | null> {
  try {
    const hit = await (await open())?.match(keyOf(path, hash));
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function writeCachedRollup(path: string, hash: string, bytes: Uint8Array): Promise<void> {
  try {
    await (await open())?.put(keyOf(path, hash), new Response(bytes.slice() as BlobPart));
  } catch {
    // Full or blocked storage just means downloading again next time.
  }
}

/** Removes everything except these files, as `path@hash`. A rebuilt month gets a new hash and leaves its old files behind. */
export async function pruneCachedRollups(keep: { path: string; hash: string }[]): Promise<void> {
  try {
    const cache = await open();
    if (!cache) return;
    const wanted = new Set(keep.map((k) => keyOf(k.path, k.hash)));
    for (const req of await cache.keys()) {
      if (!wanted.has(req.url)) await cache.delete(req);
    }
  } catch {
    // Old entries stay until the next try.
  }
}

export async function clearCachedRollups(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE);
  } catch {
    // Nothing more can be done from a page.
  }
}
