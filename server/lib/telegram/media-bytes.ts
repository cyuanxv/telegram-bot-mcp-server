export const MEDIA_BYTE_METHODS = ["sendPhoto", "sendAudio", "sendDocument", "sendVideo", "sendAnimation", "sendVoice", "sendVideoNote", "sendSticker", "sendMediaGroup"] as const;
export type MediaByteMethod = typeof MEDIA_BYTE_METHODS[number];
export type ByteAttachment = { field_name: string; filename: string; content_type?: string; base64: string };
export const MAX_UPLOAD_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 4;
export const MAX_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_FILE_BYTES / 3) * 4;
const fields: Record<string, string> = { sendPhoto: "photo", sendAudio: "audio", sendDocument: "document", sendVideo: "video", sendAnimation: "animation", sendVoice: "voice", sendVideoNote: "video_note", sendSticker: "sticker" };
const namePattern = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
function attachmentReference(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("attach://")) return undefined;
  const name = value.slice(9); if (!namePattern.test(name)) throw new Error("Invalid attachment reference"); return name;
}
/** Pure bounded construction: no file reads, URLs, credentials, persistence or network requests. */
export function buildMediaMultipart(method: string, params: Record<string, unknown>, attachments: ByteAttachment[]) {
  if (!MEDIA_BYTE_METHODS.includes(method as MediaByteMethod)) throw new Error("Unsupported byte-upload method");
  if (!params || typeof params !== "object" || Array.isArray(params) || ![Object.prototype, null].includes(Object.getPrototypeOf(params))) throw new Error("Media parameters must be a plain object");
  if (Object.hasOwn(params, "business_connection_id")) throw new Error("Business media uploads require a separately scoped workflow");
  if (typeof params.chat_id !== "string" || !/^-?[1-9][0-9]{0,19}$/.test(params.chat_id)) throw new Error("An exact decimal chat ID is required");
  if (BigInt(params.chat_id) < -(1n << 63n) || BigInt(params.chat_id) > (1n << 63n) - 1n) throw new Error("Chat ID exceeds signed 64-bit range");
  if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > MAX_UPLOAD_FILES) throw new Error("Provide one to four byte attachments");
  const references = new Set<string>(); let nodes = 0, stringBytes = 0;
  function walk(value: unknown, key = "", depth = 0) {
    if (++nodes > 2048 || depth > 12) throw new Error("Media parameter structure exceeds its budget");
    if (typeof value === "string") {
      if (!value.isWellFormed()) throw new Error("Malformed parameter text");
      stringBytes += Buffer.byteLength(value); if (stringBytes > 65536) throw new Error("Media parameters exceed 64 KiB");
      return;
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("Unsafe numeric media parameter; use an exact string for large IDs");
      return;
    }
    if (Array.isArray(value)) { for (const item of value) walk(item, key, depth + 1); return; }
    if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      for (const [k, v] of Object.entries(value)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) || ["constructor", "prototype"].includes(k)) throw new Error("Unsupported media parameter key");
        stringBytes += k.length; walk(v, k, depth + 1);
      }
      return;
    }
    throw new Error("Media parameters must contain JSON values only");
  }
  walk(params);
  if (Buffer.byteLength(JSON.stringify(params)) > 65536) throw new Error("Media parameters exceed 64 KiB");
  function useBytes(value: unknown) {
    const reference = attachmentReference(value);
    if (!reference) throw new Error("Supported media fields must reference supplied bytes; URLs and file IDs use the legacy workflow");
    references.add(reference);
  }
  function optionalBytes(item: Record<string, unknown>, keys: string[]) {
    for (const key of keys) if (item[key] !== undefined) useBytes(item[key]);
  }
  if (method === "sendMediaGroup") {
    const media = params.media;
    if (!Array.isArray(media) || media.length < 2 || media.length > 10) throw new Error("A media group requires two to ten items");
    const types = new Set<string>();
    for (const item of media) {
      if (!item || typeof item !== "object" || !["photo", "video", "audio", "document"].includes(item.type) || typeof item.media !== "string" || !item.media) throw new Error("Unsupported media group item");
      types.add(item.type); useBytes(item.media);
      if (["video", "audio", "document"].includes(item.type)) optionalBytes(item, ["thumbnail"]);
      if (item.type === "video") optionalBytes(item, ["cover"]);
    }
    if ((types.has("audio") || types.has("document")) && types.size !== 1) throw new Error("Audio and document albums cannot mix media types");
  } else {
    useBytes(params[fields[method]]);
    if (["sendAudio", "sendDocument", "sendVideo", "sendAnimation", "sendVideoNote"].includes(method)) optionalBytes(params, ["thumbnail"]);
    if (method === "sendVideo") optionalBytes(params, ["cover"]);
  }
  const names = new Set<string>(); let totalBytes = 0;
  const decoded: { input: ByteAttachment; bytes: Uint8Array }[] = [];
  for (const input of attachments) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["field_name", "filename", "content_type", "base64"].includes(k))) throw new Error("Invalid byte attachment");
    if (typeof input.field_name !== "string" || !namePattern.test(input.field_name) || names.has(input.field_name) || Object.hasOwn(params, input.field_name) || ["method", "chat_id", "business_connection_id", "constructor", "prototype"].includes(input.field_name)) throw new Error("Attachment field collision or invalid name");
    names.add(input.field_name);
    if (typeof input.filename !== "string" || !input.filename.trim() || input.filename.length > 128 || !input.filename.isWellFormed()
      || [".", ".."].includes(input.filename) || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(input.filename)) throw new Error("Unsafe attachment filename");
    const contentType = input.content_type ?? "application/octet-stream";
    if (typeof contentType !== "string" || contentType.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(contentType)) throw new Error("Invalid attachment content type");
    if (typeof input.base64 !== "string" || input.base64.length < 4 || input.base64.length > MAX_BASE64_LENGTH || input.base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new Error("Attachment must be bounded canonical base64");
    const estimated = input.base64.length / 4 * 3 - (input.base64.endsWith("==") ? 2 : input.base64.endsWith("=") ? 1 : 0);
    if (estimated > MAX_UPLOAD_FILE_BYTES || totalBytes + estimated > MAX_UPLOAD_TOTAL_BYTES) throw new Error("Byte attachment size budget exceeded");
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.length < 1 || bytes.length > MAX_UPLOAD_FILE_BYTES || bytes.toString("base64") !== input.base64) throw new Error("Invalid or oversized byte attachment");
    totalBytes += bytes.length; if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) throw new Error("Combined attachments exceed 16 MiB");
    if (!references.has(input.field_name)) throw new Error("Each supplied file must be referenced by a media field");
    decoded.push({ input: { ...input, content_type: contentType }, bytes });
  }
  for (const reference of references) if (!names.has(reference)) throw new Error("Media references an attachment that was not supplied");
  const body = new FormData();
  for (const [key, value] of Object.entries(params)) body.append(key, typeof value === "string" ? value : JSON.stringify(value));
  for (const { input, bytes } of decoded) body.append(input.field_name, new Blob([new Uint8Array(bytes)], { type: input.content_type }), input.filename);
  return { body, fileCount: decoded.length, totalBytes };
}
/** Configuration gates do not replace authorization for the files and recipient. */
export function assertMediaUploadScope(botAlias: string | undefined, chatId: unknown, env: Record<string,string|undefined> = process.env) {
  if (env.TELEGRAM_MEDIA_BYTES_ENABLED !== "true") throw new Error("Byte uploads are disabled until explicitly configured and authorized");
  if (!botAlias || typeof chatId !== "string") throw new Error("Byte uploads require an explicit bot and chat");
  let scopes: unknown;
  try { scopes = JSON.parse(env.TELEGRAM_MEDIA_ALLOWED_DESTINATIONS_JSON || "null"); } catch { throw new Error("Invalid media upload policy"); }
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 100 || scopes.some(s => !s || typeof s !== "object" || Array.isArray(s)
    || Object.keys(s).sort().join(',') !== 'botAlias,chatId' || typeof s.botAlias !== 'string' || typeof s.chatId !== 'string')) throw new Error("An explicit media upload policy is required");
  if (!scopes.some(s => s.botAlias === botAlias && s.chatId === chatId)) throw new Error("Media destination is outside the configured scope");
}
