import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { parseAssetRef, SteadyLink, SteadyLinkError, SteadyLinkNetworkError, SteadyLinkUploadError, type Fetch, type ImageFit, type ImageFormat, type TransformOptions, type UploadedFile, type UploadSource } from "@steadylink/sdk";
import { numberOption, parseArgs, stringOption, UsageError, type ParsedArgs } from "./args.js";
import { configPath, deleteConfig, maskKey, readConfig, writeConfig, type CliConfig } from "./config.js";
import { collectFiles, formatBytes, type LocalFile } from "./files.js";

export { parseArgs } from "./args.js";
export { collectFiles } from "./files.js";
export { configPath, readConfig, writeConfig } from "./config.js";

export const VERSION = "0.2.0";

/** Exit codes. Scripts can rely on these. */
export const EXIT = { ok: 0, error: 1, usage: 2, auth: 3, partial: 4 } as const;

interface Writable { write(chunk: string): unknown; isTTY?: boolean; columns?: number }
export interface CliIO {
  env: Record<string, string | undefined>;
  stdout: Writable;
  stderr: Writable;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  fetch?: Fetch;
  /** Answers interactive prompts in tests. */
  prompt?: (question: string, options?: { secret?: boolean }) => Promise<string>;
}

const USAGE = `steadylink ${VERSION} - stable links for files that change

Usage
  steadylink login [--api-key <key>] [--bucket <default-bucket>]
  steadylink logout
  steadylink upload <files or folders...> [--bucket <bucket>] [--folder <path>] [--public | --private]
  steadylink replace <asset-id | url | bucket:key> <file>
  steadylink ls [bucket[:folder/]]
  steadylink link <asset-id> [--w 800] [--h 600] [--fm webp] [--q 80] [--fit cover] [--revision 3]
  steadylink link <asset-id> --signed [--ttl 3600] [--name label]
  steadylink rm <asset-id | bucket:key> [--yes]
  steadylink versions <asset-id>
  steadylink rollback <asset-id> <version>
  steadylink inspect <asset-id>
  steadylink focal <asset-id> --x 0.5 --y 0.5

Options
  --json              Print machine-readable JSON to stdout
  --quiet, -q         Hide progress output
  --api-key <key>     Use this key instead of STEADYLINK_API_KEY or the saved login
  --api-url <url>     API origin (default https://api.steadylink.io)
  --cdn-url <url>     Delivery origin used for printed links
  --no-wait           Upload: return before files finish processing (links may be missing)
  --via api           Upload: stream bytes through the API instead of directly to storage
  --concurrency <n>   Upload: parallel transfers (default 4)

Environment
  STEADYLINK_API_KEY, STEADYLINK_API_URL, STEADYLINK_CDN_URL, STEADYLINK_BUCKET, STEADYLINK_CONFIG

Exit codes
  0 success   1 error   2 usage   3 missing or rejected credentials   4 some uploads failed
`;

