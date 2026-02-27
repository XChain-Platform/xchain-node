# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`xchain-node` is a Node.js CLI tool that installs, configures, and manages XChain platform services running as Docker containers. It handles downloading XChain service modules from GitHub, building Docker images, managing MariaDB, and orchestrating a suite of blockchain processing services across multiple coins and networks.

## Running the CLI

```bash
# Direct invocation
node src/index.js <command> [args]

# Via symlink (after installation per INSTALL.md)
xchain-node <command> [args]
```

No build step required. Dependencies: `npm install`

## CLI Commands

```
xchain-node install   <branch>         <service> [chain] [network]
xchain-node uninstall                  <service> [chain] [network]
xchain-node update                     <service> [chain] [network]
xchain-node ps
xchain-node start                      <service> [chain] [network]
xchain-node stop                       <service> [chain] [network]
xchain-node restart                    <service> [chain] [network]
xchain-node tail                       [service] [chain] [network]
xchain-node logs                       [service] [chain] [network]
xchain-node monitor                    [service] [chain] [network]
xchain-node tailmonitor                [service] [chain] [network]
xchain-node exec                       <service> <chain> <network> <command>
xchain-node shell                      <service> <chain> <network>
xchain-node bootstrap <create|restore> <service> <chain> <network>
xchain-node -i   # interactive TUI mode
xchain-node --no-bootstrap   # skip downloading bootstrap files (force full parse)
xchain-node --no-explorer    # skip xchain-explorer installation
```

Valid values: service=`(node, xchain-encoder, xchain-decoder, xchain-utxo-tracker, xchain-indexer, xchain-hub, xchain-explorer, database, all)`, chain=`(bitcoin, dogecoin, litecoin, all)`, network=`(mainnet, testnet, regtest, all)`

## Architecture

### Entry Flow

```
src/index.js      → loads dotenv, calls parseCommand()
src/cli.js        → Commander setup, defines all commands, preAction hook
src/precheck.js   → runs before every command: checks Docker, creates dirs,
                     opens LevelDB, fetches remote versions (install/update only),
                     ensures xchain-hub is installed and updated
```

### Core Flow

Every command triggers `preCheck()` before execution, which: verifies Docker is accessible, creates runtime directories (`data/`, `modules/`, `tmp/`), opens the LevelDB database, and ensures `xchain-hub` is installed and updated. Remote version fetching only runs for `install`, `update`, and `reinstall` commands.

### Service Architecture

All XChain services run as Docker containers on named Docker networks. Services communicate via JSON-RPC over HTTP. The hub (`xchain-hub` on port 10000) is the coordination layer; the explorer (`xchain-explorer` on ports 18080/18081) is the web frontend.

**Coin-specific services** (per coin+network combination):
- `node` — the crypto node itself (Bitcoin/Dogecoin/Litecoin daemon)
- `xchain-encoder` — transaction encoding
- `xchain-decoder` — transaction decoding (uses MariaDB)
- `xchain-utxo-tracker` — UTXO set tracking
- `xchain-indexer` — block/transaction indexer (uses MariaDB)
- `xchain-regtest-miner` — regtest-only mining service
- `xchain-e2e-test` — regtest-only end-to-end tests

**Shared services** (no coin/network scope):
- `database` — MariaDB container, shared across all coin/network stacks
- `xchain-hub` — orchestration hub
- `xchain-explorer` — block explorer web UI

### Service Map

| Argument name         | Module constant                       | Description                   |
|-----------------------|---------------------------------------|-------------------------------|
| `node`                | `NODE_MODULE_NAME`                    | The blockchain full node      |
| `database`            | `DB_MODULE_NAME`                      | MariaDB container             |
| `xchain-hub`          | `HUB_MODULE_NAME`                     | JSON-RPC hub (auto-installed) |
| `xchain-encoder`      | `XChainService.XCHAIN_ENCODER`        | Transaction encoder           |
| `xchain-decoder`      | `XChainService.XCHAIN_DECODER`        | Block decoder                 |
| `xchain-utxo-tracker` | `XChainService.XCHAIN_UTXO_TRACKER`   | UTXO state tracker            |
| `xchain-indexer`      | `XChainService.XCHAIN_INDEXER`        | Blockchain indexer            |
| `xchain-explorer`     | `EXPLORER_MODULE_NAME`                | Web block explorer            |

