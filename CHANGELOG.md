# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0] - 2026-09-08

### Added
- Bootstrap archives carry their end height (a `bootstrap.json` member leading the wrapper), and a fresh install compares it with the coin node's tip before restoring: a node still below the archive is reported as WAITING FOR NODE when the service waits it out, and the restore is refused for a service image that would read the lower tip as a reorg.
- `ps` marks a decoder or tracker that is waiting out a coin node in initial block download as WAITING FOR NODE and explains it under the table.
- `validator status` says that the `full_node` tier is not active on the network yet, instead of leaving an unearnable capability implied.
- Every utxo-tracker container gets a memory limit derived from the host and the number of trackers sharing it, so several chains on one host no longer oversubscribe it; `XCHAIN_NODE_MODULE_MEMORY_MB_<SERVICE>` sets an explicit limit for any service (0 disables).
- `clear-reorg-halt <chain> <network> --reason "..."` clears a decoder's durable REORG_HALT marker after the decoder verifies its database is intact, recording the reason.
- `ps` marks a running decoder that carries a REORG_HALT marker and prints the recovery under the table.
- The bootstrap health gate treats a halt cleared through `clear-reorg-halt` as no longer disqualifying.
- A regtest venue can arm ROLLCALL gates on its indexer and hub containers through `XC_ROLLCALL_GATES_REGTEST_ACTIVATION`, separately from the roll-call rail.
- `update` moves the CLI itself to the target release first (signed tag verified against the shipped release key, checkout, `npm install`, re-run on the new code); `XCHAIN_NODE_NO_SELF_UPDATE=1` updates the services only.
- Every command prints a one-line notice when a newer release than the CLI exists, cached for an hour.
- The node records whether it is on a release or a branch (`data/install-target.json`) at every install and update.

### Fixed
- `install xchain-hub` on a fresh box stages the hub from the release manifest: a no-ref install pins it to the latest release instead of cloning master, and `install vX.Y.Z xchain-hub` works on a train in which the hub did not move (v0.15.1 pins hub v0.15.0) instead of failing on a hub tag that does not exist.

### Changed
- `xchain-node update all` with no ref moves a release node to the latest published release, fully pinned, instead of failing on the detached checkout; a branch node stays on its branch and says so.
- On a validator, `update all` re-runs the additive validator config repair before rebuilding the hub, so re-running `validator init` by hand after an upgrade is no longer needed.
- `update all` now includes the hub and the sync client, hub first, leaves a coin node that already runs the pinned daemon version untouched, and no longer tries to install a coin daemon for a chain that is not installed (it skips absent services and reports them on one line).
- `update` no longer requires a service argument; `xchain-node update` alone means `update all`.

## [0.15.5] - 2026-09-08

### Changed
- The pinned component set moves the indexer to 0.15.5, which brings the testnet activation of order-independent chunked DEPLOY assembly forward to 2026-09-08T12:00:00Z.

## [0.15.4] - 2026-09-08

### Changed
- The pinned component set moves the encoder to 0.15.4: every output it authors on Dogecoin floors at the 0.01 DOGE soft dust limit, so P2SH funding legs relay at any fee rate and validator PRICE and ATTEST wires confirm again.

## [0.15.3] - 2026-09-08

### Changed
- The pinned component set moves the indexer, the sync client, the SDK and the explorer to 0.15.3: a chunked contract deploys exactly once whatever order its pieces confirm in (active on testnet from 2026-09-10 00:00 UTC), and the indexer answers which oracle rounds already ride a valid price batch.

## [0.15.2] - 2026-09-07

### Changed
- The pinned component set moves the hub, the explorer and the sync client to 0.15.2: the hourly attestation batch publishes from every validator, the explorer custom-content frame stops growing, and a sync replica repairs a lookup hole below its cursor.

## [0.15.1] - 2026-09-07

### Changed
- The pinned component set moves the explorer and the SDK to 0.15.1, which serve a coin whose indexed tip is behind with a freshness marker instead of refusing the read.

## [0.15.0] - 2026-09-07

