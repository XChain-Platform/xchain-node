# Kaspa node release assets and hashes (xchain-node / crypto_nodes/kaspa)

> Rule: only hashes computed locally are recorded. Anything else is marked `TODO` and the downloader
> refuses to run (fail-closed) rather than inventing a hash to make things work.

## Target version

`kaspanet/rusty-kaspa` **v2.1.0** (released 2026-09-22; confirmed locally as `kaspad v2.1.0`)

## Assets and hashes

| Platform | Asset | sha256 | Status |
|---|---|---|---|
| linux-amd64 | `rusty-kaspa-v2.1.0-linux-amd64.zip` | — | **TODO** (TLS to that CDN failed locally: `curl exit=35`) |
| win64 | `rusty-kaspa-v2.1.0-win64.zip` | `fb25743a4b432d376c4ca49d8799769dbc6d5b070f0b502350ce32cfdb38ec0f` | computed locally with `sha256sum` |
| osx | `rusty-kaspa-v2.1.0-osx.zip` | — | **TODO** |

**Command to fill a hash in** (run on a machine that can reach GitHub, then paste into `ASSETS` in `kaspa_node.js`):

```bash
curl -LO https://github.com/kaspanet/rusty-kaspa/releases/download/v2.1.0/rusty-kaspa-v2.1.0-linux-amd64.zip
sha256sum rusty-kaspa-v2.1.0-linux-amd64.zip
```

## Relationship to `src/github_hashes.json`

That file's shape is `owner/repo -> version -> { x86_64, aarch64 }`, where **`x86_64` means Linux**.
Only the win64 hash was computed here; putting it under `x86_64` would misrepresent a Windows
archive as a Linux one, so `src/github_hashes.json` is left untouched until the Linux hash lands.

## Archive layout (measured)

The release archive is **flat**: unpacking yields the executables directly (Windows included):

```
kaspad(.exe)          full node
kaspa-wallet(.exe)    interactive CLI wallet (REPL; `--help` enters the REPL, so scripting must feed stdin)
rothschild(.exe)      transaction generator / load tool (supports testnet and devnet only, not simnet)
stratum-bridge(.exe)  stratum bridge for pools
```

`crypto_nodes/kaspa/Dockerfile` relies on that flat layout: it copies ./kaspa and installs kaspad and kaspa-wallet.
