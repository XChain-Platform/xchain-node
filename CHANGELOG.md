# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `HUB_API_KEY` host-env passthrough to shared-service configs (sync, explorer), so their hub clients authenticate against the keyed sensitive-read tier (`getallconfigs`).

### Fixed
- Probe the regtest miner's Docker healthcheck via `jsonrpc_ping` instead of `http_get` (the miner has no GET `/status` route, so every probe 500'd and the container sat permanently unhealthy).

## [0.0.23] - 2026-06-20

### Added
- `.env.example`: added a configuration template listing the environment variables `xchain-node` reads (directory overrides, managed and external MariaDB settings, telemetry opt-out), with safe defaults and inline comments.

### Changed
- Rename `INDEXER_HOST` to `INDEXER_URL` in `ConfigService.js` and `HubService.js` so it follows the `<SERVICE>_URL` convention used by every other service; string rename only, behavior unchanged.
- Pin `mariadb` to exact version `3.5.2` (drop `^` caret) in `package.json` so every install resolves a byte-identical dependency tree matching `package-lock.json`; no source changes.
- Update the regtest encoder rate-limit key from `RATE_LIMIT_RPM` to `ENCODER_RATE_LIMIT_RPM` in `ConfigService.js`, tracking the encoder's `<SERVICE>_RATE_LIMIT_RPM` naming convention so the regtest high-throughput default stays effective.
- Align the `mariadb` driver range to `^3.5.2` in `package.json`, replacing the stale `~3.4.5` patch-only range and harmonizing with the rest of the platform; no source changes.

### Fixed
- `HubConnector._call()` now records each failed endpoint's URL and error code on `connector.lastFailures` instead of discarding it, so callers receiving `null` can diagnose which endpoints were tried.
- `HubConnector._call()` now reads `err.response.data.result` on a non-2xx throw so a hub with a dead DB pool (HTTP 503 with a valid JSON-RPC body) is surfaced as degraded-but-reachable rather than treated as crashed.
- `HubConnector` now remembers the last responding endpoint and starts each call there (wrapping around), avoiding the full timeout penalty on a degraded first endpoint every call.

### Security
- Move all ten `docker exec`'d MariaDB client invocations off `-p<password>` CLI args onto the `MYSQL_PWD` environment variable via new `dockerMariadbArgs()`/`mariadbEnv()` helpers, so the password is never visible in `/proc/<pid>/cmdline`.
- Validate archive member lists via `assertSafeArchiveMemberNames()` before any tar extraction at all four sites, rejecting absolute paths and `..` traversals; sign bootstrap outer archives with Ed25519 (`XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY`) and verify against a pinned public key at every restore (`XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=1` makes missing signatures fatal).
- SHA-256 verify the Bitcoin Core tarball against digests pinned in `github_hashes.json` (x86_64 + aarch64 for v28.1) before extraction, matching the existing DOGE/LTC verification; fail closed on mismatch or unregistered version/arch.
- Store generated RPC credentials (`NODE_USER`/`NODE_PASSWORD`) in a separate, git-ignored `config/<coin>-<network>.local` sidecar instead of the main config file; `getDefaultConfig()` migrates existing installs automatically on first read.

## [0.0.22] - 2026-05-30

### Fixed
- Create all managed containers (`ModuleService`, `NodeService`, `DatabaseService`) with `--restart unless-stopped` so the platform resumes automatically after a host reboot or Docker daemon restart.

## [0.0.21] - 2026-05-29

### Security
- Pin `tmp` to `>=0.2.3` via an `overrides` entry to remediate GHSA-ph9p-34f9-6g65 and GHSA-52f5-9888-hmc6; `tmp` is only reached through Stryker dev tooling, no runtime impact.

## [0.0.20] - 2026-05-29

### Changed
- Commit `package-lock.json` to the repo (previously git-ignored) so `npm install` resolves the exact tested dependency tree on every fresh install.

## [0.0.19] - 2026-05-29

### Changed
- Skip the `updateconfig` hub round-trip in `preCheck` for read-only commands (`ps`, `tail`, `logs`, `monitor`, `tailmonitor`) to avoid the multi-second sync delay; state-changing commands still push as before.

## [0.0.18] - 2026-05-28

### Security
- Raise the minimum `axios` version from `^1.6.7` to `^1.16.0` to close the path by which a clean install could resolve a pre-1.8.2 release affected by GHSA-q8qp-cvcw-x6jj (credential injection / request hijacking).

## [0.0.17] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry to remediate GHSA-q8mj-m7cp-5q26 (DoS via `qs.stringify` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set).

## [0.0.16] - 2026-05-28