class AuthError extends Error {}
class PartialError extends Error {
  constructor(message: string, readonly payload: unknown) { super(message) }
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Context {
  args: ParsedArgs;
  io: CliIO;
  json: boolean;
  quiet: boolean;
  config: CliConfig;
  configFile: string;
  client: () => SteadyLink;
  env: (name: string) => string | undefined;
  out: (line?: string) => void;
  err: (line?: string) => void;
}

function readSource(file: LocalFile): UploadSource {
  return {
    filename: file.filename,
    size: file.size,
    path: file.path,
    get data() { return Readable.toWeb(createReadStream(file.absolute)) as unknown as ReadableStream<Uint8Array> },
  };
}

async function resolveBucket(client: SteadyLink, ref: string | undefined): Promise<string> {
  if (!ref) throw new UsageError("Choose a bucket with --bucket <id|slug|name>, STEADYLINK_BUCKET, or `steadylink login --bucket`.");
  if (UUIDISH.test(ref)) return ref;
  const bucket = await client.findBucket(ref);
  if (!bucket) throw new UsageError(`No bucket matches "${ref}". Run \`steadylink ls\` to see your buckets.`);
  return bucket.id;
}

type FileTarget = { assetId: string } | { bucket: string; key: string };

/** Accepts an asset ID, a delivery URL, `bucket:key`, or a key when --bucket is given. */
export function parseTarget(value: string, bucket?: string): FileTarget {
  if (bucket) return { bucket, key: value.replace(/^\/+/, "") };
  if (/^https?:\/\//i.test(value) || value.startsWith("/a/")) {
    const ref = parseAssetRef(value);
    if (!ref) throw new UsageError(`Not a SteadyLink asset link: ${value}`);
    return { assetId: ref.assetId };
  }
  const colon = value.indexOf(":");
  if (colon > 0) return { bucket: value.slice(0, colon), key: value.slice(colon + 1).replace(/^\/+/, "") };
  const ref = parseAssetRef(value);
  if (!ref) throw new UsageError(`Expected an asset ID, a link, or bucket:path/to/file, got "${value}"`);
  return { assetId: ref.assetId };
}

async function prompt(io: CliIO, question: string, secret = false): Promise<string> {
  if (io.prompt) return io.prompt(question, { secret });
  const stdin = io.stdin ?? process.stdin;
  const rl = createInterface({ input: stdin, output: io.stderr as NodeJS.WritableStream, terminal: Boolean(stdin.isTTY) });
  if (secret && stdin.isTTY) {
    const internal = rl as unknown as { _writeToOutput?: (text: string) => void };
    internal._writeToOutput = text => { if (text.includes(question)) io.stderr.write(text) };
  }
  try {
    return await new Promise<string>(resolve => rl.question(question, answer => resolve(answer.trim())));
  } finally {
    if (secret && stdin.isTTY) io.stderr.write("\n");
    rl.close();
  }
}

async function readStdin(io: CliIO): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  let text = "";
  for await (const chunk of stdin) text += chunk.toString();
  return text.trim();
}

function progressReporter(ctx: Context, files: LocalFile[]) {
  if (ctx.json || ctx.quiet) return undefined;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const loaded = new Map<number, number>();
  const tty = Boolean(ctx.io.stderr.isTTY);
  let lastDraw = 0;
  let lastPercent = -1;
  ctx.err(`Uploading ${files.length} file${files.length === 1 ? "" : "s"} (${formatBytes(total)})`);
  return {
    update(index: number, bytes: number, name: string) {
      loaded.set(index, bytes);
      const sent = [...loaded.values()].reduce((sum, value) => sum + value, 0);
      const percent = total ? Math.floor((sent / total) * 100) : 100;
      const now = Date.now();
      if (tty) {
        if (now - lastDraw < 80 && percent !== 100) return;
        lastDraw = now;
        const width = 24;
        const filled = Math.round((percent / 100) * width);
        const label = name.length > 32 ? `…${name.slice(-31)}` : name;
        ctx.io.stderr.write(`\r\x1b[2K[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${String(percent).padStart(3)}% ${formatBytes(sent)}/${formatBytes(total)} ${label}`);
      } else if (percent >= lastPercent + 25 || (percent === 100 && lastPercent !== 100)) {
        lastPercent = percent - (percent % 25);
        ctx.err(`  ${percent}% (${formatBytes(sent)} of ${formatBytes(total)})`);
      }
    },
    done() { if (tty) ctx.io.stderr.write("\r\x1b[2K") },
  };
}

