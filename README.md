<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025–2026 Dankest, LLC -->

# XChain Platform Node

<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.15-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-1148%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20boundary%20%7C%20smoke%20%7C%20security%20%7C%20performance%20%7C%20regression-brightgreen" alt="Coverage">
</p>

CLI management and orchestration tool for the XChain Platform. Installs, configures, and manages all XChain services and coin nodes (bitcoind, litecoind, dogecoind) as Docker containers. Generates per-service environment variables from a two-layer configuration system, manages LevelDB state, provisions MariaDB databases, and provides multi-pane log monitoring.

## Features

- **Multi-chain orchestration** — manages Bitcoin, Litecoin, and Dogecoin across mainnet, testnet, and regtest; each chain/network gets its own Docker network and container set
- **Order-independent argument parsing** — CLI arguments auto-classified as service, coin, network, or branch name regardless of position
- **Docker container lifecycle** — install, start, stop, restart, update, uninstall, and reset services with single commands
- **Configuration generation** — two-layer system (hardcoded defaults + config file overrides) producing 40+ environment variables per service
- **Crypto node management** — downloads Bitcoin Core, Litecoin, and Dogecoin binaries from official sources with SHA-256 verification
- **Database orchestration** — provisions shared MariaDB, creates per-service databases and users with subnet-based permissions
- **Bootstrap snapshots** — create and restore gzipped snapshots of UTXO tracker, decoder, and indexer data with SHA-256 integrity verification
- **Multi-pane monitoring** — Blessed terminal UI showing live logs from up to 6 containers in split-screen
- **Pre-flight checks** — Docker verification, directory creation, LevelDB open, remote version fetch, Docker network creation
- **State persistence** — LevelDB maps each module to its 64-char container ID via composite keys
- **execFile security** — all child process calls use `execFile` with array arguments, eliminating shell injection
- **Input validation** — branch name, port, and container ID validation with strict regex enforcement
- **1,148 tests** — unit, integration, e2e, smoke, boundary, security, fuzz, chaos, performance, mutation, and regression testing

## Documentation

