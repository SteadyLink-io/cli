import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectFiles, contentTypeFor, createClient, execute, parseArgs, replaceFile } from "../src/cli.mjs";

test("parses positional values, flags, and equals options", () => {
  assert.deepEqual(parseArgs(["upload", "./media", "--bucket=bucket-1", "--json"]), {
    command: "upload",
    positional: ["./media"],
    options: { bucket: "bucket-1", json: true },
  });
});

test("detects common media content types", () => {
  assert.equal(contentTypeFor("hero.WEBP"), "image/webp");
  assert.equal(contentTypeFor("press-kit.pdf"), "application/pdf");
  assert.equal(contentTypeFor("unknown.bin"), "application/octet-stream");
});

test("collects a directory recursively and skips symbolic link handling", async () => {
  const root = await mkdtemp(join(tmpdir(), "steadylink-cli-"));
  await mkdir(join(root, "campaign"));
  await writeFile(join(root, "campaign", "hero.png"), "png");
  const files = await collectFiles(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "campaign/");
  assert.equal(files[0].contentType, "image/png");
});

test("client sends authentication and preserves request headers", async () => {
  let request;
  const client = createClient({ apiKey: "slk_test", baseUrl: "https://api.example", fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }});
  await client("/api/test", { method: "POST", headers: { "Idempotency-Key": "operation-1" } });
  assert.equal(request.url, "https://api.example/api/test");
  assert.equal(request.init.headers["X-API-Key"], "slk_test");
  assert.equal(request.init.headers["Idempotency-Key"], "operation-1");
});

test("replacement uploads bytes with the detected MIME type", async () => {
  const root = await mkdtemp(join(tmpdir(), "steadylink-replace-"));
  const source = join(root, "hero.png");
  await writeFile(source, "replacement");
  const calls = [];
  const client = async (path) => {
    calls.push(path);
    if (path.includes("upload-temp")) return { uploadUrl: "https://storage.example/upload", tempKey: "temp/one" };
    return { replaced: true };
  };
  let uploadedType;
  const result = await replaceFile(client, "bucket-1", "campaign/hero.png", source, async (_url, init) => {
    uploadedType = init.headers["Content-Type"];
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(result, { replaced: true });
  assert.equal(uploadedType, "image/png");
  assert.match(calls[1], /campaign%2Fhero.png/);
});

test("help and version do not require an API key", async () => {
  assert.match((await execute(["help"], {})).text, /SteadyLink CLI/);
  assert.equal((await execute(["--version"], {})).text, "0.1.0");
});

test("focal coordinates are validated before an API request", async () => {
  await assert.rejects(() => execute(["focal", "asset-1", "--x", "2", "--y", "0.5"], { STEADYLINK_API_KEY: "test" }), /between 0 and 1/);
});