### Added
- The indexer's hub mirror is armed on regtest, and the attest response, roll-call rail and oracle batch landing-reserve knobs pass through to the hub and indexer.
- A private explorer can set its own serving limits.
- A reindex forces a bootstrap republish.
- The tracker volume is snapshotted by hardlink and an encoder maintenance window is declared around it.
- `ENCODER_TRUST_PROXY`, `ENCODER_RATE_LIMIT_RPM`, and five explorer per-route rate-limit knobs now pass through from the host env, so a container recreate no longer drops them.

### Fixed
- A chain daemon is stopped gracefully on update and its release tree is staged before the swap.
- `validator init` no longer mints a hub API key on a re-run, and the CLI sends the key it generated when it pushes config to the hub.
- `HUB_RATE_LIMIT_EXEMPT_LOCAL` passes through to the hub container.
- The hub consensus-env guard derives its key list per network.
- Reset resolves the datadir from the container bind mount and fails closed instead of skipping the chain wipe.
- An explicitly injected null validator settings object is honoured.
- The regtest block-assembly fee floor is lowered beside the relay floor.
- The mainnet federation oracle epoch defaults to its ruled past instant.

### Activation
- The ATTEST response mirror activates on Bitcoin testnet at block 151324 and on regtest from genesis. Mainnet is unratified and the legacy on-chain response path runs there byte for byte.
- ROLLCALL activates on Bitcoin testnet at block 151200, which the chain has already passed, so it is live from the moment a node updates. Mainnet is unratified.
- Both change state derived from existing bytes on testnet, so an updated node and one still on 0.14.0 judge a mirrored response differently once one lands. Update every indexer and hub together.

## [0.14.0] - 2026-09-02

### Fixed
- `install <ref> xchain-hub` no longer fails with HTTP 401 on a host provisioned by the runbook: the CLI now sends the hub API key that `validator init` generated.
- The checkpoint config block ships `hub_url` beside `self_sync`, so a fresh install resolves its checkpoint peer.
- Checkpoint self-sync resolves once per push, so every installed coin gets a checkpoint block instead of only the first.
- `xchain-node rollback` prints the recovery path and exits 1 rather than hanging in the precheck.

### Activation
- This train carries a consensus change in the indexer and hub: attestation responsible-set widening activates on Bitcoin testnet at block 150780 and on regtest from genesis, and is inert on mainnet. Update every indexer and hub before that height; a node left on an older build will judge attestation responses differently once a widened one lands.

## [0.12.3] - 2026-09-01

### Fixed
- `validator stake` and `validator unstake` state both clocks: when the stake leaves the active set, and when the escrowed XCHAIN is spendable after the staking cooldown. The old text promised the money back at the activation delay, which is a week early on Bitcoin.
- Both delays are read per chain from the coin registry rather than hardcoded, so Litecoin and Dogecoin print their own values.
- Pinned hub 0.12.3, which tells a peer it is not in the signer set instead of reporting an invalid signature.

## [0.12.2] - 2026-09-01

### Added
- `validator stake` and `validator unstake` mint, stake and withdraw against the public network, so an operator can join before installing any stack.
- `validator init` builds the stake and publisher wallets and prints the two addresses to fund.

### Fixed
- An unrecognised service name is refused with the list of valid ones, instead of silently expanding to every service on every coin and network.
- A coin image builds from a context that holds its Dockerfile, and never writes live credentials into the tracked config template.
- A mutating command waits out a busy lock instead of losing the run, and a locked bootstrap create is retried by the publisher.
- The next step printed after `validator init` names the release rather than a branch.

## [0.12.1] - 2026-08-31

### Fixed
- Pinned indexer 0.12.1, which judges a reward whose anchor was attested before a restart on the anchor bytes as written; every other component is unchanged from 0.12.0.

## [0.12.0] - 2026-08-30

### Added
- An indexer joins its sibling coin networks when its container is created, so cross-chain reads survive a recreate.

### Fixed
- The MariaDB connector moves to 3.5.3, closing three high-severity advisories against the pinned 3.5.2.
- A synchronous throw exits loudly, the way a rejection already did.
- Validator initialization generates the hub API key.
- Indexer and decoder accounts are granted the replication-status privilege.
- A failed hub config push reports its cause.
- Module operations and database setup state their real failure modes.