### Added
- Bootstrap restore is now resumable: a re-run reuses an already-extracted `data.tar.gz`/`dump.sql.gz` + checksum pair from the work dir and skips re-verification via a `verify.ok` sentinel, avoiding repeated hours-long extract/verify work.

### Fixed
- Bootstrap restore now opens the MariaDB connection pool before the container lookup so it works when invoked outside the interactive CLI path (previously failed with a misleading "utxo-tracker container not found" error).
- Distinguish "DB pool not initialized" from "no matching row in `modules` table" in the utxo-tracker container-lookup failure path.

## [0.0.15] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [0.0.14] - 2026-04-06

### Added
- Regression test suite (`test/regression/`) with 60 tests across 3 priority tiers (P0/P1/P2) covering argument parsing, configuration generation, Docker command construction, security boundaries, service lifecycle, state integrity, E2E workflows, config parsing boundaries, and utility functions
- `test:regression` npm script for full regression suite execution
- `test:regression:p0` npm script for critical-path P0 tests only (28 tests, <1s)
- `test:regression:p0p1` npm script for P0+P1 high-priority tests (52 tests, <2s)
- Regression tests included in `test:all` pipeline

### Changed
- `README.md`: rewrote from minimal stub to full repo README matching platform conventions: badges, features, documentation links (4 docs: README, Architecture, Configuration, Operations), quick start, scripts table, detailed test suite breakdown with per-file descriptions (1,148 tests), copyright footer

## [0.0.13] - 2026-04-06

### Added
- Mutation testing infrastructure using StrykerJS (`@stryker-mutator/core`, `@stryker-mutator/mocha-runner`)
- Full mutation config (`stryker.config.json`) targeting 8 core source files against unit + integration tests
- Pilot mutation config (`stryker.config.pilot.json`) scoped to ConfigService for Phase 1 rollout
- `test:mutation` npm script for full mutation testing run
- `test:mutation:config` npm script for ConfigService-only pilot run

## [0.0.12] - 2026-04-06

### Fixed
- `buildAndUp()` docker build failure now properly rejects the promise instead of hanging forever, previously called `console.error()` + `return` instead of `reject()`, causing callers to never receive the error (found by chaos engineering tests)

### Changed
- Chaos test `FINDING` tests converted to standard rejection assertions now that the bug is fixed

## [0.0.11] - 2026-04-06

### Added
- Chaos engineering test suite (`test/chaos/`) with 7 test files covering fault injection and resilience validation
- `config-resilience` chaos tests: missing/unreadable config files, malformed content, path traversal, argument parsing injection, port validation edge cases (22 tests)
- `docker-resilience` chaos tests: daemon unavailable (ENOENT, daemon down, permission denied), build/run failures (port conflict, OOM, invalid container ID), network creation failure, invalid inspect JSON, container operations on non-existent containers, file write failures, invalid port config (22 tests)
- `leveldb-resilience` chaos tests: lock contention (non-interactive, lock removal failure), empty/null container IDs, closed database operations, rapid insert/remove cycles, concurrent reads/writes, key collision boundaries, filtered queries at scale (18 tests)
- `git-clone-resilience` chaos tests: network failure, timeout, invalid branch fallback to master, fallback failure, branch validation injection, module directory conflicts, unknown module URLs, useTmp mode (14 tests)
- `download-resilience` chaos tests: GitHub API unreachable (ECONNREFUSED, DNS failure, timeout), rate limiting (403/429/500), SHA-256 hash mismatch with expected/actual output, no compatible version, release tag not found, hashes file corruption (invalid JSON, bad format), archive extraction failure (17 tests)
- `network-resilience` chaos tests: Hub/Explorer connector failures (ECONNREFUSED, timeout, empty response, null data, DNS failure), updateConfig error paths, malformed JSON-RPC responses (16 tests)
- `process-resilience` chaos tests: async error propagation through build/run/statusChanged chains, killContainer/removeContainer rejection handling, empty container ID propagation, multi-step operation error chains, uninstall resilience, precheck failure cascade (Docker unavailable, network creation, hub install) (16 tests)
- `test:chaos` npm script; chaos tests included in `test:all` pipeline

## [0.0.10] - 2026-04-06

### Added
- Performance benchmark harness (`test/benchmarks/`) with 6 scenarios measuring CLI throughput
- `config-generation` benchmark: `getDefaultConfig()` throughput for all 9 coin-network combos plus shared module path
- `filter-params` benchmark: `filterCommandParameters()` expansion for all/single/explorer/node cases
- `leveldb-operations` benchmark: LevelDB put/get/del single-key latency and scan at 10/50/100/500 entries via memdown
- `config-parsing-scale` benchmark: config file parsing scaling from 10 to 500 lines with scaling factor calculation
- `resolve-args` benchmark: `resolveArgs()` throughput for standard/reversed/branch/empty/all argument patterns
- `naming-helpers` benchmark: Docker image naming, network naming, database naming, and port validation throughput
- `MetricsCollector` class with high-resolution timing, percentile calculations, memory snapshots, and event loop monitoring
- Baseline comparison support (`--compare`, `--save-baseline`) for regression detection
- `benchmark` and `benchmark:quick` npm scripts

