<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform Node

<p align="center">
  <img src="https://img.shields.io/badge/version-0.12.1-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-2%2C652%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20smoke%20%7C%20boundary%20%7C%20security%20%7C%20fuzz%20%7C%20chaos%20%7C%20regression%20%7C%20performance%20%7C%20mutation-brightgreen" alt="Coverage">
</p>

CLI management and orchestration tool for the XChain Platform. Installs, configures, and manages all XChain services and coin nodes (bitcoind, litecoind, and dogecoind today; any Bitcoin-RPC-compatible UTXO chain can be added by configuration) as Docker containers. Generates per-service environment variables from a two-layer configuration system, manages LevelDB state, provisions MariaDB databases, and provides multi-pane log monitoring.

## Features

- **Multi-chain orchestration**: manages Bitcoin, Litecoin, and Dogecoin today across mainnet, testnet, and regtest; each chain/network gets its own Docker network and container set
- **Order-independent argument parsing**: CLI arguments auto-classified as service, coin, network, or branch name regardless of position
- **Docker container lifecycle**: install, start, stop, restart, update, uninstall, and reset services with single commands
- **Configuration generation**: two-layer system (hardcoded defaults + config file overrides) producing 40+ environment variables per service
- **Crypto node management**: downloads the Bitcoin Core, Litecoin, and Dogecoin binaries (the chains supported today) from official sources with SHA-256 verification; includes per-chain regtest tuning applied automatically
- **Database orchestration**: provisions shared MariaDB, creates per-service databases and users with subnet-based permissions
- **Bootstrap snapshots**: create and restore gzipped snapshots of UTXO tracker, decoder, and indexer data; integrity is double-verified with SHA-256 checksums and a detached Ed25519 signature pinned to a bundled public key
- **Validator mode**: `validator init` generates an Ed25519 signing key and capabilities config; the hub boots in PBFT validator mode when a key is present
- **Anonymous telemetry**: opt-out usage ping reports service versions and running module set; IP is never stored; respects `--no-telemetry`, env var, or preference file
- **Multi-pane monitoring**: Blessed terminal UI showing live logs from up to 6 containers in split-screen
- **Pre-flight checks**: Docker verification, directory creation, LevelDB open, remote version fetch, Docker network creation, and stale container-registry GC on every command
- **Go-live gate**: asserts safe launch settings together at the one chokepoint every service deploy passes through; warns pre-launch, refuses a mainnet write surface once `XCHAIN_NODE_GO_LIVE=1` is set (escape hatch: `XCHAIN_NODE_SKIP_GO_LIVE_GATE=1`, logged loudly)
- **Skew guard**: refuses an `update` that would deploy a downstream module (e.g. the indexer) past the hub version it requires, per a `xchainRequiresHub` minimum-semver field in the module's own `package.json`
- **Container auto-discovery**: rebuilds the module-to-container-ID registry from `docker ps -a` when it drifts from LevelDB state, since container names deterministically encode module/coin/network
- **Credentials persistence**: accepted MariaDB root passwords persist per-OS-user to `~/.xchain-node/credentials.json` (0600), ping-verified and reused as a non-interactive fallback
- **State persistence**: LevelDB maps each module to its 64-char container ID via composite keys
- **execFile security**: all child process calls use `execFile` with array arguments, eliminating shell injection
- **Input validation**: branch name, port, and container ID validation with strict regex enforcement
- **1,636+ tests**: unit, integration, e2e, smoke, boundary, security, fuzz, chaos, regression, performance, and mutation testing

## Documentation

