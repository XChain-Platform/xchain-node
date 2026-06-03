# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `src/services/ConfigService.js` — updated the regtest encoder rate-limit default to the renamed `ENCODER_RATE_LIMIT_RPM` key (was `RATE_LIMIT_RPM`), tracking the encoder's adoption of the per-service `<SERVICE>_RATE_LIMIT_RPM` naming convention. This keeps the regtest high-throughput default (`99999`) effective; without the rename the encoder would have silently fallen back to the production default of 60 RPM and re-introduced HTTP 429 back-pressure failures in the bursty e2e suite.
- `package.json` — aligned the `mariadb` driver to the `^3.5.2` range used across the platform. The driver was previously pinned to `~3.4.5` (a patch-only range, one minor line behind the `xchain-dashboard` host); the caret range now tracks 3.x minor releases consistently with every other service, removing the version drift and the mix of `~`/`^` range operators across the platform. No source changes.

### Fixed
- `src/HubConnector.js` — `_call()` now records why each endpoint failed instead of discarding it. When an endpoint is unreachable (no `err.response`) the client pushes a `url → code` entry onto `connector.lastFailures` rather than silently moving on, so a caller that receives `null` can report exactly which endpoints were tried and what error each produced. Previously the unreachable branch dropped the error entirely, leaving operators with no diagnostic when every endpoint was down. The `null`/degraded return contract is unchanged.
- `src/HubConnector.js`, `test/unit/HubConnector.test.js` — the hub JSON-RPC client no longer treats a reachable-but-unhealthy hub as down. The hub's `ping` endpoint returns HTTP 503 with a valid JSON-RPC `{status:"degraded",db:false}` body when its database pool is down; Axios throws on any non-2xx, and `_call()` swallowed the thrown error's `response`, so a live hub with a dead DB pool read the same as a crashed one — making the hub install/restart loop in `HubService.installHubModule()` exhaust its retries against a hub that is actually running and potentially trigger an unnecessary restart. `_call()` now reads `err.response.data.result` on a non-2xx throw (preferring any fully healthy endpoint first) and surfaces the degraded body instead of `null`, so `ping()` reports a degraded hub as reachable (`true`) and logs the degraded state. Truly unreachable endpoints (no `err.response`) still return `null`/`false` as before.
- `src/HubConnector.js` — the hub JSON-RPC client now remembers the last endpoint that answered and starts each call there (wrapping through the remaining endpoints), instead of always trying the configured endpoints in fixed order. Previously, when the first endpoint was degraded enough to hit the request timeout, every call paid the full timeout penalty before falling back — and then retried that same endpoint first on the next call. The client now sticks to a known-good endpoint until it too fails, then rotates to the next responder.

### Added
- `.env.example` — added a configuration template listing the environment variables `xchain-node` reads (directory overrides, managed and external MariaDB settings, telemetry opt-out), with safe defaults and inline comments.

## [0.0.22] - 2026-05-30

### Fixed
- Managed containers are now created with `--restart unless-stopped`. Previously every container started by `xchain-node` (service modules, coin node daemons, and the MariaDB container) used Docker's default restart policy of `no`, so after a host reboot or Docker daemon restart none of them came back automatically — the platform stayed dark until an operator manually restarted each container in order. The flag was added to the `docker run` argument list at all three container-creation sites (`ModuleService`, `NodeService`, `DatabaseService`); containers now restart automatically after a crash or daemon restart and stay down only when the operator intentionally stops them. The policy is applied at creation time, so already-running containers must be migrated once with `docker update --restart unless-stopped <id>` (or recreated via `stop` + `start`) to pick it up.

## [0.0.21] - 2026-05-29

### Security
- Pin `tmp` to `>=0.2.3` via an `overrides` entry. The vulnerable `tmp@0.0.33` was pulled in transitively through the `@stryker-mutator/core` dev toolchain (`@inquirer/editor` → `external-editor` → `tmp`) and was flagged by GHSA-ph9p-34f9-6g65 (path traversal via unsanitized `prefix`/`postfix`) and GHSA-52f5-9888-hmc6 (symlink `dir` write). `tmp` is not used on any runtime code path — it only reaches the mutation-testing tooling — but the override upgrades it to a patched line (`0.2.7`) and clears the audit warning. No functional change; Stryker and the test suite resolve and run unchanged.

## [0.0.20] - 2026-05-29

### Changed
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored). With the lockfile tracked, a fresh `npm install` resolves the exact dependency tree that was tested rather than whatever latest compatible minor/patch versions happen to be published at install time.

## [0.0.19] - 2026-05-29

### Changed
- `preCheck` no longer pushes local config to the hub/explorer for read-only commands (`ps`, `tail`, `logs`, `monitor`, `tailmonitor`). The `updateconfig` round-trip can take tens of seconds on multi-coin nodes and adds nothing when local service state hasn't changed, so display-only commands now return promptly. State-changing commands (`install`, `update`, `start`, `stop`, `restart`, `uninstall`, `reset`, `sync`, …) still push as before — the sync is the default, so any unlisted/new command keeps pushing.

## [0.0.18] - 2026-05-28

### Security
- Raise the minimum `axios` version from `^1.6.7` to `^1.16.0`. The installed version was already patched, but the stale lower bound left a path by which a clean install against an older registry snapshot could resolve a pre-1.8.2 release affected by GHSA-q8qp-cvcw-x6jj (prototype-pollution read-side gadgets in the HTTP adapter enabling credential injection / request hijacking). Tightening the floor closes that gap and silences the recurring audit warning.

## [0.0.17] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths.

## [0.0.16] - 2026-05-28