## [0.0.9] - 2026-04-05

### Added
- Security test suite (`test/unit/security.test.js`) with 27 tests covering shell injection prevention, container ID validation, NODE_PREFIX validation, branch name validation, path traversal prevention, database command safety, and source code scanning for remaining `exec()` calls

### Changed
- `CommandCapture` test helper gains `createExecFileStub()` and `createExecFileAsyncStub()` methods for the new `execFile` pattern
- All existing tests (unit, integration, fuzz, e2e, smoke) updated to stub `execFile` instead of `exec`, with array-based assertions

### Security
- Replace all `child_process.exec()` calls with `execFile()`/`spawn()` using array arguments across 11 source files (~44 call sites), eliminating shell command injection as a vulnerability class
- Fix `stringToDockerContainerFile()` broken template literal bug, now uses `spawn()` with `tee` for safe stdin piping
- Passwords in database commands are now passed as single array elements to `execFile()`, preventing shell metacharacter interpretation and process listing exposure
- SQL strings passed as single `-e` argument to `execFile()`, preventing shell breakout from SQL content
- Validate `NODE_PREFIX` environment variable against `/^[a-z0-9][a-z0-9._-]*$/` to prevent shell injection via Docker naming
- Add path traversal prevention in `ConfigService.getDefaultConfig()` with `path.resolve()` boundary check
- Move branch name validation into `resolveArgs()` for fail-fast rejection at CLI entry point
- Standardize container ID validation to `/^[a-f0-9]{64}$/` regex in `NodeService.js` and `DatabaseService.js`
- Change bootstrap directory permissions from `chmod 777` to `chmod 755`
- Remove shell escaping in `buildAndUp()` env var handling (unnecessary with `execFile()`)
- Remove `escapeShellDoubleQuotes()` in `runE2ETest()`: replaced with array-based command construction
- `execContainer()` now accepts `string[]` command args instead of a single shell string
- `buildAndUp()` `dockerCmd` parameter changed from `string|null` to `string[]|null`
- `GitHubDownloader` uses `spawnSync()` + `fs.unlinkSync()` instead of `execSync()` with shell `&&` chaining

## [0.0.8] - 2026-04-05

### Added
- `validatePort()` helper in ConfigService, strict validation accepting only integer numbers or digit-only strings in range 1-65535; rejects hex, scientific notation, floats, booleans
- Port validation in `buildAndUp()` that rejects invalid port values before they reach Docker command construction
- Fuzz test suite (`test/fuzz/`) with 258 tests across 6 files covering env var escaping, branch name validation, resolveArgs robustness, config file parsing, container ID validation, port validation, command construction safety, and filterCommandParameters edge cases
- `test:fuzz` npm script; fuzz tests included in `test:all` pipeline

### Fixed
- Environment variable escaping now neutralizes newline (`\n`) and carriage return (`\r`) characters that could inject additional Docker flags via `-e` values
- Container ID validation now requires 64-character lowercase hex (`/^[a-f0-9]{64}$/`) instead of only checking string length; rejects with a clear error on invalid IDs

## [0.0.7] - 2026-04-05

### Added
- Boundary test suite (`test/unit/boundary.test.js`) with 60 tests covering config parsing edge cases, argument resolution boundaries, Docker env var escaping, branch name validation, grep/testName escaping, LevelDB non-TTY handling, and key format integrity

### Fixed
- Config file parser now preserves values containing `=` (e.g., base64 tokens, passwords with `=`)
- Config file reader no longer crashes when a coin/network config file is missing; falls back to defaults with a warning
- Docker environment variable values containing `"`, `$`, backticks, or `\` are now escaped before shell interpolation
- Branch names with shell metacharacters (`;`, `$()`, backticks, spaces, pipes) are rejected with a clear error
- E2E test `--grep` patterns and test names with `"` or `\` are now escaped to prevent shell injection
- LevelDB lock prompt no longer hangs in non-interactive (non-TTY) environments; throws immediately with instructions

## [0.0.6] - 2026-04-05