Full xchain-node documentation is available in the [xchain-documentation](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/node) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/node/README.md) | Overview, features, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/node/architecture.md) | Data pipeline position, internal components, source files, runtime directory structure |
| [Configuration](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/node/configuration.md) | Config file system, generated environment variables, naming conventions, internal constants |
| [Operations](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/node/operations.md) | CLI commands reference, global options, parameters, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-Platform/xchain-node.git
cd xchain-node
npm install
npm link
```

Install all services for Bitcoin regtest:

```bash
xchain-node install master all bitcoin regtest
```

Check status:

```bash
xchain-node ps
```

Start/stop:

```bash
xchain-node stop all bitcoin regtest
xchain-node start all bitcoin regtest
```

### Run a validator

By default the bundled `xchain-hub` runs as a standalone config oracle. To run it
as a full validator (P2P + PBFT + capability staking), generate a validator
identity first. This is offline and needs no running stack:

```bash
xchain-node validator init --network testnet --p2p-addr <your-public-host>:10002
```

It generates an Ed25519 signing key, a BTC **stake wallet** and a DOGE
**publisher wallet** (all `0600` under `config/validator/`, git-ignored), prints
the **pubkey to stake XCHAIN to** and the **two addresses to fund**, and writes
`capabilities.json` under `config/validator/hub-caps/` already pointed at the
DOGE wallet, plus the signer module the hub loads to publish price rounds and
anchors from it. Seed nodes, network and the testnet oracle epoch default to
the federation's values. To use keys you already hold (a vanity address, say),
add `--import-stake-key` / `--import-doge-key`; each prompts for the WIF with
echo off.

Fund the two addresses, then stake and start:

```bash
xchain-node validator stake              # dry run: balances and the plan
xchain-node validator stake --broadcast  # mints XCHAIN on testnet if short, then STAKEs
xchain-node install master xchain-hub    # boots in validator mode, signer mounted
xchain-node validator status             # pubkey, network, wallets, peers, capabilities
```

The full walkthrough, including the BTC indexer the hub needs and how to verify
membership on the explorer, is `xchain-documentation/operations/run-a-validator.md`.

## Host environment variables

Five env vars override where xchain-node stores its filesystem state. Set them in the shell or systemd unit before running `xchain-node install`. Each falls back to a path inside this repo if unset, so existing installs are unaffected.

| Variable | What goes here |
|---|---|
| `XCHAIN_NODE_DATA_DIR` | Per-coin state + bootstrap output archives (tens to hundreds of GB) |
| `XCHAIN_NODE_TMP_DIR` | Bootstrap inner work archives (tens of GB during bootstrap ops) |
| `XCHAIN_NODE_MODULES_DIR` | Git clones of sibling xchain-* repos |
| `XCHAIN_NODE_CRYPTO_NODES_DIR` | Downloaded coin-node binaries |
| `XCHAIN_NODE_CONFIG_DIR` | Generated per-service `.env` files |

On boxes with a small `/` partition and a large data volume (e.g., OVH RISE-3 with `/misc`), point `DATA_DIR` and `TMP_DIR` at the large volume before installing. Full docs in [CONFIGURATION.md](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/node/configuration.md).

### Bundled MariaDB tuning

When xchain-node manages its own MariaDB container, these optional env vars override server defaults. They are applied as `mysqld` startup args at install time, so they **persist across a container recreate** (a `conf.d` file edited inside a running container does not). Each is unset by default so image defaults remain unchanged. Set them before `xchain-node install`.

| Variable | mysqld setting | When to set |
|---|---|---|
| `XCHAIN_NODE_DB_DATA_DIR` | datadir bind-mount (`-v <dir>:/var/lib/mysql`) | Pin the datadir to a fast NVMe mount instead of the Docker data-root |
| `XCHAIN_NODE_DB_BUFFER_POOL_SIZE` | `innodb-buffer-pool-size` (e.g. `16G`) | Large/multi-DB hosts where the stock 128 MB thrashes on multi-GB datasets |
| `XCHAIN_NODE_DB_MAX_CONNECTIONS` | `max-connections` (e.g. `300`) | Many connection pools against one DB (replicas, shared services) |
| `XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT` | `innodb-flush-log-at-trx-commit` (e.g. `2`) | Replica/cache DBs where a 1-second crash window is acceptable for speed |

## Autoheal (restart-on-unhealthy)

Every persistent service container carries a Docker healthcheck, but Docker itself takes no action on the `unhealthy` state (`--restart unless-stopped` only fires when the process exits). An alive-but-stalled service would otherwise stay wedged until an operator notices it in `docker ps`. `xchain-node autoheal` closes that loop: it restarts containers that have been continuously unhealthy past a grace window, for services opted in via `autoheal: true` in the healthcheck table (currently the decoder, encoder, and indexer; the utxo-tracker is deliberately excluded because it halts on purpose rather than exiting, and a restart would just re-halt it).

The command is one-shot and never prompts or daemonizes. Unattended remediation requires wiring it to a cron entry or systemd timer, e.g. `*/5 * * * * xchain_node autoheal`. Detection-to-restart latency is the timer interval plus the health retry budget plus the grace window. Use `--dry-run` to see restart candidates without acting. Exit code is non-zero only when a restart was attempted and failed.

| Variable | Default | What it controls |
|---|---|---|
| `XCHAIN_NODE_AUTOHEAL_GRACE_MS` | `120000` | How long a container must be continuously unhealthy before a restart is considered |
| `XCHAIN_NODE_AUTOHEAL_COOLDOWN_MS` | `600000` | Minimum time between two autoheal restarts of the same container (anti-flap) |
| `XCHAIN_NODE_AUTOHEAL_STATE_DIR` | `~/.xchain-node` | Where the anti-flap state file (`autoheal-state.json`) lives |

## Telemetry

`xchain-node` sends an anonymous usage ping (xchain-node + service versions, which services are running, basic OS/Docker info). Your **IP address is never sent or stored**: the receiver derives only a coarse country/region and an anonymous one-way network hash from the connection, then discards the IP. It contains **no** secrets, wallet data, addresses, or config. It is **on by default**, sent only on install/update and at most once per day otherwise, and never blocks a command.

Turn it off with any of: `--no-telemetry` on any command (sticks for future runs), `XCHAIN_NODE_NO_TELEMETRY=1`, or `"optOut": true` in `~/.xchain-node/telemetry.json`. Point at a different collector with `XCHAIN_NODE_TELEMETRY_URL`. Full details: [Privacy & Telemetry](https://github.com/XChain-Platform/xchain-documentation/blob/master/operations/telemetry.md).

## Scripts

| Command | Description |
|---|---|
| `npm test` | Unit tests (1,759 tests) |
| `npm run test:integration` | Integration tests (103 tests) |
| `npm run test:smoke` | Smoke tests (159 tests) |
| `npm run test:boundary` | Boundary condition tests (57 tests) |
| `npm run test:security` | Security tests (74 tests) |
| `npm run test:e2e` | End-to-end tests (57 tests) |
| `npm run test:fuzz` | Fuzz tests (264 tests) |
| `npm run test:chaos` | Chaos engineering tests (121 tests) |
| `npm run test:regression` | Regression tests (58 tests) |
| `npm run test:regression:p0` | Regression P0: critical gate (33 tests) |
| `npm run test:regression:p0p1` | Regression P0+P1: standard gate (51 tests) |
| `npm run test:mutation` | Mutation testing (Stryker Mutator) |
| `npm run test:all` | All tests (~2,521 tests; excludes security/boundary) |
| `npm run benchmark` | Performance benchmarks (5 scenarios) |
| `npm run benchmark:quick` | Quick benchmarks |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit | 1,084 | 37 files: config generation, Docker/module orchestration, database, credentials, bootstrap + signing, validator, telemetry, autoheal, discovery, go-live/skew guards, precheck, state, and CLI helpers |
| Integration | 87 | Config pipeline, Docker commands, module lifecycle (LevelDB), status queries, hub/explorer config, database setup, network management, multi-module orchestration |
| Smoke | 50 | Module imports, CLI registration, global options, constants/enums, config templates, config composition, Docker exports, parameter expansion, state init, Dockerfiles |
| Boundary | 57 | Config file parsing edge cases (values with `=`, base64, empty, blank lines), resolveArgs boundaries, filterCommandParameters, LevelDB key format |
| Security | 27 | Shell injection prevention (execFile), container ID validation, NODE_PREFIX validation, branch name validation, path traversal, database command safety, source code scanning |
| E2E | 57 | Install lifecycle, multi-coin, config overrides, precheck, update flow, reset, error handling, exec/logs |
| Fuzz | 95 | Port validation, resolveArgs, config parsing, command construction, env escaping, branch validation, filter params, container ID |
| Chaos | 121 | Download resilience, LevelDB resilience, config resilience, Docker resilience, git clone resilience, process resilience, network resilience |
| Regression | 58 | Three-tier suite: P0 critical (33), P1 high (18), P2 standard (7): argument parsing, config generation, Docker commands, security, lifecycle, state, E2E workflows |
| Performance | 5 scenarios | Config generation, filter params, config parsing scale, resolveArgs, naming helpers |
| Mutation | 2 configs | Full service and ConfigService-only pilot via Stryker Mutator |
| **Total** | **1,636+** | |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/LICENSING.html).
