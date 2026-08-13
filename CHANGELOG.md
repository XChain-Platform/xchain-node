# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Coin-node images now bake in an RPC healthcheck, so a wedged-but-alive daemon no longer reads as cleanly running.
- MariaDB now carries a Docker healthcheck for restart resilience.
- The command lock now covers all provisioning commands, external DB ports are validated on every branch, reset validates its inputs and fails loud, and the healthcheck start-period is bootstrap-aware.

### Added
- `install` and `update` now accept a version like `v0.9.0` in the existing ref slot, installing that release's exact pinned component set.
- `install` with no ref now resolves the latest published release instead of requiring a branch name.
- A release manifest (`src/release-manifest.json`) records each release's component tags and commits, and every clone is verified against the pinned commit.
- Keyless hub deploys now declare `HUB_ALLOW_UNAUTHENTICATED=true` (never on mainnet), which the hub requires before it will boot with an unauthenticated write surface.
- `HUB_API_KEY` now passes through from the host env to shared-service configs (sync, explorer) so their hub clients can authenticate against the keyed sensitive-read tier.
- Accepted MariaDB root passwords now persist to a local credentials file and are read back, ping-verified, as a non-interactive fallback when the DB container carries no root password env var.

### Fixed
- Bundled libraries are no longer staged from the remote's default branch; they follow the release manifest, or inherit the ref of the service they are compiled into.
- Non-interactive runs now fail fast with an actionable error instead of hanging forever on the root-password prompt when stdin is not a TTY.
- The regtest miner's Docker healthcheck now probes over JSON-RPC instead of HTTP GET, since the miner has no GET status route and every probe used to fail.

## [0.0.25] - 2026-07-16

### Fixed
- ConfigService now mirrors the resolved indexer DB password onto the hub DB password setting, including its static default, so it is never left undefined.
- BootstrapService now pins the signature fetch to the archive's final redirected URL, with a fallback filename if that lookup misses.

## [0.0.23] - 2026-06-20

### Added
- Added `.env.example`, a configuration template listing the environment variables `xchain-node` reads, with safe defaults and inline comments.

### Changed
- Renamed `INDEXER_HOST` to `INDEXER_URL` to follow the platform's `<SERVICE>_URL` naming convention; behavior unchanged.
- Pinned the `mariadb` dependency to an exact version so every install resolves an identical dependency tree.
- Renamed the regtest encoder rate-limit setting to follow the platform's per-service naming convention.
- Widened the `mariadb` driver version range to match the rest of the platform; no source changes.

### Fixed
- `HubConnector` now records each failed endpoint's URL and error code so callers can diagnose which endpoints were tried.
- `HubConnector` now surfaces a hub with a dead DB pool as degraded-but-reachable instead of treating it as crashed.
- `HubConnector` now remembers the last responding endpoint and starts each call there, avoiding a timeout penalty on a degraded first endpoint.

### Security
- Moved MariaDB client password arguments off the command line and onto an environment variable, so passwords are no longer visible in the process list.
- Added archive member validation before extraction, and signed bootstrap archives with a verified signature check on restore.
- Added checksum verification for the Bitcoin Core download before extraction, matching existing verification for the other chains.
- Moved generated node RPC credentials into a separate, git-ignored local sidecar file instead of the main config file.

## [0.0.22] - 2026-05-30

### Fixed
- Managed containers now restart automatically after a host reboot or Docker daemon restart.

## [0.0.21] - 2026-05-29

### Security
- Pinned a dev-tooling dependency to remediate two known vulnerabilities; no runtime impact.

## [0.0.20] - 2026-05-29

### Changed
- Committed the dependency lockfile to the repo so every install resolves the exact tested dependency tree.

## [0.0.19] - 2026-05-29

### Changed
- Read-only commands now skip an unnecessary hub sync round-trip to avoid a multi-second delay.

## [0.0.18] - 2026-05-28

### Security
- Raised the minimum `axios` version to close off a credential-injection vulnerability in older releases.

## [0.0.17] - 2026-05-28

### Security
- Pinned the `qs` dependency to remediate a denial-of-service vulnerability.

## [0.0.16] - 2026-05-28

### Added
- Bootstrap restore is now resumable, reusing an already-extracted archive and skipping re-verification on a re-run.

### Fixed
- Bootstrap restore now opens its database connection pool before the container lookup, so it works outside the interactive CLI path.
- Bootstrap restore now distinguishes an uninitialized database pool from a missing container row in its error messages.

## [0.0.15] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in the README for cleaner formatting.

## [0.0.14] - 2026-04-06

