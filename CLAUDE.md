# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the CLI (requires Docker to be running)
node src/index.js --help
node src/index.js -i                              # interactive mode
node src/index.js ps                              # list installed services
node src/index.js install master node bitcoin mainnet
node src/index.js start node bitcoin mainnet
node src/index.js tail node bitcoin mainnet
node src/index.js logs node bitcoin mainnet
node src/index.js shell node bitcoin mainnet
node src/index.js bootstrap create xchain-decoder bitcoin mainnet

# Install as global CLI
npm install -g .
xchain_node --help
```

There are no automated tests and no build step. The app runs directly with Node.js.

## Architecture

This is a Node.js CLI tool (CommonJS, no ESM) that manages Docker containers for XChain platform blockchain services (Bitcoin, Dogecoin, Litecoin). Every command runs against Docker via `child_process.exec`.

### Entry flow

```
src/index.js          → loads dotenv, calls parseCommand()
src/cli.js            → Commander setup, defines all commands
src/precheck.js       → runs before every command: checks Docker, creates dirs,
                         opens LevelDB, fetches remote versions, ensures hub is running
```

### Key concepts

**Services list** (`filterCommandParameters` in `ConfigService.js`): CLI arguments (service, chain, network) are expanded into a nested object `{ coin: { network: [modules] } }` that bulk operations iterate over.

**Module lifecycle**: `installModule` in `ModuleService.js` handles all module types:
- `node` → downloads crypto node binary, builds Docker image via `NodeService`
- `database` → MariaDB container via `DatabaseService`
- `xchain-explorer` → special install via `ExplorerService`
- All other XChain services → `cloneGit` (SSH from GitHub) then `buildAndUp` (docker build + docker run)

**Container tracking**: Container IDs are stored in LevelDB (`LevelUpDb.js`) with key format `MC{module};{coin};{network}`. The `db` singleton is in `state.js`.

**Status cache**: `StatusService.getStatus()` queries `docker inspect` for every tracked container and caches the result in module-level state. `statusChanged()` invalidates the cache and re-notifies hub/explorer.

**Circular dependencies**: Resolved with lazy `require()` inside function bodies in `StatusService`, `ModuleService`, and `NodeService`.

### Directory layout at runtime

```
project root/
├── src/              ← source code
├── modules/          ← cloned XChain service repos (git clones land here)
├── tmp/              ← temporary git clones for version checks
├── crypto_nodes/     ← blockchain node binaries and Dockerfiles
│   ├── bitcoin/      ← contains bitcoin-{network}.conf files + downloaded binary
│   ├── dogecoin/
│   └── litecoin/
├── data/             ← LevelDB + blockchain data volumes
└── config/           ← per-coin-network config overrides (e.g. bitcoin-mainnet)
```

### Service map

| Argument name       | Module constant              | Description                        |
|---------------------|------------------------------|------------------------------------|
| `node`              | `NODE_MODULE_NAME`           | The blockchain full node           |
| `database`          | `DB_MODULE_NAME`             | MariaDB container                  |
| `xchain-hub`        | `HUB_MODULE_NAME`            | JSON-RPC hub (auto-installed)      |
| `xchain-encoder`    | `XChainService.XCHAIN_ENCODER`  | Transaction encoder              |
| `xchain-decoder`    | `XChainService.XCHAIN_DECODER`  | Block decoder                    |
| `xchain-utxo-tracker` | `XChainService.XCHAIN_UTXO_TRACKER` | UTXO state tracker         |
| `xchain-indexer`    | `XChainService.XCHAIN_INDEXER`  | Blockchain indexer               |
| `xchain-explorer`   | `EXPLORER_MODULE_NAME`       | Web block explorer (auto-updated)  |

### Docker naming conventions

- Docker network: `xchain-node[-{coin}[-{network}]]`
- Container image/hostname: `xchain-node[-{coin}-{network}]-{module}`
- `NODE_PREFIX` env var overrides `xchain-node` prefix (set in `.env`)

### Conventions

- CommonJS (`require`/`module.exports`) — no ESM
- All async work uses `async/await`; `new Promise(async ...)` anti-pattern has been removed
- Lazy `require()` inside function bodies is intentional (resolves circular deps — do not refactor away)
- LevelDB for container ID metadata; MariaDB (inside Docker) for XChain service data
- `src/util.js` is legacy code kept for reference; `src/utils/helpers.js` is the active utilities file
- XChain services are cloned via SSH (`git@github.com:XChain-platform/...`) — SSH key must be configured
