import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface AttachmentInput {
  path?: string | undefined;
  base64?: string | undefined;
  fileName?: string | undefined;
  mimeType?: string | undefined;
}

export interface PreparedAttachment {
  data: Buffer;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml"
};

function assertPositiveLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Attachment byte limit must be a positive safe integer");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("\0") || /[\\/]/.test(trimmed) || basename(trimmed) !== trimmed) {
    throw new Error("fileName must be a plain file name without path separators");
  }
  return trimmed;
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error("base64 must contain valid standard base64 data");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new Error("base64 must contain valid standard base64 data");
  }
  return decoded;
}

function inferMimeType(fileName: string): string {
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

export async function prepareAttachmentInput(input: AttachmentInput, root: string, maxBytes: number): Promise<PreparedAttachment> {
  assertPositiveLimit(maxBytes);
  const hasPath = typeof input.path === "string" && input.path.trim().length > 0;
  const hasBase64 = typeof input.base64 === "string" && input.base64.trim().length > 0;
  if (hasPath === hasBase64) throw new Error("Provide exactly one of path or base64");

  let data: Buffer;
  let defaultName: string;
  if (hasPath) {
    const rootPath = await realpath(resolve(root));
    const requested = isAbsolute(input.path as string)
      ? resolve(input.path as string)
      : resolve(rootPath, input.path as string);
    const actual = await realpath(requested);
    if (!isWithin(rootPath, actual)) throw new Error(`Attachment path must stay within ${rootPath}`);
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("Attachment path must point to a regular file");
      if (metadata.size > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes}-byte limit`);
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
    defaultName = basename(actual);
  } else {
    data = decodeBase64(input.base64 as string);
    defaultName = input.fileName ?? "attachment.bin";
  }

  if (data.byteLength === 0) throw new Error("Attachment must not be empty");
  if (data.byteLength > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes}-byte limit`);
  const fileName = safeFileName(input.fileName ?? defaultName);
  if (Buffer.byteLength(fileName, "utf8") > 255) throw new Error("fileName must be at most 255 UTF-8 bytes");
  const mediaType = input.mimeType?.trim() || inferMimeType(fileName);
  if (!mediaType || mediaType.length > 255 || /[\0\r\n]/.test(mediaType)) throw new Error("mimeType must be 1-255 characters without nulls or line breaks");
  return { data, fileName, mediaType, sizeBytes: data.byteLength };
}

async function ensureSafeDirectory(rootPath: string, targetDirectory: string): Promise<void> {
  if (!isWithin(rootPath, targetDirectory)) throw new Error(`Output path must stay within ${rootPath}`);
  const rel = relative(rootPath, targetDirectory);
  if (!rel) return;
  let current = rootPath;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`Output directory must not contain symlinks: ${current}`);
      if (!metadata.isDirectory()) throw new Error(`Output parent is not a directory: ${current}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

export async function writeAttachmentOutput(data: Uint8Array, outputPath: string, root: string, overwrite = false): Promise<string> {
  const rootInput = resolve(root);
  await mkdir(rootInput, { recursive: true, mode: 0o700 });
  const rootPath = await realpath(rootInput);
  const target = isAbsolute(outputPath) ? resolve(outputPath) : resolve(rootPath, outputPath);
  if (!isWithin(rootPath, target)) throw new Error(`Output path must stay within ${rootPath}`);
  await ensureSafeDirectory(rootPath, dirname(target));

  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW |
    (overwrite ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(target, flags, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  return target;
}

export async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  assertPositiveLimit(maxBytes);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Download exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("download size limit exceeded");
        throw new Error(`Download exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
