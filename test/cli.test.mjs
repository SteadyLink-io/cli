import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectFiles, configPath, main, parseArgs, parseTarget } from "../dist/cli.js";

const BUCKET = "11111111-2222-3333-4444-555555555555";

async function sandbox() {
  const directory = await mkdtemp(join(tmpdir(), "steadylink-cli-"));
  return { directory, env: { STEADYLINK_CONFIG: join(directory, "config.json") } };
}

function capture() {
  const stream = () => ({ text: "", isTTY: false, write(chunk) { this.text += chunk; return true } });
  return { stdout: stream(), stderr: stream() };
}

/** Fake API that records calls and finalizes every upload immediately. */
function fakeApi(extra = {}) {
  const calls = [];
  const sessions = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body = init.body;
    if (body && typeof body.getReader === "function") { const chunks = []; for await (const chunk of body) chunks.push(chunk); body = Buffer.concat(chunks).toString() }
    calls.push({ method, url, headers, body });
    const route = `${method} ${url.pathname}`;
    if (extra[route]) return extra[route]({ url, body, headers });
    if (url.hostname === "storage.test") return new Response(null, { status: 200 });
    if (route === "GET /api/assets/") return Response.json({ items: [{ id: BUCKET, name: "Marketing", slug: "marketing", isPrivate: false }], nextCursor: null });
    if (route === "POST /api/upload-batches") {
      const manifest = JSON.parse(body);
      const files = manifest.files.map((file, index) => ({ id: `s${sessions.length + index}`, batchId: "batch-1", bucketId: manifest.bucketId, filename: file.filename, path: file.path, contentType: file.contentType, expectedSize: file.size, status: "created", objectAssetId: null, revisionNumber: null, error: null, uploadUrl: `https://storage.test/s${sessions.length + index}` }));
      sessions.push(...files);
      return Response.json({ id: "batch-1", status: "active", totalFiles: files.length, files }, { status: 201 });
    }
    if (method === "POST" && url.pathname.endsWith("/complete")) return Response.json({ status: "committing" }, { status: 202 });
    if (route === "GET /api/upload-batches/batch-1") return Response.json({ id: "batch-1", files: sessions.map(file => ({ ...file, status: "ready", objectAssetId: `asset-${file.id}`, revisionNumber: 1 })) });
    if (route.endsWith("/objects/visibility")) return Response.json({ updated: true });
    return Response.json({ detail: `unexpected ${route}` }, { status: 404 });
  };
  return { fetch, calls };
}

test("parseArgs handles commands, booleans, short flags, and --key=value", () => {
  assert.deepEqual(parseArgs(["upload", "a.png", "b.png", "--bucket", "web", "--public", "-y", "--folder=img/"]), {
    command: "upload", positional: ["a.png", "b.png"], options: { bucket: "web", public: true, yes: true, folder: "img/" },
  });
  assert.equal(parseArgs(["--version"]).command, "version");
  assert.equal(parseArgs([]).command, "help");
});

test("parseTarget understands IDs, links, bucket:key, and --bucket", () => {
  assert.deepEqual(parseTarget("3f2a-uuid"), { assetId: "3f2a-uuid" });
  assert.deepEqual(parseTarget("https://cdn.steadylink.io/a/abc?w=10"), { assetId: "abc" });
  assert.deepEqual(parseTarget("marketing:campaign/hero.png"), { bucket: "marketing", key: "campaign/hero.png" });
  assert.deepEqual(parseTarget("/campaign/hero.png", "marketing"), { bucket: "marketing", key: "campaign/hero.png" });
});

test("collectFiles walks folders and keeps relative paths", async () => {
  const { directory } = await sandbox();
  await mkdir(join(directory, "media", "icons"), { recursive: true });
  await writeFile(join(directory, "media", "hero.png"), "png");
  await writeFile(join(directory, "media", "icons", "a.svg"), "<svg/>");
  const files = await collectFiles([join(directory, "media")]);
  assert.deepEqual(files.map(file => [file.path, file.filename, file.size]), [["", "hero.png", 3], ["icons/", "a.svg", 6]]);
});

