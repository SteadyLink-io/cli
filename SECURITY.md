# Security

Please report security issues privately to security@steadylink.io. Do not open a public issue for a suspected vulnerability.

The CLI reads API credentials from `--api-key`, `STEADYLINK_API_KEY`, or the file written by `steadylink login`. That file is created with owner-only permissions; `steadylink logout` removes it.