### Added
- Added a regression test suite with priority-tiered coverage across parsing, configuration, Docker commands, security boundaries, and service lifecycle.
- Added npm scripts to run the full regression suite or just its highest-priority tiers.
- Wired the regression suite into the full test pipeline.

### Changed
- Rewrote the README from a minimal stub into a full repo README with quick start, scripts table, and test suite documentation.

## [0.0.13] - 2026-04-06

### Added
- Added mutation testing infrastructure using StrykerJS.
- Added a full mutation config targeting core source files and a scoped pilot config for one service.
- Added npm scripts to run the full or pilot mutation test suites.

## [0.0.12] - 2026-04-06

### Fixed
- The Docker build failure path now properly rejects its promise instead of hanging forever, a bug found by the chaos test suite.

### Changed
- Updated the chaos test suite's assertions now that the underlying bug is fixed.

## [0.0.11] - 2026-04-06

### Added
- Added a chaos engineering test suite covering fault injection and resilience across config parsing, Docker operations, local storage, git cloning, downloads, and network calls.
- Added an npm script to run the chaos suite and wired it into the full test pipeline.

## [0.0.10] - 2026-04-06

### Added
- Added a performance benchmark harness covering CLI throughput across configuration, filtering, storage, parsing, and argument-resolution scenarios.
- Added baseline comparison support for regression detection.
- Added npm scripts to run the full or quick benchmark suites.

## [0.0.9] - 2026-04-05

### Added
- Added a security test suite covering shell injection prevention, ID validation, path traversal, and safe database commands.

### Changed
- Extended the test helpers and existing test suites to match the new safe subprocess invocation pattern.

### Security
- Replaced unsafe shell-invoking subprocess calls with safe array-argument variants across the codebase, eliminating shell injection as a vulnerability class.
- Fixed a broken template literal that could allow unsafe input handling in one code path.
- Moved database passwords and SQL strings into safe argument positions, preventing shell metacharacter interpretation.
- Added strict validation for container naming and prefix inputs to prevent injection via Docker naming.
- Added path traversal prevention in the default config resolver.
- Moved branch name validation earlier in the pipeline for fail-fast rejection.
- Standardized container ID validation across services.
- Tightened bootstrap directory permissions.
- Removed now-unnecessary shell escaping now that commands use safe argument arrays.

## [0.0.8] - 2026-04-05

### Added
- Added strict port validation accepting only well-formed integers in the valid port range.
- Added port validation ahead of Docker command construction to reject bad values early.
- Added a fuzz test suite covering escaping, validation, and command construction edge cases across several modules.
- Added an npm script to run the fuzz suite and wired it into the full test pipeline.

### Fixed
- Environment variable escaping now neutralizes newline and carriage-return characters that could inject extra Docker flags.
- Container ID validation now requires the correct hex format instead of only checking length.

## [0.0.7] - 2026-04-05

### Added
- Added a boundary test suite covering config parsing, argument resolution, escaping, and key format edge cases.

### Fixed
- The config file parser now preserves values containing an equals sign.
- The config file reader no longer crashes on a missing coin or network config file; it now falls back to defaults with a warning.
- Docker environment variable values with special characters are now escaped before interpolation.
- Branch names with shell metacharacters are now rejected with a clear error.
- Test grep patterns and test names with special characters are now escaped to prevent injection.
- The local storage lock prompt no longer hangs in a non-interactive environment.

## [0.0.6] - 2026-04-05

### Added
- Added an end-to-end test suite validating complete CLI workflows across install, multi-coin setup, config overrides, precheck, update, reset, error handling, and exec/log commands.
- Added an npm script to run the e2e suite and wired it into the full test pipeline.

## [0.0.5] - 2026-04-05

### Added
- Added a smoke test suite verifying CLI operational readiness across module imports, command registration, config templates, and Docker command construction.
- Added an npm script to run the smoke suite first in the full test pipeline.

## [0.0.4] - 2026-04-05

### Added
- Added an integration test suite validating cross-module interactions across config, Docker commands, module lifecycle, status, hub/explorer updates, and database setup.
- Added shared test helpers for stubbing subprocess calls, HTTP calls, and building an isolated test environment.
- Added npm scripts to run the integration and full test suites.

## [0.0.3] - 2026-04-05

### Added
- Added a unit test suite covering all core modules.
- Added test infrastructure (mocha, chai, sinon, proxyquire, and an in-memory store) as dev dependencies.

## [0.0.2] - 2026-04-03

### Added
- Added support for a new indexer-sync module: constants, default config, Docker port mapping, image prefix whitelist entry, and auto-connect to chain/network Docker networks.
