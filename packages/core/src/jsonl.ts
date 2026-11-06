/** True when the bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function parseJsonl<T>(text: string): T[] {
  const rows: T[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as T);
    } catch {
      // A truncated line must not hide the rest of the file.
    }
  }
  return rows;
}

/**
 * Fetches a .jsonl or .jsonl.gz file. Some hosts serve .gz with Content-Encoding (already
 * decompressed by the browser), others as raw bytes, so the magic number decides. A missing
 * file (404) is an empty list: older runs may not have every file.
 */
export async function fetchJsonl<T>(url: string): Promise<T[]> {
  return readJsonl<T>(await fetch(url), url);
}

/** Reads a response as JSONL. The label names the file in errors, so a signed URL never reaches the screen. */
export async function readJsonl<T>(res: Response, label: string): Promise<T[]> {
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Could not load ${label} (${res.status})`);
  if ((res.headers.get('content-type') ?? '').includes('text/html')) return [];
  let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
  if (isGzip(bytes)) bytes = await gunzip(bytes);
  return parseJsonl<T>(new TextDecoder().decode(bytes));
}
