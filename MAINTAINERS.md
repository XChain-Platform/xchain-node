# Maintainers

This file lists the people responsible for `xchain-node`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: installer/manager CLI, service configs, credential handling, Docker orchestration, bootstrap, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-node/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| Install and update flow | `src/operations/moduleOperations.js`, the install/update/uninstall/start/stop/restart lifecycle, argument parsing and validation |
| Configuration generation | `src/services/ConfigService.js`, the two-layer config system (hardcoded defaults + config file overrides), generated per-service `.env` files, 40+ environment variables |
| Credential handling | `src/services/CredentialsService.js`, per-service credential generation, secrets written only to filesystem never to source |
| Docker orchestration | `src/services/DockerService.js`, container lifecycle, network management, exec and log access, multi-pane monitoring UI (`src/ui/`) |
| Bootstrap snapshots | `src/services/BootstrapService.js`, gzipped snapshot creation and restore, SHA-256 integrity verification, signed bootstrap verification (`bootstrap_signing_pubkey.pem`) |
| Coin-binary download | `src/GitHubDownloader.js`, cross-arch binary fetch, SHA-256 hash verification (`src/github_hashes.json`), the cross-arch binary cache |
| Database orchestration | `src/services/DatabaseService.js`, `src/MariaDbStore.js`, schema provisioning, per-service database and user creation, subnet-scoped permissions |
| Validator init | `src/services/ValidatorService.js`, Ed25519 key generation, capabilities config, validator mode mount wiring |
| State persistence | `src/state.js`, LevelDB composite-key store mapping modules to container IDs |
| Service connectors | `src/ExplorerConnector.js`, `src/HubConnector.js`, `src/services/HubService.js`, `src/services/ExplorerService.js` |
| Pre-flight and discovery | `src/precheck.js`, `src/services/DiscoveryService.js`, Docker verification, LevelDB open, remote version fetch |
| Tests | The layered suites under `test/` (unit, integration, smoke, e2e, fuzz, chaos, security, boundary, regression, performance, mutation) |
| Documentation | `README`, `INSTALL`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: `execFile` with array arguments (no shell string interpolation), credentials never in source, raw parameterized SQL with no ORM, the `Keep a Changelog` format, and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| Arbitrary code execution or credential exposure via the privileged install flow, or a tampered binary/bootstrap | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Install architecture, credential handling, and supply-chain trust for fetched binaries and snapshots.
- Generated configuration format and the variables each service receives.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-decoder`](https://github.com/XChain-platform/xchain-decoder) | Installed and run as a Docker container; xchain-node generates its config and manages its lifecycle |
| [`xchain-indexer`](https://github.com/XChain-platform/xchain-indexer) | Installed and run as a Docker container; xchain-node generates its config and manages its lifecycle |
| [`xchain-hub`](https://github.com/XChain-platform/xchain-hub) | Installed and run as a Docker container; validator mode config is mounted by xchain-node |
| [`xchain-explorer`](https://github.com/XChain-platform/xchain-explorer) | Installed and run as a Docker container |
| [`xchain-encoder`](https://github.com/XChain-platform/xchain-encoder) | Installed and run as a Docker container |
| [`xchain-sync`](https://github.com/XChain-platform/xchain-sync) | Installed and run as a Docker container |
| [`xchain-utxo-tracker`](https://github.com/XChain-platform/xchain-utxo-tracker) | Installed and run as a Docker container |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Operations, configuration, and architecture docs for xchain-node live here; `INSTALL.md` in this repo covers local dev setup |
| Coin nodes (`bitcoind` / `litecoind` / `dogecoind`) | xchain-node downloads, verifies, and manages these as Docker containers; they are upstream projects, not maintained here |

The xchain-node maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
