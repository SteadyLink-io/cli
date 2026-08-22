import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";

export const VERSION = "0.1.0";
export const DEFAULT_API_URL = "https://api.steadylink.io";

const MIME_TYPES = new Map([
  [".avif", "image/avif"], [".gif", "image/gif"], [".heic", "image/heic"],
  [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".webp", "image/webp"], [".pdf", "application/pdf"],
  [".json", "application/json"], [".txt", "text/plain"], [".css", "text/css"],
  [".html", "text/html"], [".csv", "text/csv"], [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"], [".mp4", "video/mp4"], [".webm", "video/webm"],
  [".zip", "application/zip"],
]);

const HELP = `SteadyLink CLI ${VERSION}

Usage:
  steadylink <command> [arguments] [options]

Commands:
  buckets                              List workspace buckets
  inspect <asset-id>                   Inspect an asset
  upload <file-or-directory>           Upload files into a bucket
  migrate <directory>                  Upload a directory tree into a bucket
  replace <file>                       Replace a bucket object
  focal <asset-id>                     Set an image focal point

Options:
  --bucket <id>                        Target bucket for upload or replacement
  --key <path>                         Object path to replace
  --x <0..1> --y <0..1>                Focal point coordinates
  --api <url>                          API origin (default: ${DEFAULT_API_URL})
  --api-key <key>                      API key (prefer STEADYLINK_API_KEY)
  --json                               Disable progress output
  -h, --help                           Show help
  -v, --version                        Show version

Environment:
  STEADYLINK_API_KEY                   Workspace API key
  STEADYLINK_API_URL                   Override the API origin

Examples:
  steadylink buckets
  steadylink upload ./hero.png --bucket <bucket-id>
  steadylink migrate ./public --bucket <bucket-id>
  steadylink replace ./hero-v2.png --bucket <bucket-id> --key campaign/hero.png`;

export function helpText() {
  return HELP;
}

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h") options.help = true;
    else if (value === "-v") options.version = true;
    else if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const key = value.slice(2, equals === -1 ? undefined : equals);
      if (!key) throw new Error("Invalid empty option");
      if (equals !== -1) options[key] = value.slice(equals + 1);
      else {
        const next = argv[index + 1];
        options[key] = next && !next.startsWith("-") ? argv[++index] : true;
      }
    } else positional.push(value);
  }
  const [command = "help", ...args] = positional;
  return { command, positional: args, options };
}

export function contentTypeFor(filename) {
  return MIME_TYPES.get(extname(filename).toLowerCase()) || "application/octet-stream";
}

export async function collectFiles(input) {
  const root = resolve(input);
  const info = await stat(root);
  if (info.isFile()) {
    return [{ absolute: root, path: "", filename: basename(root), size: info.size, contentType: contentTypeFor(root) }];
  }
  if (!info.isDirectory()) throw new Error(`Not a file or directory: ${input}`);

  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const fileInfo = await stat(absolute);
        const folder = relative(root, directory).split(sep).filter(Boolean).join("/");
        files.push({
          absolute,
          path: folder ? `${folder}/` : "",
          filename: entry.name,
          size: fileInfo.size,
          contentType: contentTypeFor(entry.name),
        });
      }
    }
  }
  await walk(root);
  return files;
}

function apiError(response, body) {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed.detail?.message || parsed.detail || parsed.message || body;
    if (typeof message !== "string") message = JSON.stringify(message);
  } catch {}
  return new Error(`HTTP ${response.status}${message ? `: ${message}` : ""}`);
}

export function createClient({ apiKey, baseUrl = DEFAULT_API_URL, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("Set STEADYLINK_API_KEY or pass --api-key");
  const root = baseUrl.replace(/\/$/, "");
  return async (path, init = {}) => {
    const headers = { "X-API-Key": apiKey, ...(init.headers || {}) };
    if (typeof init.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${root}${path}`, { ...init, headers });
    const text = response.status === 204 ? "" : await response.text();
    if (!response.ok) throw apiError(response, text);
    if (!text) return null;
    const type = response.headers.get("content-type") || "";
    return type.includes("json") ? JSON.parse(text) : text;
  };
}

async function uploadFiles(client, bucketId, input, fetchImpl, { quiet = false } = {}) {
  const files = await collectFiles(input);
  if (!files.length) throw new Error("No files found");
  let completed = 0;

  for (let offset = 0; offset < files.length; offset += 100) {
    const chunk = files.slice(offset, offset + 100);
    const migration = await client("/api/platform/migrations", {
      method: "POST",
      body: JSON.stringify({
        bucketId,
        files: chunk.map(({ filename, path, size, contentType }) => ({ filename, path, size, contentType })),
      }),
    });
    const sessions = migration?.uploadBatch?.files;
    if (!Array.isArray(sessions) || sessions.length !== chunk.length) throw new Error("The API returned an invalid upload batch");

    for (let index = 0; index < chunk.length; index += 1) {
      const session = sessions[index];
      const file = chunk[index];
      const upload = await fetchImpl(session.uploadUrl, {
        method: "PUT",
        body: createReadStream(file.absolute),
        duplex: "half",
        headers: { "Content-Type": file.contentType, "Content-Length": String(file.size) },
      });
      if (!upload.ok) throw new Error(`Upload failed for ${file.absolute}: HTTP ${upload.status}`);
      await client(`/api/upload-sessions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: { "Idempotency-Key": `cli-${session.id}` },
      });
      completed += 1;
      if (!quiet && process.stderr.isTTY) process.stderr.write(`\rUploaded ${completed}/${files.length}`);
    }
  }
  if (!quiet && process.stderr.isTTY) process.stderr.write("\n");
  return { uploaded: completed, bucketId };
}