### Docker Container Naming

- Coin-specific: `xchain-node-<coin>-<network>-<module>` (e.g., `xchain-node-bitcoin-mainnet-xchain-encoder`)
- Shared: `xchain-node-<module>` (e.g., `xchain-node-xchain-hub`, `xchain-node-database`)
- Docker networks: `xchain-node-<coin>-<network>` per coin stack, plus `xchain-node` base network
- `NODE_PREFIX` env var overrides `xchain-node` prefix (set in `.env`)

### State Storage

`LevelUpDb.js` wraps LevelDB (stored in `data/xchain_node`) to persist module→container ID mappings with key format: `MC<module>;<coin>;<network>`. This is how the CLI finds which container ID corresponds to each installed service. The `db` singleton is in `state.js`.

### Configuration

`getDefaultConfig(module, coin, network)` in `src/services/ConfigService.js` returns a merged config:
1. Hardcoded defaults (ports, URLs, DB names, etc.)
2. Overridden by values from `config/<coin>-<network>` (key=value format)

Config files live in `config/` (e.g., `config/bitcoin-mainnet`) and set things like `NODE_EXPOSED_PORT`, `UTXO_TRACKER_PORT`, `DUST_AMOUNT`.

### Crypto Node Sources

`crypto_nodes/<coin>/` contains a `Dockerfile` and `.conf` files per network (e.g., `bitcoin-mainnet.conf`). `GitHubDownloader.js` fetches verified crypto node binaries from GitHub releases using SHA-256 hashes stored in `src/github_hashes.json`.

### Key Source Files

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point: loads dotenv, calls parseCommand() |
| `src/cli.js` | Commander setup, all command definitions |
| `src/precheck.js` | Pre-command validation and hub setup |
| `src/state.js` | Singletons and shared state |
| `src/services/ConfigService.js` | Config merging, Docker naming helpers |
| `src/services/DockerService.js` | All Docker operations (run, stop, exec, logs, network, monitor) |
| `src/services/ModuleService.js` | Module install/uninstall lifecycle |
| `src/services/StatusService.js` | Container status cache, statusChanged() |
| `src/services/HubService.js` | xchain-hub install and config update |
| `src/services/ExplorerService.js` | xchain-explorer install and config update |
| `src/services/NodeService.js` | Crypto node binary download and Docker build |
| `src/services/VersionService.js` | Remote version checks from GitHub |
| `src/HubConnector.js` | JSON-RPC client for xchain-hub (`ping`, `updateconfig`) |
| `src/ExplorerConnector.js` | JSON-RPC client for xchain-explorer (`ping`) |
| `src/LevelUpDb.js` | LevelDB CRUD for module-container mappings |
| `src/GitHubDownloader.js` | Downloads and SHA-256-verifies crypto node binaries |
| `src/github_hashes.json` | Trusted SHA-256 hashes for downloaded binaries |

### Runtime Directories (git-ignored)

- `modules/` — cloned XChain service repos (source for Docker builds)
- `tmp/` — temporary clone dirs used during installs/updates; `tmp/containers_files/` for `docker cp` staging
- `data/` — LevelDB database and bootstrap snapshot files
- `crypto_nodes/` — blockchain node binaries and Dockerfiles

## Conventions

- CommonJS (`require`/`module.exports`) — no ESM
- All async work uses `async/await`; `new Promise(async ...)` anti-pattern has been removed
- Lazy `require()` inside function bodies is intentional (resolves circular deps — do not refactor away)
- LevelDB for container ID metadata; MariaDB (inside Docker) for XChain service data
- `src/utils/helpers.js` is the active utilities file (`sleep`, `stringToCoin`, `decompressTarGz`)
- XChain services are cloned via SSH (`git@github.com:XChain-platform/...`) — SSH key must be configured