test("config path honors STEADYLINK_CONFIG, APPDATA, and XDG_CONFIG_HOME", () => {
  assert.equal(configPath({ STEADYLINK_CONFIG: "/x/c.json" }), "/x/c.json");
  assert.equal(configPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32").endsWith(join("steadylink", "config.json")), true);
  assert.equal(configPath({ XDG_CONFIG_HOME: "/home/me/.cfg" }, "linux"), join("/home/me/.cfg", "steadylink", "config.json"));
});

test("login validates the key and stores it; commands then use it", async () => {
  const { env } = await sandbox();
  const api = fakeApi();
  const io = { ...capture(), env, fetch: api.fetch };
  assert.equal(await main(["login", "--api-key", "slk_live_abcdefgh1234", "--bucket", "marketing"], io), 0);
  const saved = JSON.parse(await readFile(env.STEADYLINK_CONFIG, "utf8"));
  assert.deepEqual(saved, { apiKey: "slk_live_abcdefgh1234", bucket: "marketing" });
  if (process.platform !== "win32") assert.equal((await stat(env.STEADYLINK_CONFIG)).mode & 0o777, 0o600);
  assert.match(io.stdout.text, /Logged in with slk_…1234/);
  assert.equal(api.calls[0].headers.get("x-api-key"), "slk_live_abcdefgh1234");

  const ls = { ...capture(), env, fetch: api.fetch };
  assert.equal(await main(["ls", "--json"], ls), 0);
  assert.equal(JSON.parse(ls.stdout.text)[0].slug, "marketing");

  assert.equal(await main(["logout"], { ...capture(), env }), 0);
  assert.deepEqual(JSON.parse(await readFile(env.STEADYLINK_CONFIG, "utf8")), { bucket: "marketing" });
});

test("login reads a key from a prompt", async () => {
  const { env } = await sandbox();
  const io = { ...capture(), env, fetch: fakeApi().fetch, prompt: async (_question, options) => { assert.equal(options.secret, true); return "slk_prompted_key_9999" } };
  assert.equal(await main(["login"], io), 0);
  assert.equal(JSON.parse(await readFile(env.STEADYLINK_CONFIG, "utf8")).apiKey, "slk_prompted_key_9999");
});

test("upload resolves the bucket slug, uploads folders, applies --public, and prints links", async () => {
  const { directory, env } = await sandbox();
  await mkdir(join(directory, "site", "img"), { recursive: true });
  await writeFile(join(directory, "site", "index.html"), "<h1>hi</h1>");
  await writeFile(join(directory, "site", "img", "logo.png"), "png");
  const api = fakeApi();
  const io = { ...capture(), env: { ...env, STEADYLINK_API_KEY: "slk_env" }, fetch: api.fetch };
  const code = await main(["upload", join(directory, "site"), "--bucket", "marketing", "--folder", "launch", "--public", "--json"], io);
  assert.equal(code, 0, io.stderr.text);
  const results = JSON.parse(io.stdout.text);
  assert.deepEqual(results.map(result => [result.file, result.url, result.visibility]), [
    ["launch/img/logo.png", "https://cdn.steadylink.io/a/asset-s0", "public"],
    ["launch/index.html", "https://cdn.steadylink.io/a/asset-s1", "public"],
  ]);
  const manifest = JSON.parse(api.calls.find(call => call.url.pathname === "/api/upload-batches").body);
  assert.equal(manifest.bucketId, BUCKET);
  assert.deepEqual(manifest.files.map(file => file.contentType), ["image/png", "text/html"]);
  const put = api.calls.find(call => call.url.hostname === "storage.test");
  assert.equal(put.headers.get("content-type"), "application/octet-stream");
  assert.equal(io.stderr.text, "", "--json keeps stderr quiet");
});

test("upload prints human output with progress to stderr", async () => {
  const { directory, env } = await sandbox();
  await writeFile(join(directory, "hero.webp"), "webp-bytes");
  const io = { ...capture(), env: { ...env, STEADYLINK_API_KEY: "slk_env", STEADYLINK_BUCKET: BUCKET }, fetch: fakeApi().fetch };
  assert.equal(await main(["upload", join(directory, "hero.webp")], io), 0);
  assert.match(io.stdout.text, /hero\.webp\s+https:\/\/cdn\.steadylink\.io\/a\/asset-s0/);
  assert.match(io.stderr.text, /Uploading 1 file \(10 B\)/);
  assert.match(io.stderr.text, /100%/);
  assert.match(io.stderr.text, /1 uploaded\./);
});

test("upload exits 4 when some files fail", async () => {
  const { directory, env } = await sandbox();
  await writeFile(join(directory, "a.txt"), "a");
  const api = fakeApi({ "PUT /s0": () => new Response("denied", { status: 403 }), "DELETE /api/upload-sessions/s0": () => Response.json({}) });
  const io = { ...capture(), env: { ...env, STEADYLINK_API_KEY: "k" }, fetch: api.fetch };
  assert.equal(await main(["upload", join(directory, "a.txt"), "--bucket", BUCKET], io), 4);
  assert.match(io.stdout.text, /FAILED\s+Storage rejected the upload \(HTTP 403\): denied/);
});

test("replace accepts an asset ID and keeps the same link", async () => {
  const { directory, env } = await sandbox();
  const file = join(directory, "hero-v2.png");
  await writeFile(file, "new-bytes");
  const api = fakeApi({
    "GET /api/assets/object/asset-9/stat": () => Response.json({ bucketId: BUCKET, key: "campaign/hero.png", objectAssetId: "asset-9" }),
    [`POST /api/assets/${BUCKET}/objects/upload-temp`]: () => Response.json({ uploadUrl: "https://storage.test/temp", tempKey: "uploads/temp/1" }),
    [`POST /api/assets/${BUCKET}/objects/replace`]: () => Response.json({ replaced: true, version: 7 }),
  });
  const io = { ...capture(), env: { ...env, STEADYLINK_API_KEY: "k" }, fetch: api.fetch };
  assert.equal(await main(["replace", "asset-9", file, "-q"], io), 0, io.stderr.text);
  assert.equal(io.stdout.text, "Replaced campaign/hero.png with hero-v2.png. Now on revision 7.\nhttps://cdn.steadylink.io/a/asset-9\n");
  assert.equal(api.calls.find(call => call.url.hostname === "storage.test").body, "new-bytes");
});

test("link prints plain, transformed, and signed links", async () => {
  const { env } = await sandbox();
  const api = fakeApi({ "POST /api/assets/asset-1/signed-url": ({ url }) => Response.json({ id: "g1", token: "tkn", expiresAt: "2026-10-03T00:00:00", ttl: url.searchParams.get("ttl") }, { status: 201 }) });
  const base = { env: { ...env, STEADYLINK_API_KEY: "k", STEADYLINK_CDN_URL: "https://media.example.com" }, fetch: api.fetch };
  let io = { ...capture(), ...base };
  assert.equal(await main(["link", "asset-1", "--w", "800", "--fm", "webp"], io), 0);
  assert.equal(io.stdout.text, "https://media.example.com/a/asset-1?w=800&fm=webp\n");
  io = { ...capture(), ...base };
  assert.equal(await main(["link", "asset-1", "--signed", "--ttl", "3600", "--json"], io), 0);
  assert.deepEqual(JSON.parse(io.stdout.text), { assetId: "asset-1", url: "https://media.example.com/a/asset-1?token=tkn", expiresAt: "2026-10-03T00:00:00", grantId: "g1" });
  assert.equal(api.calls.at(-1).url.searchParams.get("ttl"), "3600");
  io = { ...capture(), ...base };
  assert.equal(await main(["link", "asset-1", "--fm", "gif"], io), 2);
});

test("rm refuses without --yes when not interactive, then deletes with --yes", async () => {
  const { env } = await sandbox();
  const api = fakeApi({ [`DELETE /api/assets/${BUCKET}/objects`]: () => Response.json({ deleted: true }) });
  const base = { env: { ...env, STEADYLINK_API_KEY: "k" }, fetch: api.fetch, stdin: Object.assign(async function* () {}(), { isTTY: false }) };
  let io = { ...capture(), ...base };
  assert.equal(await main(["rm", `${BUCKET}:old/file.pdf`], io), 2);
  assert.match(io.stderr.text, /Refusing to delete old\/file\.pdf without --yes/);
  assert.equal(api.calls.some(call => call.method === "DELETE"), false);
  io = { ...capture(), ...base };
  assert.equal(await main(["rm", `${BUCKET}:old/file.pdf`, "--yes", "--json"], io), 0);
  assert.deepEqual(JSON.parse(io.stdout.text), { deleted: true, bucketId: BUCKET, key: "old/file.pdf" });
  assert.equal(api.calls.at(-1).url.searchParams.get("key"), "old/file.pdf");
});

test("exit codes: missing key is 3, rejected key is 3, unknown command is 2", async () => {
  const { env } = await sandbox();
  let io = { ...capture(), env };
  assert.equal(await main(["ls"], io), 3);
  assert.match(io.stderr.text, /Not logged in/);
  io = { ...capture(), env: { ...env, STEADYLINK_API_KEY: "bad" }, fetch: async () => Response.json({ detail: "Invalid API key" }, { status: 401, headers: { "x-request-id": "req_9" } }) };
  assert.equal(await main(["ls", "--json"], io), 3);
  assert.deepEqual(JSON.parse(io.stdout.text).error, { message: "Invalid API key (HTTP 401). Check the API key and its scopes.", status: 401, requestId: "req_9" });
  io = { ...capture(), env };
  assert.equal(await main(["frobnicate"], io), 2);
  io = { ...capture(), env };
  assert.equal(await main(["--version"], io), 0);
  assert.match(io.stdout.text, /^\d+\.\d+\.\d+\n$/);
});