### Changed
- Price batches are version 0, and the per-round wire is retired.
- Log history is kept long enough to investigate with, and the log shim is configurable.

## [0.11.0] - 2026-08-26

### Added
- Install and update end with a bootstrap restore summary, so a restore that did not happen is stated rather than left as one warning mid-log.
- `XCHAIN_NODE_FORCE_BOOTSTRAP=1` restores a published bootstrap over an already-populated service, for when the install that would have taken it failed.

### Changed
- The release manifest pins the v0.11.0 component set.

### Fixed
- The migration precondition refusal only prints a scoped migrate command when the running build is confirmed to support one, and otherwise names every migration an unscoped run would apply.
- `reset xchain-decoder` now refuses while an indexer is installed and names the `--with-indexer` joint form, because resetting one half of the pair leaves the other unable to commit blocks.
- The bitcoind mirror retry now answers the address-list form Node asks for, so the retry actually dials instead of failing immediately on every supported Node version.
- A bitcoind tarball already present at the download path is used and verified against the pinned hash rather than overwritten, so the manual workaround the failure message describes now works.
- The bootstrap restore summary is printed even when the install fails partway, which is when it matters most.
- A published bootstrap older than a week is called out during the download, since a snapshot that has aged past the chain can leave a service unable to continue from it.
- A failed bitcoind download now retries against the site's other mirror addresses, so one mirror serving a broken certificate chain no longer blocks the install.
- Download failures name the URL, the mirror and the cause instead of a generic message.
- Module clones now use public HTTPS URLs, so installs work without a GitHub SSH key.
- Downloading a coin node now creates the crypto-nodes directory first, fixing installs pointed at a fresh custom volume.
- Bootstrap auto-restore downloads now recover a root-owned destination directory instead of failing with a permission error.
- The explorer install health wait now allows about two minutes of container warm-up instead of ten seconds.

## [0.10.0] - 2026-08-22

### Added
- Pinned installs verify downloaded release artifacts against the pinned signing key.
- The explorer can run a self-synced checkpoint mirror, with the database grants it needs, so a deployment with no colocated hub schema can still serve the checkpoint, proof and cross-chain routes.
- A module update is refused when its source asserts a gated migration that has not been applied.

### Changed
- The release manifest pins every module the installer clones. The 0.10.0 set is twelve; the 0.9.0 manifest carried eight, so a pinned install of that train still cloned four modules at their default branch.

### Fixed
- A bootstrap source that reports no lag, or a negative lag, is refused with a reason instead of being read as healthy.
- Autoheal no longer restarts a container an operator deliberately stopped.
- The hub database account is rotated when the hub is recreated, and the headless config prompt is guarded.
- Uninstall keeps a shared service that is still serving another coin.
- Install returns only once the explorer is actually serving the new coins, and fails when the explorer never starts serving them.
- Install tells the shared services about coins the same run just created.
- The explorer installs on a stack that has no coins yet.
- The hub and explorer are staged at the ref the command named.
- A migration precondition reads its skip flag by name.
- The block-fetch desync record renders field by field instead of as an object placeholder.

### Security
- Raised the brace-expansion and js-yaml dependency floors and the advisory guards that pin them.

## [0.9.0] - 2026-08-14

First release of the XChain Platform release train. Every component in the train
now shares one platform version, so "XChain 0.9.0" names an exact, reproducible
set of software rather than a rough era.

### Changed
- Adopted the platform version stream. This component moves from `0.0.26` to
  `0.9.0`. **The number is lower but the release is newer**: the platform stream
  starts at 0.9.0 for the testnet series, and 1.0.0 is reserved for mainnet.

<!-- ------------------------------------------------------------------------
     Versions BELOW this line are this component's own legacy stream, from
     before the release train. They are kept for history and are NOT comparable
     to the platform versions above: a higher legacy number is an older release.
     ------------------------------------------------------------------------ -->

## [0.0.26] - 2026-08-13

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