export async function replaceFile(client, bucketId, key, input, fetchImpl = fetch) {
  const files = await collectFiles(input);
  if (files.length !== 1) throw new Error("Replace accepts exactly one file");
  const file = files[0];
  const uploadQuery = new URLSearchParams({ size: String(file.size), content_type: file.contentType });
  const pending = await client(`/api/assets/${encodeURIComponent(bucketId)}/objects/upload-temp?${uploadQuery}`, { method: "POST" });
  const upload = await fetchImpl(pending.uploadUrl, {
    method: "PUT",
    body: createReadStream(file.absolute),
    duplex: "half",
    headers: { "Content-Type": file.contentType, "Content-Length": String(file.size) },
  });
  if (!upload.ok) throw new Error(`Replacement upload failed: HTTP ${upload.status}`);
  const replaceQuery = new URLSearchParams({ key, upload_temp_key: pending.tempKey, original_filename: file.filename });
  return client(`/api/assets/${encodeURIComponent(bucketId)}/objects/replace?${replaceQuery}`, { method: "POST" });
}

function requireOption(options, name, usage) {
  if (typeof options[name] !== "string" || !options[name]) throw new Error(usage);
  return options[name];
}

export async function execute(argv, environment = process.env, fetchImpl = fetch) {
  const { command, positional, options } = parseArgs(argv);
  if (command === "version" || options.version) return { text: VERSION };
  if (command === "help" || options.help) return { text: helpText() };

  const client = createClient({
    apiKey: options["api-key"] || environment.STEADYLINK_API_KEY,
    baseUrl: options.api || environment.STEADYLINK_API_URL || DEFAULT_API_URL,
    fetchImpl,
  });

  if (command === "buckets") return client("/api/assets/?limit=100");
  if (command === "inspect") {
    if (!positional[0]) throw new Error("Usage: steadylink inspect <asset-id>");
    return client(`/api/assets/${encodeURIComponent(positional[0])}`);
  }
  if (command === "upload" || command === "migrate") {
    if (!positional[0]) throw new Error(`Usage: steadylink ${command} <file-or-directory> --bucket <bucket-id>`);
    const bucketId = requireOption(options, "bucket", `Usage: steadylink ${command} <file-or-directory> --bucket <bucket-id>`);
    return uploadFiles(client, bucketId, positional[0], fetchImpl, { quiet: Boolean(options.json) });
  }
  if (command === "replace") {
    if (!positional[0]) throw new Error("Usage: steadylink replace <file> --bucket <bucket-id> --key <object-path>");
    const bucketId = requireOption(options, "bucket", "Usage: steadylink replace <file> --bucket <bucket-id> --key <object-path>");
    const key = requireOption(options, "key", "Usage: steadylink replace <file> --bucket <bucket-id> --key <object-path>");
    return replaceFile(client, bucketId, key, positional[0], fetchImpl);
  }
  if (command === "focal") {
    if (!positional[0] || typeof options.x !== "string" || typeof options.y !== "string") throw new Error("Usage: steadylink focal <asset-id> --x 0.5 --y 0.5");
    const x = Number(options.x);
    const y = Number(options.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error("Focal coordinates must be between 0 and 1");
    return client(`/api/platform/assets/${encodeURIComponent(positional[0])}/focal-point`, { method: "PUT", body: JSON.stringify({ x, y }) });
  }
  throw new Error(`Unknown command: ${command}. Run steadylink --help for available commands.`);
}

export async function run(argv = process.argv.slice(2), environment = process.env, fetchImpl = fetch) {
  const result = await execute(argv, environment, fetchImpl);
  if (result && Object.keys(result).length === 1 && typeof result.text === "string") {
    process.stdout.write(`${result.text}\n`);
    return undefined;
  }
  return result;
}