### Fixed
- Bootstrap restore now opens the MariaDB connection pool itself before looking up a module's container, so it works regardless of how it is invoked. Previously, when restore was driven outside the interactive CLI entry path the pool was never opened, `getModuleContainer()` silently returned null, and the restore failed with a misleading `utxo-tracker container not found` error even though the container was healthy and the `modules` row was correct.
- The container-lookup failure in utxo-tracker restore now distinguishes "DB pool not initialized" from "no matching row in the modules table" so the actual cause is clear.

### Added
- Bootstrap restore is now resumable. A late-stage failure no longer discards the (up to ~30 min each) outer-extract and SHA-256 verify work: an already-extracted `data.tar.gz`/`dump.sql.gz` + checksum pair in the work dir is reused instead of re-extracted, and a `verify.ok` sentinel lets a re-run skip re-verification and proceed straight to the restore steps. The work dir is still cleaned up after a successful restore.

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
- `README.md` — rewrote from minimal stub to full repo README matching platform conventions: badges, features, documentation links (4 docs: README, Architecture, Configuration, Operations), quick start, scripts table, detailed test suite breakdown with per-file descriptions (1,148 tests), copyright footer

## [0.0.13] - 2026-04-06

### Added
- Mutation testing infrastructure using StrykerJS (`@stryker-mutator/core`, `@stryker-mutator/mocha-runner`)
- Full mutation config (`stryker.config.json`) targeting 8 core source files against unit + integration tests
- Pilot mutation config (`stryker.config.pilot.json`) scoped to ConfigService for Phase 1 rollout
- `test:mutation` npm script for full mutation testing run
- `test:mutation:config` npm script for ConfigService-only pilot run

## [0.0.12] - 2026-04-06

### Fixed
- `buildAndUp()` docker build failure now properly rejects the promise instead of hanging forever — previously called `console.error()` + `return` instead of `reject()`, causing callers to never receive the error (found by chaos engineering tests)

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

### Security
- Replace all `child_process.exec()` calls with `execFile()`/`spawn()` using array arguments across 11 source files (~44 call sites), eliminating shell command injection as a vulnerability class
- Fix `stringToDockerContainerFile()` broken template literal bug — now uses `spawn()` with `tee` for safe stdin piping
- Passwords in database commands are now passed as single array elements to `execFile()`, preventing shell metacharacter interpretation and process listing exposure
- SQL strings passed as single `-e` argument to `execFile()`, preventing shell breakout from SQL content
- Validate `NODE_PREFIX` environment variable against `/^[a-z0-9][a-z0-9._-]*$/` to prevent shell injection via Docker naming
- Add path traversal prevention in `ConfigService.getDefaultConfig()` with `path.resolve()` boundary check
- Move branch name validation into `resolveArgs()` for fail-fast rejection at CLI entry point
- Standardize container ID validation to `/^[a-f0-9]{64}$/` regex in `NodeService.js` and `DatabaseService.js`
- Change bootstrap directory permissions from `chmod 777` to `chmod 755`
- Remove shell escaping in `buildAndUp()` env var handling (unnecessary with `execFile()`)
- Remove `escapeShellDoubleQuotes()` in `runE2ETest()` — replaced with array-based command construction
- `execContainer()` now accepts `string[]` command args instead of a single shell string
- `buildAndUp()` `dockerCmd` parameter changed from `string|null` to `string[]|null`
- `GitHubDownloader` uses `spawnSync()` + `fs.unlinkSync()` instead of `execSync()` with shell `&&` chaining

### Added
- Security test suite (`test/unit/security.test.js`) with 27 tests covering shell injection prevention, container ID validation, NODE_PREFIX validation, branch name validation, path traversal prevention, database command safety, and source code scanning for remaining `exec()` calls

### Changed
- `CommandCapture` test helper gains `createExecFileStub()` and `createExecFileAsyncStub()` methods for the new `execFile` pattern
- All existing tests (unit, integration, fuzz, e2e, smoke) updated to stub `execFile` instead of `exec`, with array-based assertions

## [0.0.8] - 2026-04-05

### Fixed
- Environment variable escaping now neutralizes newline (`\n`) and carriage return (`\r`) characters that could inject additional Docker flags via `-e` values
- Container ID validation now requires 64-character lowercase hex (`/^[a-f0-9]{64}$/`) instead of only checking string length; rejects with a clear error on invalid IDs

### Added
- `validatePort()` helper in ConfigService — strict validation accepting only integer numbers or digit-only strings in range 1-65535; rejects hex, scientific notation, floats, booleans
- Port validation in `buildAndUp()` that rejects invalid port values before they reach Docker command construction
- Fuzz test suite (`test/fuzz/`) with 258 tests across 6 files covering env var escaping, branch name validation, resolveArgs robustness, config file parsing, container ID validation, port validation, command construction safety, and filterCommandParameters edge cases
- `test:fuzz` npm script; fuzz tests included in `test:all` pipeline

## [0.0.7] - 2026-04-05

### Fixed
- Config file parser now preserves values containing `=` (e.g., base64 tokens, passwords with `=`)
- Config file reader no longer crashes when a coin/network config file is missing; falls back to defaults with a warning
- Docker environment variable values containing `"`, `$`, backticks, or `\` are now escaped before shell interpolation
- Branch names with shell metacharacters (`;`, `$()`, backticks, spaces, pipes) are rejected with a clear error
- E2E test `--grep` patterns and test names with `"` or `\` are now escaped to prevent shell injection
- LevelDB lock prompt no longer hangs in non-interactive (non-TTY) environments; throws immediately with instructions

### Added
- Boundary test suite (`test/unit/boundary.test.js`) with 60 tests covering config parsing edge cases, argument resolution boundaries, Docker env var escaping, branch name validation, grep/testName escaping, LevelDB non-TTY handling, and key format integrity

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
