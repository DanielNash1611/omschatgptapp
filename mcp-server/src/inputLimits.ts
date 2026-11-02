import type { IncomingMessage } from "node:http";
// Mock OMS tools accept a few short order/confirmation fields.
export const INPUT_LIMITS = { bytes: 8192, elements: 64, string: 1024, depth: 8 } as const;

export class InputLimitError extends Error {
  constructor(message: string, readonly status = 413) { super(message); }
}

// Run before recursive SDK/Zod validation, including for unknown fields.
export function assertInputBudget(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let elements = 0;
  while (pending.length) {
    const { value: item, depth } = pending.pop()!;
    if (depth > INPUT_LIMITS.depth) throw new InputLimitError("JSON nesting exceeds the input limit.");
    if (typeof item === "string" && item.length > INPUT_LIMITS.string) throw new InputLimitError("JSON string exceeds the input limit.");
    if (item === null || typeof item !== "object") continue;
    const keys = Object.keys(item);
    elements += keys.length;
    if (elements > INPUT_LIMITS.elements) throw new InputLimitError("JSON elements exceed the input limit.");
    for (const key of keys) {
      if (key.length > INPUT_LIMITS.string) throw new InputLimitError("JSON key exceeds the input limit.");
      pending.push({ value: (item as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
}

export async function readLimitedJson(req: IncomingMessage): Promise<unknown> {
  const encoding = req.headers["content-encoding"];
  if (encoding && encoding !== "identity") throw new InputLimitError("Compressed request bodies are not supported.", 415);
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new InputLimitError("Content-Type must be application/json.", 415);
  const length = req.headers["content-length"];
  if (length !== undefined && !/^\d+$/.test(length)) throw new InputLimitError("Invalid Content-Length.", 400);
  if (length !== undefined && Number(length) > INPUT_LIMITS.bytes) throw new InputLimitError("Request body exceeds the input limit.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Do not destroy the socket on a limit error: return a clear JSON 413.
  const iterator = req.iterator({ destroyOnReturn: false });
  try {
    for await (const chunk of iterator) {
      bytes += chunk.length;
      if (bytes > INPUT_LIMITS.bytes) throw new InputLimitError("Request body exceeds the input limit.");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    req.resume();
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new InputLimitError("Invalid JSON body.", 400); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputLimitError("JSON body must be an object.", 400);
  assertInputBudget(parsed);
  return parsed;
}