Full xchain-node documentation is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/node) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/node/README.md) | Overview, features, installation, quick start, scripts, dependencies |
| [Architecture](https://github.com/XChain-platform/xchain-documentation/blob/master/components/node/ARCHITECTURE.md) | Data pipeline position, internal components, source files, runtime directory structure |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/node/CONFIGURATION.md) | Config file system, generated environment variables, naming conventions, internal constants |
| [Operations](https://github.com/XChain-platform/xchain-documentation/blob/master/components/node/OPERATIONS.md) | CLI commands reference, global options, parameters, troubleshooting |

## Quick Start

```bash
git clone https://github.com/XChain-platform/xchain-node.git
cd xchain-node
npm install
npm link
```

Install all services for Bitcoin regtest:

```bash
xchain_node install master all bitcoin regtest
```

Check status:

```bash
xchain_node ps
```

Start/stop:

```bash
xchain_node stop all bitcoin regtest
xchain_node start all bitcoin regtest
```

### Run a validator

By default the bundled `xchain-hub` runs as a standalone config oracle. To run it
as a full validator (P2P + PBFT + capability staking), generate a validator
identity first — this is offline and needs no running stack:

```bash
xchain_node validator init \
  --seed-nodes seed1.example:10001,seed2.example:10001 \
  --p2p-addr <your-public-host>:10001 \
  --oracle-epoch-start <shared-federation-unix-ms> \
  --capabilities price,cross_chain,oracle_publish,attestation
```

It generates an Ed25519 signing key (saved `0600` under `config/validator/`),
prints the **pubkey to stake XCHAIN to**, and writes a starter `capabilities.json`.
Edit that file to set real `cross_chain` RPC endpoints and `oracle_publish` DOGE
values, then install/start the hub — it now boots in validator mode with your key
and capability config mounted automatically:

```bash
xchain_node install master xchain-hub
xchain_node validator status      # show pubkey, peers, capabilities
```

## Host environment variables

Five env vars override where xchain-node stores its filesystem state. Set them in the shell or systemd unit before running `xchain-node install`. Each falls back to a path inside this repo if unset, so existing installs are unaffected.

| Variable | What goes here |
|---|---|
| `XCHAIN_NODE_DATA_DIR` | Per-coin state + bootstrap output archives (tens to hundreds of GB) |
| `XCHAIN_NODE_TMP_DIR` | Bootstrap inner work archives (tens of GB during bootstrap ops) |
| `XCHAIN_NODE_MODULES_DIR` | Git clones of sibling xchain-* repos |
| `XCHAIN_NODE_CRYPTO_NODES_DIR` | Downloaded coin-node binaries |
| `XCHAIN_NODE_CONFIG_DIR` | Generated per-service `.env` files |

On boxes with a small `/` partition and a large data volume (e.g., OVH RISE-3 with `/misc`), point `DATA_DIR` and `TMP_DIR` at the large volume before installing. Full docs in [CONFIGURATION.md](https://github.com/XChain-platform/xchain-documentation/blob/master/components/node/CONFIGURATION.md).

### Bundled MariaDB tuning

When xchain-node manages its own MariaDB container, these optional env vars override server defaults. They are applied as `mysqld` startup args at install time, so they **persist across a container recreate** (a `conf.d` file edited inside a running container does not). Each is unset by default — image defaults unchanged. Set them before `xchain-node install`.

| Variable | mysqld setting | When to set |
|---|---|---|
| `XCHAIN_NODE_DB_DATA_DIR` | datadir bind-mount (`-v <dir>:/var/lib/mysql`) | Pin the datadir to a fast NVMe mount instead of the Docker data-root |
| `XCHAIN_NODE_DB_BUFFER_POOL_SIZE` | `innodb-buffer-pool-size` (e.g. `16G`) | Large/multi-DB hosts — the stock 128 MB thrashes on multi-GB datasets |
| `XCHAIN_NODE_DB_MAX_CONNECTIONS` | `max-connections` (e.g. `300`) | Many connection pools against one DB (replicas, shared services) |
| `XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT` | `innodb-flush-log-at-trx-commit` (e.g. `2`) | Replica/cache DBs where a 1-second crash window is acceptable for speed |

## Telemetry

`xchain-node` sends an anonymous usage ping (xchain-node + service versions, which services are running, basic OS/Docker info). Your **IP address is never sent or stored** — the receiver derives only a coarse country/region and an anonymous one-way network hash from the connection, then discards the IP. It contains **no** secrets, wallet data, addresses, or config. It is **on by default**, sent only on install/update and at most once per day otherwise, and never blocks a command.

Turn it off with any of: `--no-telemetry` on any command (sticks for future runs), `XCHAIN_NODE_NO_TELEMETRY=1`, or `"optOut": true` in `~/.xchain-node/telemetry.json`. Point at a different collector with `XCHAIN_NODE_TELEMETRY_URL`. Full details: [Privacy & Telemetry](https://github.com/XChain-platform/xchain-documentation/blob/master/operations/TELEMETRY.md).

## Scripts

| Command | Description |
|---|---|
| `npm test` | Unit tests (373 tests) |
| `npm run test:integration` | Integration tests (103 tests) |
| `npm run test:smoke` | Smoke tests (159 tests) |
| `npm run test:e2e` | End-to-end tests (57 tests) |
| `npm run test:fuzz` | Fuzz tests (256 tests) |
| `npm run test:chaos` | Chaos engineering tests (140 tests) |
| `npm run test:regression` | Regression tests (60 tests) |
| `npm run test:regression:p0` | Regression P0 — critical gate (28 tests) |
| `npm run test:regression:p0p1` | Regression P0+P1 — standard gate (52 tests) |
| `npm run test:mutation` | Mutation testing (Stryker Mutator) |
| `npm run test:all` | All tests (~1,148 tests) |
| `npm run benchmark` | Performance benchmarks (6 scenarios) |
| `npm run benchmark:quick` | Quick benchmarks |

## Test Suite

| Type | Tests | Description |
|---|---|---|
| Unit — Core | 143 | `ConfigService.test.js`, `DockerService.test.js`, `LevelUpDb.test.js`, `state.test.js`, `helpers.test.js` — path helpers, naming, config generation, Docker commands, LevelDB CRUD, state singletons, utility functions |
| Unit — Services | 72 | `ModuleService.test.js`, `DatabaseService.test.js`, `VersionService.test.js`, `ExplorerConnector.test.js`, `GitHubDownloader.test.js`, `HubConnector.test.js` — clone, build, install/uninstall, DB setup, version checks, RPC clients |
| Unit — Operations | 38 | `moduleOperations.test.js` — install/update/uninstall/start/stop/restart/exec/shell/log/monitor bulk operations |
| Unit — Security | 60 | `security.test.js` — shell injection prevention (execFile), container ID validation, NODE_PREFIX validation, branch name validation, path traversal, database command safety, source code scanning |
| Unit — Boundary | 60 | `boundary.test.js` — config file parsing edge cases (values with `=`, base64, empty, blank lines), resolveArgs boundaries, filterCommandParameters, LevelDB key format |
| Integration | 103 | 8 files — config pipeline, Docker commands, module lifecycle (LevelDB), status queries, hub/explorer config, database setup, network management, multi-module orchestration |
| Smoke | 159 | 10 scenarios — module imports, CLI registration, global options, constants/enums, config templates, config composition, Docker exports, parameter expansion, state init, Dockerfiles |
| E2E | 57 | 8 scenarios — install lifecycle, multi-coin, config overrides, precheck, update flow, reset, error handling, exec/logs |
| Fuzz | 256 | 8 harnesses — port validation, resolveArgs, config parsing, command construction, env escaping, branch validation, filter params, container ID |
| Chaos | 140 | 7 files — download resilience, LevelDB resilience, config resilience, Docker resilience, git clone resilience, process resilience, network resilience |
| Regression | 60 | Three-tier suite: P0 critical (28), P1 high (24), P2 standard (8) — argument parsing, config generation, Docker commands, security, lifecycle, state, E2E workflows |
| Performance | 6 scenarios | Config generation, filter params, LevelDB operations, config parsing scale, resolveArgs, naming helpers |
| Mutation | 2 configs | Full service and ConfigService-only pilot via Stryker Mutator |
| **Total** | **1,148** | |

---

**Copyright &copy; 2025–2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/licensing).

## License

XChain Platform is **open source**, dual-licensed under:

- the **[GNU Affero General Public License v3.0](./LICENSE.md)** (`AGPL-3.0-or-later`) — free for everyone, and
- a **[commercial license](https://docs.xchain.io/legal/commercial-license)** for companies that need to keep modifications private.

See the **[licensing overview](https://docs.xchain.io/legal/licensing)** for which one applies to you. "XChain" is a trademark of Dankest, LLC — see the **[Trademark Policy](https://docs.xchain.io/legal/trademark)**.

Copyright © 2025–2026 Dankest, LLC.
