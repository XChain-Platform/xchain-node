# Contributing to XChain Node

Thanks for considering a contribution. `xchain-node` installs and manages every other XChain service on the operator's host, so changes to the install flow, config generation, credential handling, or binary download paths need careful review.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Install instructions: [`INSTALL.md`](./INSTALL.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/node) repository (architecture, configuration, operations)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-node/
├── src/                  CLI core: config generation, Docker lifecycle, binary download, DB setup, monitoring
├── test/                 layered suites (unit, integration, e2e, smoke, fuzz, chaos, security, regression, ...)
├── CHANGELOG.md          authoritative version history
├── INSTALL.md            host-level install recipe (Docker, Node, symlink setup)
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22 exactly.** The platform pins Node 22 fleet-wide: the `mariadb` driver is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- **Docker** installed and the current user in the `docker` group. See [`INSTALL.md`](./INSTALL.md) for the full setup recipe on Ubuntu 24.04.
- A running coin node (`bitcoind` / `litecoind` / `dogecoind`) is needed for integration and e2e runs. For local work, the `xchain-regtest-miner` plus a regtest stack is the easiest path.

### First-time install

```bash
git clone https://github.com/XChain-Platform/xchain-node.git
cd xchain-node
npm install
npm link
```

No `.env` file is needed for the development unit suite. Integration and e2e runs require a Docker-accessible environment and optionally a coin node. See [`INSTALL.md`](./INSTALL.md) for the full host setup. **Never commit real credentials or generated `.env` files.** Secrets live only in the local config; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
xchain-node install master all bitcoin regtest   # install all services for Bitcoin regtest
xchain-node ps                                   # check running containers
xchain-node stop all bitcoin regtest
xchain-node start all bitcoin regtest
```

See [`README.md`](./README.md) and the [Operations doc](https://github.com/XChain-Platform/xchain-documentation/blob/master/components/node/operations.md) for the full CLI reference.

---

## Tests

`xchain-node` runs a wide layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Unit | `npm test` | No |
| CI (unit, fast gate) | `npm run ci` | No |
| Security | `npm run test:security` | No |
| Boundary | `npm run test:boundary` | No |
| Smoke | `npm run test:smoke` | No |
| Fuzz | `npm run test:fuzz` | No |
| Chaos | `npm run test:chaos` | No |
| Regression | `npm run test:regression` | No |
| Regression P0 | `npm run test:regression:p0` | No |
| Integration | `npm run test:integration` | Docker + optional coin node |
| End-to-end | `npm run test:e2e` | Docker + full stack |
| All | `npm run test:all` | Docker + full stack |

Run the no-external-services tiers before every commit. New install-flow code should come with security and boundary coverage, since the CLI processes operator-supplied input that runs with elevated host privileges.

---

## Coding style

- **Plain JavaScript**, no TypeScript. Raw parameterized SQL via the `mariadb` driver, no ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a security-relevant constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Use `execFile` with array arguments** for all child-process calls. Never construct shell strings from user input. The existing codebase enforces this; new code must follow it.
- **Credentials stay out of source.** All RPC passwords, database credentials, and the validator signing key live in generated files on the operator's filesystem, never in committed source or test fixtures.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the unit gate. Before opening a PR:

1. Run the no-external-services tiers (`npm run ci`, `npm run test:security`) and confirm they pass.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no generated `.env` files).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-Platform/xchain-node/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

Last reviewed: 2026-06-16.
