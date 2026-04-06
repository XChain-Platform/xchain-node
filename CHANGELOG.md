# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
