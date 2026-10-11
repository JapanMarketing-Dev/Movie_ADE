// Reads a response body up to a byte limit. res.json() / arrayBuffer() buffer everything, so a hijacked or broken
// origin returning a huge body would exhaust memory; a timeout alone does not bound bytes.
// Ported from Ferret src/main/boundedResponse.ts (MIT), without the i18n error text.
// - a declared Content-Length over the limit is refused before reading
// - an actual body that grows past the limit (chunked, no length) stops there and the connection is cancelled

/** the response was larger than allowed (the origin's fault, not an app bug) */
export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`response larger than ${limitBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

function declaredLength(res: Pick<Response, 'headers'>): number | undefined {
  const raw = res.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Reads at most maxBytes. Throws ResponseTooLargeError past the limit unless truncate is set (then cuts there). */
export async function readBoundedBytes(res: Response, maxBytes: number, options: { truncate?: boolean } = {}): Promise<Buffer> {
  const declared = declaredLength(res);
  if (declared !== undefined && declared > maxBytes && !options.truncate) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        if (!options.truncate) throw new ResponseTooLargeError(maxBytes);
        chunks.push(Buffer.from(value.buffer, value.byteOffset, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
  } finally {
    // stop the transfer when we quit early (a no-op after a complete read)
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  return (await readBoundedBytes(res, maxBytes)).toString('utf8');
}

/** JSON within the limit; SyntaxError when it is not JSON (like res.json()) */
export async function readBoundedJson(res: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBoundedText(res, maxBytes)) as unknown;
}
