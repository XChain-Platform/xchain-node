<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform Node

<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.14-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-1148%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20e2e%20%7C%20fuzz%20%7C%20chaos%20%7C%20mutation%20%7C%20boundary%20%7C%20smoke%20%7C%20security%20%7C%20performance%20%7C%20regression-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
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

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