function transformFromOptions(options: ParsedArgs["options"]): TransformOptions {
  const transform: TransformOptions = {};
  const width = numberOption(options, "w") ?? numberOption(options, "width");
  const height = numberOption(options, "h") ?? numberOption(options, "height");
  const quality = numberOption(options, "q") ?? numberOption(options, "quality");
  const version = numberOption(options, "revision");
  const format = stringOption(options, "fm", "format");
  const fit = stringOption(options, "fit");
  if (width) transform.width = width;
  if (height) transform.height = height;
  if (quality) transform.quality = quality;
  if (version) transform.version = version;
  if (format) {
    if (!["webp", "jpg", "png"].includes(format)) throw new UsageError("--fm must be webp, jpg, or png");
    transform.format = format as ImageFormat;
  }
  if (fit) {
    if (!["cover", "contain", "inside", "outside"].includes(fit)) throw new UsageError("--fit must be cover, contain, inside, or outside");
    transform.fit = fit as ImageFit;
  }
  return transform;
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

async function login(ctx: Context) {
  const { options } = ctx.args;
  let apiKey = stringOption(options, "api-key");
  if (!apiKey && options.stdin) apiKey = await readStdin(ctx.io);
  if (!apiKey) {
    const stdin = ctx.io.stdin ?? process.stdin;
    if (!ctx.io.prompt && !stdin.isTTY) apiKey = await readStdin(ctx.io);
    else {
      ctx.err("Create a key at https://steadylink.io/dashboard/developers (scopes: assets:read, assets:write).");
      apiKey = await prompt(ctx.io, "API key: ", true);
    }
  }
  if (!apiKey) throw new UsageError("No API key provided.");
  const apiUrl = stringOption(options, "api-url", "api") ?? ctx.env("STEADYLINK_API_URL") ?? ctx.config.apiUrl;
  const cdnUrl = stringOption(options, "cdn-url") ?? ctx.config.cdnUrl;
  const client = new SteadyLink({ apiKey, ...(apiUrl ? { baseUrl: apiUrl } : {}), ...(ctx.io.fetch ? { fetch: ctx.io.fetch } : {}) });
  const buckets = await client.listBuckets(100);
  const next: CliConfig = { ...ctx.config, apiKey };
  if (apiUrl) next.apiUrl = apiUrl;
  if (cdnUrl) next.cdnUrl = cdnUrl;
  const bucket = stringOption(options, "bucket");
  if (bucket) next.bucket = bucket;
  await writeConfig(ctx.configFile, next);
  if (ctx.json) return { loggedIn: true, configPath: ctx.configFile, key: maskKey(apiKey), buckets: buckets.items.length };
  ctx.out(`Logged in with ${maskKey(apiKey)}. ${buckets.items.length} bucket${buckets.items.length === 1 ? "" : "s"} visible.`);
  ctx.out(`Saved to ${ctx.configFile}`);
  return undefined;
}

async function logout(ctx: Context) {
  const { apiKey: _removed, ...rest } = ctx.config;
  if (Object.keys(rest).length) await writeConfig(ctx.configFile, rest); else await deleteConfig(ctx.configFile);
  if (ctx.json) return { loggedOut: true };
  ctx.out("Logged out. The saved API key was removed.");
  return undefined;
}

async function upload(ctx: Context) {
  const { positional, options } = ctx.args;
  if (!positional.length) throw new UsageError("Usage: steadylink upload <files or folders...> [--bucket <bucket>] [--folder <path>] [--public]");
  if (options.public && options.private) throw new UsageError("Use either --public or --private, not both.");
  const files = await collectFiles(positional);
  if (!files.length) throw new UsageError("No files found.");
  const client = ctx.client();
  const bucketId = await resolveBucket(client, stringOption(options, "bucket") ?? ctx.env("STEADYLINK_BUCKET") ?? ctx.config.bucket);
  const progress = progressReporter(ctx, files);
  const via = stringOption(options, "via");
  if (via && via !== "api" && via !== "presigned") throw new UsageError("--via must be api or presigned");
  let results: UploadedFile[];
  try {
    results = await client.upload(bucketId, files.map(readSource), {
      ...(stringOption(options, "folder", "path") ? { folder: stringOption(options, "folder", "path") as string } : {}),
      ...(options.public ? { visibility: "public" as const } : options.private ? { visibility: "private" as const } : {}),
      ...(options["no-wait"] ? { wait: false } : {}),
      ...(via ? { via: via as "api" | "presigned" } : {}),
      concurrency: numberOption(options, "concurrency") ?? 4,
      throwOnError: false,
      ...(progress ? { onProgress: ({ index, loaded, filename }: { index: number; loaded: number; filename: string }) => progress.update(index, loaded, filename) } : {}),
    });
  } finally {
    progress?.done();
  }
  const failed = results.filter(result => result.error || ["failed", "blocked", "cancelled"].includes(result.status));
  const payload = results.map(result => ({ file: result.key, status: result.status, assetId: result.assetId, url: result.url, ...(result.visibility ? { visibility: result.visibility } : {}), ...(result.error ? { error: result.error } : {}) }));
  if (!ctx.json) {
    const width = Math.min(48, Math.max(...results.map(result => result.key.length)));
    for (const result of results) {
      if (result.error || ["failed", "blocked", "cancelled"].includes(result.status)) ctx.out(`${result.key.padEnd(width)}  FAILED  ${result.error?.message ?? result.status}`);
      else ctx.out(`${result.key.padEnd(width)}  ${result.url ?? `(${result.status}, link available once processing finishes)`}`);
    }
    if (!ctx.quiet) ctx.err(`${results.length - failed.length} uploaded${failed.length ? `, ${failed.length} failed` : ""}.`);
  }
  if (failed.length) throw new PartialError(`${failed.length} of ${results.length} uploads failed`, ctx.json ? payload : undefined);
  return ctx.json ? payload : undefined;
}

async function replace(ctx: Context) {
  const { positional, options } = ctx.args;
  const legacyKey = stringOption(options, "key");
  let targetArg: string | undefined;
  let fileArg: string | undefined;
  if (legacyKey) { targetArg = legacyKey; fileArg = positional[0] }
  else [targetArg, fileArg] = positional;
  if (!targetArg || !fileArg) throw new UsageError("Usage: steadylink replace <asset-id | url | bucket:key> <file>");
  const files = await collectFiles(fileArg);
  if (files.length !== 1 || files[0]?.path) throw new UsageError("replace accepts exactly one file");
  const file = files[0] as LocalFile;
  const client = ctx.client();
  const target = parseTarget(targetArg, stringOption(options, "bucket"));
  const progress = progressReporter(ctx, [file]);
  let result;
  try {
    result = await client.replace(
      "assetId" in target ? target.assetId : { bucketId: await resolveBucket(client, target.bucket), key: target.key },
      readSource(file),
      progress ? { onProgress: loaded => progress.update(0, loaded, file.filename) } : {},
    );
  } finally {
    progress?.done();
  }
  if (ctx.json) return result;
  ctx.out(`Replaced ${result.key} with ${file.filename}. Now on revision ${result.version}.`);
  if (result.url) ctx.out(result.url);
  return undefined;
}

async function list(ctx: Context) {
  const client = ctx.client();
  const arg = ctx.args.positional[0] ?? stringOption(ctx.args.options, "bucket");
  if (!arg) {
    const buckets = await client.listBuckets(100);
    if (ctx.json) return buckets.items;
    if (!buckets.items.length) ctx.out("No buckets yet. Create one in the dashboard.");
    for (const bucket of buckets.items) ctx.out(`${bucket.id}  ${(bucket.slug ?? "").padEnd(20)}  ${bucket.isPrivate ? "private" : "public "}  ${bucket.name}`);
    return undefined;
  }
  const colon = arg.indexOf(":");
  const bucketRef = colon > 0 ? arg.slice(0, colon) : arg;
  const prefix = colon > 0 ? arg.slice(colon + 1) : stringOption(ctx.args.options, "folder") ?? "";
  const bucketId = await resolveBucket(client, bucketRef);
  const listing = await client.listFiles(bucketId, prefix ? { prefix } : {});
  if (ctx.json) return { ...listing, items: listing.items.map(item => ({ ...item, url: item.objectAssetId ? client.link(item.objectAssetId) : null })) };
  for (const folder of listing.folders) ctx.out(`${"".padEnd(8)}  ${"".padEnd(36)}  ${folder.path}`);
  for (const item of listing.items) ctx.out(`${formatBytes(item.size).padStart(8)}  ${(item.objectAssetId ?? "(processing)").padEnd(36)}  ${item.key}${item.visibility === "private" ? "  [private]" : ""}`);
  if (!listing.folders.length && !listing.items.length) ctx.err("(empty)");
  return undefined;
}

async function link(ctx: Context) {
  const [ref] = ctx.args.positional;
  if (!ref) throw new UsageError("Usage: steadylink link <asset-id> [--signed --ttl 3600]");
  const client = ctx.client();
  const target = parseTarget(ref, stringOption(ctx.args.options, "bucket"));
  let assetId: string;
  if ("assetId" in target) assetId = target.assetId;
  else {
    const details = await client.statFile(await resolveBucket(client, target.bucket), target.key);
    if (!details.objectAssetId) throw new Error(`${target.key} has no asset ID yet; it may still be processing.`);
    assetId = details.objectAssetId;
  }
  const transform = transformFromOptions(ctx.args.options);
  if (ctx.args.options.signed) {
    const ttl = numberOption(ctx.args.options, "ttl");
    const name = stringOption(ctx.args.options, "name");
    const signed = await client.createSignedLink(assetId, { ...(ttl ? { ttlSeconds: ttl } : {}), ...(name ? { name } : {}), ...(transform.version ? { revision: transform.version } : {}) });
    const { version: _pinned, ...rest } = transform;
    const url = client.link(assetId, { ...rest, token: signed.token });
    if (ctx.json) return { assetId, url, expiresAt: signed.expiresAt, grantId: signed.id };
    ctx.out(url);
    if (!ctx.quiet) ctx.err(`Expires ${signed.expiresAt}Z. Revoke with grant ${signed.id}.`);
    return undefined;
  }
  const url = client.link(assetId, transform);
  if (ctx.json) return { assetId, url };
  ctx.out(url);
  return undefined;
}

async function remove(ctx: Context) {
  const [ref] = ctx.args.positional;
  if (!ref) throw new UsageError("Usage: steadylink rm <asset-id | bucket:key> [--yes]");
  const client = ctx.client();
  const target = parseTarget(ref, stringOption(ctx.args.options, "bucket"));
  let bucketId: string;
  let key: string;
  if ("assetId" in target) {
    const details = await client.getFile(target.assetId);
    if (!details.bucketId) throw new Error(`Asset ${target.assetId} is not linked to a bucket file.`);
    bucketId = details.bucketId;
    key = details.key;
  } else {
    bucketId = await resolveBucket(client, target.bucket);
    key = target.key;
  }
  if (!ctx.args.options.yes) {
    const stdin = ctx.io.stdin ?? process.stdin;
    if (!ctx.io.prompt && !stdin.isTTY) throw new UsageError(`Refusing to delete ${key} without --yes.`);
    const answer = await prompt(ctx.io, `Delete ${key} and every revision? Its link will stop working. [y/N] `);
    if (!/^y(es)?$/i.test(answer)) {
      ctx.err("Cancelled.");
      return ctx.json ? { deleted: false, key } : undefined;
    }
  }
  await client.deleteFile(bucketId, key);
  if (ctx.json) return { deleted: true, bucketId, key };
  ctx.out(`Deleted ${key}.`);
  return undefined;
}

async function versions(ctx: Context) {
  const [assetId] = ctx.args.positional;
  if (!assetId) throw new UsageError("Usage: steadylink versions <asset-id>");
  const revisions = await ctx.client().listVersions(assetId);
  if (ctx.json) return revisions;
  for (const revision of revisions) {
    ctx.out(`${revision.isCurrent ? "*" : " "} v${String(revision.versionNumber).padEnd(4)} ${revision.createdAt.slice(0, 19).replace("T", " ")}  ${formatBytes(revision.byteSize ?? 0).padStart(8)}  ${revision.mime ?? ""}${revision.label ? `  "${revision.label}"` : ""}`);
  }
  return undefined;
}

async function rollback(ctx: Context) {
  const [assetId, versionArg] = ctx.args.positional;
  const version = Number(versionArg);
  if (!assetId || !Number.isInteger(version) || version < 1) throw new UsageError("Usage: steadylink rollback <asset-id> <version>");
  const client = ctx.client();
  const result = await client.rollback(assetId, version);
  if (ctx.json) return { ...result, url: client.link(assetId) };
  ctx.out(`Revision ${version} is current again. ${client.link(assetId)}`);
  return undefined;
}

async function inspect(ctx: Context) {
  const [assetId] = ctx.args.positional;
  if (!assetId) throw new UsageError("Usage: steadylink inspect <asset-id>");
  const client = ctx.client();
  const details = await client.getFile(assetId).then(file => ({ ...file, url: client.link(assetId) }), async error => {
    if (error instanceof SteadyLinkError && error.status === 404) return client.getBucket(assetId);
    throw error;
  });
  ctx.out(JSON.stringify(details, null, 2));
  return undefined;
}

async function focal(ctx: Context) {
  const [assetId] = ctx.args.positional;
  const x = numberOption(ctx.args.options, "x");
  const y = numberOption(ctx.args.options, "y");
  if (!assetId || x === undefined || y === undefined) throw new UsageError("Usage: steadylink focal <asset-id> --x 0.5 --y 0.5");
  const result = await ctx.client().setFocalPoint(assetId, x, y);
  if (ctx.json) return result;
  ctx.out(`Focal point set to ${result.x}, ${result.y}.`);
  return undefined;
}

const COMMANDS: Record<string, (ctx: Context) => Promise<unknown>> = {
  login, logout, upload, migrate: upload, replace, ls: list, list, link, rm: remove, delete: remove, versions, rollback, inspect, focal,
};

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/** Runs the CLI and resolves to an exit code. Never calls process.exit. */
export async function main(argv: string[] = process.argv.slice(2), io: Partial<CliIO> = {}): Promise<number> {
  const fullIO: CliIO = { env: io.env ?? process.env, stdout: io.stdout ?? process.stdout, stderr: io.stderr ?? process.stderr, ...(io.stdin ? { stdin: io.stdin } : {}), ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.prompt ? { prompt: io.prompt } : {}) };
  let args: ParsedArgs;
  try { args = parseArgs(argv) } catch (error) { fullIO.stderr.write(`steadylink: ${(error as Error).message}\n`); return EXIT.usage }
  const json = Boolean(args.options.json);
  const out = (line = "") => { fullIO.stdout.write(`${line}\n`) };
  const err = (line = "") => { fullIO.stderr.write(`${line}\n`) };

  if (args.command === "version" || args.options.version === true) { out(json ? JSON.stringify({ version: VERSION }) : VERSION); return EXIT.ok }
  if (args.command === "help" || args.options.help === true) { out(USAGE); return EXIT.ok }
  const handler = COMMANDS[args.command];
  if (!handler) { err(`steadylink: unknown command "${args.command}"\n`); err(USAGE); return EXIT.usage }

  try {
    const configFile = configPath(fullIO.env);
    const config = await readConfig(configFile);
    const env = (name: string) => fullIO.env[name] || undefined;
    const ctx: Context = {
      args, io: fullIO, json, quiet: Boolean(args.options.quiet), config, configFile, out, err, env,
      client: () => {
        const apiKey = stringOption(args.options, "api-key") ?? env("STEADYLINK_API_KEY") ?? config.apiKey;
        if (!apiKey) throw new AuthError("Not logged in. Run `steadylink login` or set STEADYLINK_API_KEY.");
        const baseUrl = stringOption(args.options, "api-url", "api") ?? env("STEADYLINK_API_URL") ?? config.apiUrl;
        const cdnUrl = stringOption(args.options, "cdn-url") ?? env("STEADYLINK_CDN_URL") ?? config.cdnUrl;
        return new SteadyLink({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(cdnUrl ? { cdnUrl } : {}), ...(fullIO.fetch ? { fetch: fullIO.fetch } : {}) });
      },
    };
    const result = await handler(ctx);
    if (json && result !== undefined) out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  } catch (error) {
    return reportError(error, json, fullIO, out, err);
  }
}

function reportError(error: unknown, json: boolean, io: CliIO, out: (line?: string) => void, err: (line?: string) => void): number {
  let code: number = EXIT.error;
  let message = error instanceof Error ? error.message : String(error);
  let extra: Record<string, unknown> = {};
  if (error instanceof UsageError) code = EXIT.usage;
  else if (error instanceof AuthError) code = EXIT.auth;
  else if (error instanceof PartialError) { code = EXIT.partial; if (json && error.payload) { out(JSON.stringify(error.payload, null, 2)); return code } }
  else if (error instanceof SteadyLinkUploadError) code = EXIT.partial;
  else if (error instanceof SteadyLinkError) {
    if (error.status === 401 || error.status === 403) { code = EXIT.auth; message = `${message} (HTTP ${error.status}). Check the API key and its scopes.` }
    extra = { status: error.status, code: error.code, requestId: error.requestId };
    if (!json && error.requestId) message += ` [request ${error.requestId}]`;
  } else if (error instanceof SteadyLinkNetworkError) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    message = `${message}${cause}`;
  }
  if (json) io.stdout.write(`${JSON.stringify({ error: { message, ...extra } }, null, 2)}\n`);
  else err(`steadylink: ${message}`);
  return code;
}
