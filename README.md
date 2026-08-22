# SteadyLink CLI

The official command line interface for [SteadyLink](https://steadylink.io). Upload files and directories, replace a live file without changing its URL, inspect assets, and set image focal points from a terminal or CI job.

## Requirements

- Node.js 20 or newer
- A SteadyLink workspace API key

Create a scoped API key in **Dashboard → Developers**. Use `assets:read` for inspection and `assets:write` for uploads, replacements, and focal points.

## Install

```sh
npm install --global @steadylink/cli
```

You can also run it without installing:

```sh
npx @steadylink/cli --help
```

## Authenticate

Keep the API key in your environment rather than shell history:

```sh
export STEADYLINK_API_KEY="slk_..."
```

The CLI also accepts `--api-key` for temporary use and `STEADYLINK_API_URL` when targeting a development environment.

## Commands

List the buckets available to the key:

```sh
steadylink buckets
```

Upload one file or a complete directory tree:

```sh
steadylink upload ./campaign/hero.webp --bucket <bucket-id>
steadylink migrate ./public --bucket <bucket-id>
```

Directory uploads preserve relative paths, skip symbolic links, and create upload batches of up to 100 files.

Replace a file while keeping its SteadyLink URL:

```sh
steadylink replace ./hero-v2.webp \
  --bucket <bucket-id> \
  --key campaign/hero.webp
```

Inspect an asset or set its image focal point:

```sh
steadylink inspect <asset-id>
steadylink focal <asset-id> --x 0.5 --y 0.35
```

Every successful command writes JSON to stdout. Progress and errors go to stderr, which keeps the CLI suitable for scripts and CI.

## Development

```sh
npm test
npm run check
node ./bin/steadylink.mjs --help
```

## Security

Do not commit API keys or pass them to browser code. Use a secret manager in CI and create a key with only the scopes the job requires.

## License

MIT