### Added
- End-to-end test suite with 57 tests across 8 scenario files validating complete CLI workflows
- E2E test helper (`e2e-env.js`) extending TestEnv to wire all services together with stubbed Docker/Git/HTTP but real config generation, LevelDB state, and service-list expansion
- E2E tests for full install lifecycle: install all, stop, start, uninstall, selective install (6 tests)
- E2E tests for multi-coin installation: per-coin Docker networks, shared service deduplication, per-coin uninstall (6 tests)
- E2E tests for configuration overrides: default env vars, config file overrides, regtest-specific values, DB naming conventions (13 tests)
- E2E tests for PreCheck pipeline: Docker verification, directory creation, hub auto-install, Docker-unreachable error (6 tests)
- E2E tests for update flow: kill old container, build new image, LevelDB updated, branch support (4 tests)
- E2E tests for reset command: stop/clear/restart lifecycle, database DROP/CREATE, multi-module reset (4 tests)
- E2E tests for error handling: Docker unreachable, docker run failure, missing module, git clone failure, empty LevelDB (6 tests)
- E2E tests for exec/logs/restart commands using container IDs from LevelDB (5 tests)
- `test:e2e` npm script; E2E tests included in `test:all` pipeline

## [0.0.5] - 2026-04-05

### Added
- Smoke test suite with 159 tests across 10 scenarios verifying CLI operational readiness
- Smoke tests for module import chain (all 21 source files resolve without errors)
- Smoke tests for Commander CLI registration (all 17 commands with correct argument counts)
- Smoke tests for global options registration (verbose, interactive, no-bootstrap, no-explorer, version)
- Smoke tests for constants and enum integrity (XChainService, Coin, Network, paths, git URLs, project folders)
- Smoke tests for config template file integrity (all 9 coin/network files: format, required keys, no duplicates)
- Smoke tests for config composition (getDefaultConfig for coin-specific, regtest, and shared-service configs)
- Smoke tests for Docker command construction (all 15 exported operation functions exist)
- Smoke tests for parameter expansion (wildcard expansion, regtest filtering, explorer as shared service)
- Smoke tests for state module initialization (singleton exports, initial values, getter/setter pairs)
- Smoke tests for crypto node Dockerfile existence (bitcoin, litecoin, dogecoin)
- `test:smoke` npm script; smoke tests run first in `test:all` pipeline

## [0.0.4] - 2026-04-05

### Added
- Integration test suite with 103 tests across 7 test files validating cross-module interactions
- Integration test helpers: CommandCapture (child_process stub), HttpCapture (axios stub), TestEnv (isolated environment with memdown LevelDB, temp dirs, state reset)
- Integration tests for config pipeline (filterCommandParameters -> getDefaultConfig across all coin/network combos)
- Integration tests for Docker command construction (verifies all flags, env vars, ports, volumes per module type)
- Integration tests for module lifecycle (LevelDB state for start/stop/restart/exec via moduleOperations)
- Integration tests for status query chain (getStatus with running/stopped/missing containers, caching)
- Integration tests for hub/explorer config update (payload construction, retry logic, network connectivity)
- Integration tests for database service chain (container creation, user/grant SQL, readiness polling)
- Integration tests for Docker network management (create/skip, container attachment, lifecycle commands)
- Integration tests for multi-module orchestration (install ordering, update flow, uninstall resilience)
- `test:integration` and `test:all` npm scripts

## [0.0.3] - 2026-04-05

### Added
- Unit test suite with 261 tests across 12 test files covering all core modules
- Test infrastructure: mocha, chai, sinon, proxyquire, memdown as devDependencies
- Test coverage for ConfigService (path helpers, naming, getDefaultConfig, filterCommandParameters)
- Test coverage for LevelUpDb (CRUD operations, key format, filtered queries via memdown)
- Test coverage for DockerService (all Docker command string construction)
- Test coverage for ModuleService (cloneGit, buildAndUp, uninstallModule)
- Test coverage for moduleOperations (install/update/uninstall/start/stop/restart/exec/shell/log/monitor)
- Test coverage for DatabaseService, VersionService, HubConnector, ExplorerConnector, GitHubDownloader
- Test coverage for utility helpers (stringToCoin, stringToNetwork, decompressTarGz) and shared state

## [0.0.2] - 2026-04-03

### Added
- xchain-indexer-sync support: `INDEXER_SYNC_MODULE_NAME` constant, project folder, git URL in `constants.js`
- Port mapping case for xchain-indexer-sync in `ModuleService.js` `buildAndUp()`
- Default config values for xchain-indexer-sync (SYNC_MODE, SYNC_API_PORT, SYNC_PORT) in `ConfigService.js`
- Docker container image prefix whitelist entry for xchain-indexer-sync in `ConfigService.js`
- Auto-connect xchain-indexer-sync container to all chain/network Docker networks in `HubService.js` `updateHub()`
