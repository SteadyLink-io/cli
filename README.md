# SteadyLink CLI

Upload files to SteadyLink, replace them without breaking their links, and print signed or resized links from a terminal or CI job. Built on [`@steadylink/sdk`](https://www.npmjs.com/package/@steadylink/sdk).

```bash
npx steadylink login                 # or: npm install -g @steadylink/cli
npx steadylink upload ./hero.webp --bucket marketing --public
# hero.webp  https://cdn.steadylink.io/a/3f2a...
```

Requires Node.js 18+.

## Commands

| Command | What it does |
| --- | --- |
| `steadylink login [--api-key <key>] [--bucket <default>]` | Verifies the key and saves it (prompts when no key is given; `--stdin` reads it from a pipe). |
| `steadylink logout` | Removes the saved key. |
| `steadylink upload <files or folders...> [--bucket] [--folder] [--public \| --private]` | Uploads files and prints one stable link per file. Folders keep their structure. |
| `steadylink replace <asset-id \| link \| bucket:key> <file>` | Publishes a new revision. The link does not change. |
| `steadylink ls [bucket[:folder/]]` | Lists buckets, or the files in a bucket folder. |
| `steadylink link <asset-id> [--w --h --fm --q --fit --revision]` | Prints a delivery link with optional transforms. |
| `steadylink link <asset-id> --signed [--ttl 3600] [--name label]` | Prints an expiring, revocable link for a private file. |
| `steadylink rm <asset-id \| bucket:key> [--yes]` | Deletes a file and every revision. Asks first unless `--yes`. |
| `steadylink versions <asset-id>` | Lists revisions (`*` marks the current one). |
| `steadylink rollback <asset-id> <version>` | Makes an older revision current again. |
| `steadylink inspect <asset-id>` | Prints file details as JSON. |
| `steadylink focal <asset-id> --x 0.5 --y 0.5` | Sets the smart-crop focal point. |

Buckets can be given by ID, slug, or name. `bucket:key` addresses a file by path, for example `marketing:campaign/hero.webp`.

## Global options

| Option | Description |
| --- | --- |
| `--json` | Print machine-readable JSON to stdout. Progress is suppressed. |
| `-q`, `--quiet` | Hide progress output. |
| `--api-key <key>` | Use a key for this command only. |
| `--api-url <url>` | API origin (default `https://api.steadylink.io`). |
| `--cdn-url <url>` | Delivery origin for printed links, for example a custom domain. |

Upload-only: `--no-wait` (return before processing finishes; links may be missing), `--via api` (stream through the API when the storage host is blocked), `--concurrency <n>` (default 4).

Progress goes to stderr, results to stdout, so `steadylink upload a.png --json | jq -r '.[].url'` works.

## Credentials

Resolution order: `--api-key`, then `STEADYLINK_API_KEY`, then the saved login. `steadylink login` writes `config.json` with owner-only permissions to:

- `$STEADYLINK_CONFIG` when set
- `%APPDATA%\steadylink\config.json` on Windows
- `$XDG_CONFIG_HOME/steadylink/config.json` or `~/.config/steadylink/config.json` elsewhere

Other environment variables: `STEADYLINK_API_URL`, `STEADYLINK_CDN_URL`, `STEADYLINK_BUCKET` (default bucket).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | API, network, or file error |
| 2 | Invalid usage (missing argument, unknown command, `rm` without `--yes` in a script) |
| 3 | Not logged in, or the key was rejected (401/403) |
| 4 | Some files in an upload failed (the others still succeeded) |

## Examples

```bash
# Deploy a folder and collect links
steadylink upload ./dist/assets --bucket web --folder "releases/$GITHUB_SHA" --json > links.json

# Swap a PDF that is already linked from emails and QR codes
steadylink replace marketing:docs/price-list.pdf ./price-list-2026.pdf

# Share a private file for one day
steadylink link 3f2a... --signed --ttl 86400 --name "Acme review"

# Undo a bad replacement
steadylink versions 3f2a...
steadylink rollback 3f2a... 3
```

For GitHub Actions, see [SteadyLink Upload](https://github.com/SteadyLink-io/upload-action).

## License

[MIT](LICENSE)
