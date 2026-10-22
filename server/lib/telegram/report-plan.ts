import { createHash } from "node:crypto";

export const REPORT_MAX_INPUT_UNITS = 131_072;
export const REPORT_MAX_CHUNKS = 64;

/** Prepare a plain-text plan only. No configuration, persistence or network calls. */
export function planReport(text: string, maxChunkLength = 4000) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Report text must contain non-whitespace text");
  if (text.length > REPORT_MAX_INPUT_UNITS) throw new Error("Report exceeds the 131072 UTF-16 unit input limit");
  if (!Number.isSafeInteger(maxChunkLength) || maxChunkLength < 1 || maxChunkLength > 4096) throw new Error("Chunk length must be an integer between 1 and 4096");
  if (!text.isWellFormed()) throw new Error("Report contains an unpaired UTF-16 surrogate");
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  const boundaries = [0];
  for (const part of segmenter.segment(text)) {
    if (part.segment.length > maxChunkLength) throw new Error("A single grapheme exceeds the selected chunk length; use a larger limit or simplify the text");
    boundaries.push(part.index + part.segment.length);
  }
  const parts: string[] = [];
  let start = 0;
  let cursor = 1;
  while (start < text.length) {
    const bound = Math.min(start + maxChunkLength, text.length);
    let end = start;
    let newlineEnd = start;
    const first = cursor;
    while (cursor < boundaries.length && boundaries[cursor] <= bound) {
      end = boundaries[cursor++];
      if (text[end - 1] === "\n" && end - start >= Math.floor(maxChunkLength / 2)) newlineEnd = end;
    }
    if (end < text.length && newlineEnd > start) {
      end = newlineEnd;
      // Boundaries already visited past the chosen newline belong to the next chunk.
      cursor = first;
      while (boundaries[cursor] <= end) cursor++;
    }
    if (end === start) throw new Error("Unable to split report safely");
    parts.push(text.slice(start, end));
    if (parts.length > REPORT_MAX_CHUNKS) throw new Error("Report would require more than 64 messages; choose a larger chunk length");
    start = end;
  }
  // If the final blank tail fell on its own, move a suffix from the previous
  // message without breaking a grapheme or changing content. Reject other
  // unsendable whitespace chunks instead of silently dropping input.
  for (let index = 0; index < parts.length; index++) {
    if (parts[index].trim()) continue;
    if (index === parts.length - 1 && index > 0) {
      const previous = parts[index - 1];
      const blank = parts[index];
      if (previous.length + blank.length <= maxChunkLength) {
        parts[index - 1] += blank;
        parts.splice(index, 1);
        break;
      }
      const cuts = Array.from(segmenter.segment(previous), value => value.index).reverse();
      const cut = cuts.find(value => previous.slice(0, value).trim() && previous.slice(value).trim() && previous.length - value + blank.length <= maxChunkLength);
      if (cut !== undefined) {
        parts[index - 1] = previous.slice(0, cut);
        parts[index] = previous.slice(cut) + blank;
        continue;
      }
    }
    throw new Error("Selected chunk length produces a whitespace-only message; use a larger limit or shorten blank sections");
  }
  return {
    format: "plain_text" as const,
    plan_sha256: createHash("sha256").update(JSON.stringify({ format: "plain_text", max_chunk_length: maxChunkLength, text })).digest("hex"),
    chunk_count: parts.length,
    total_utf16_units: text.length,
    max_chunk_length: maxChunkLength,
    chunks: parts.map((part, index) => ({ index: index + 1, text: part, utf16_units: part.length })),
    sent: false,
    note: "Preparation only. The hash is a content fingerprint, not a delivery receipt or a durable deduplication guarantee. Send approved chunks in order with parse_mode omitted; never retry an uncertain send automatically.",
  };
}
