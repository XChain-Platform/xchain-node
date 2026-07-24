/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Config Service
 * Path helpers, naming helpers, and getDefaultConfig
 ********************************************************************/

const crypto   = require('crypto')
const fs       = require('fs')
const path     = require('path')
const readline = require('readline')

const {
    NODE_PREFIX, DEFAULT_NODE_PREFIX, SEP, DB_SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    moduleDir, tmpDir, cryptoNodesDir, dataDir, configDir,
    EXTERNAL_DB, EXTERNAL_DB_HOST, EXTERNAL_DB_PORT
} = require('../config/constants')
const { stringToCoin } = require('../utils/helpers')
const { getCoinConfigByFullName } = require('../coins')

function getModuleDir(module) {
    return moduleDir + "/" + module
}

function getModuleTmpDir(module) {
    return tmpDir + "/" + module
}

function getCryptoNodeDir(coin) {
    if (!(coin in Coin)) {
        coin = stringToCoin(coin)
    }
    return cryptoNodesDir + "/" + Coin[coin]
}

function removeModuleDir(module) {
    fs.rmSync(getModuleDir(module), { recursive: true })
}

function removeModuleTmpDir(module) {
    const dir = getModuleTmpDir(module)
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true })
    }
}

function createModuleTmpDir(module) {
    const dir = getModuleTmpDir(module)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir)
    }
}

function moduleDirExists(module) {
    return fs.existsSync(getModuleDir(module))
}

function checkIfModuleExists(module) {
    const dir = getModuleDir(module)
    return fs.existsSync(dir)
        && fs.existsSync(dir + "/Dockerfile")
        && fs.existsSync(dir + "/src")
        && fs.existsSync(dir + "/package.json")
}

function checkIfCryptoNodeSourceExists(coin) {
    const dir = getCryptoNodeDir(coin)
    return fs.existsSync(dir)
        && fs.existsSync(dir + "/Dockerfile")
        && fs.existsSync(dir + "/src")
}

function getDockerContainerImageNamePrefix(module, coin, network) {
    if (module === DB_MODULE_NAME || module === HUB_MODULE_NAME || module === EXPLORER_MODULE_NAME || module === SYNC_MODULE_NAME) {
        return NODE_PREFIX
    }
    return NODE_PREFIX + SEP + coin + SEP + network
}

function getDockerContainerImageName(module, coin, network) {
    return getDockerContainerImageNamePrefix(module, coin, network) + SEP + module
}

// Single source of truth for the UTXO tracker's Docker volume name. Two
// NODE_PREFIX stacks of the same coin+network must not share one volume, so
// non-default prefixes get a prefixed volume name; the default prefix keeps
// the legacy unprefixed name (renaming it would orphan every existing
// deployment's tracker data, forcing a fleet-wide resync). Previously this
// rule lived only in ModuleService.buildAndUp; moduleOperations.resetModules
// and all three BootstrapService sites re-derived the unprefixed name
// independently, so a non-default NODE_PREFIX made reset/bootstrap/restore
// silently operate on the wrong stack's volume (uuid:7523dd94, uuid:a61fc673).
function getUtxoTrackerVolumeName(coin, network) {
    const prefix = NODE_PREFIX === DEFAULT_NODE_PREFIX ? '' : `${NODE_PREFIX}${SEP}`
    return `${prefix}${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${coin}-${network}-data`
}

function getDockerNetwork(coin, network) {
    return NODE_PREFIX
        + (coin   !== "" ? SEP + coin    : "")
        + (network !== "" ? SEP + network : "")
}

function getModuleDatabaseName(module, coin, network) {
    // Defense in depth: an unknown coin (e.g. 'all' or a typo passed straight
    // from a raw CLI arg) yields CoinTickerSymbol[coin] === undefined, which
    // would otherwise produce a junk `XChain_undefined_*` name that reaches
    // CREATE DATABASE on the live MariaDB while the command still exits 0.
    // Fail loud so an unresolved coin never materializes a database.
    if (coin !== "" && CoinTickerSymbol[coin] === undefined) {
        throw new Error("Unknown coin '" + coin + "'; cannot derive a database name")
    }
    // Mirror the coin guard above: a typo'd network (e.g. from a raw CLI arg
    // on the reset/bootstrap paths, which bypass filterCommandParameters)
    // would otherwise derive a well-formed-but-bogus name that still reaches
    // CREATE DATABASE while the command exits 0.
    if (network !== "" && !Object.values(Network).includes(network)) {
        throw new Error("Unknown network '" + network + "'; cannot derive a database name")
    }
    const moduleName = module.slice("xchain-".length)
    return "XChain" + DB_SEP
        + CoinTickerSymbol[coin] + DB_SEP
        + network.charAt(0).toUpperCase() + network.slice(1) + DB_SEP
        + moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
}

function validatePort(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value >= 1 && value <= 65535
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const port = parseInt(value, 10)
        return port >= 1 && port <= 65535
    }
    return false
}

// Persist RPC credentials to the untracked <coin>-<network>.local sidecar. A fresh sidecar
// is created with writeFileSync; an existing one is appended to, unless overwrite is set
// (used by the legacy-migration path to replace it outright). The sidecar holds the live
// node RPC user/password, so it is forced to 0600 the same way credentials.json is: without
// an explicit mode the file lands at the process umask (commonly 0644), leaving the RPC
// credentials readable by any local user on the host.
function persistSidecarCreds(localFilePath, creds, { overwrite = false } = {}) {
    const body = Object.keys(creds).map(k => `${k}=${creds[k]}`).join("\n") + "\n"
    if (overwrite || !fs.existsSync(localFilePath)) {
        const dir = path.dirname(localFilePath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(localFilePath, body, { mode: 0o600 })
    } else {
        let needsLeadingNewline = false
        try {
            const size = fs.statSync(localFilePath).size
            if (size > 0) {
                const fd = fs.openSync(localFilePath, 'r')
                try {
                    const buf = Buffer.alloc(1)
                    fs.readSync(fd, buf, 0, 1, size - 1)
                    needsLeadingNewline = buf.toString('utf8') !== '\n'
                } finally {
                    fs.closeSync(fd)
                }
            }
        } catch {
            needsLeadingNewline = false
        }
        fs.appendFileSync(localFilePath, needsLeadingNewline ? '\n' + body : body)
    }
    // chmod unconditionally: writeFileSync's mode only applies on create, and an
    // already-existing sidecar (append path, or one written before this fix) keeps its
    // old permissions otherwise.
    try { fs.chmodSync(localFilePath, 0o600) } catch {}
}

// Update specific KEY=VALUE entries in a sidecar while PRESERVING all other keys. Unlike
// persistSidecarCreds({overwrite:true}) (which rewrites the file with only the keys it is
// given), this reads the existing sidecar, overlays the supplied values, and rewrites it
// 0600. Used by the DB-password rotation to set DECODER_DB_PASS/INDEXER_DB_PASS (or
// HUB_DB_PASS) without clobbering the NODE_USER/NODE_PASSWORD already in the sidecar.
function upsertSidecarValues(localFilePath, values) {
    const merged = {}
    if (fs.existsSync(localFilePath)) {
        for (const line of fs.readFileSync(localFilePath, "utf8").split(/\r?\n/)) {
            const eqIndex = line.indexOf("=")
            if (eqIndex > 0) merged[line.substring(0, eqIndex)] = line.substring(eqIndex + 1)
        }
    }
    for (const k in values) merged[k] = values[k]
    persistSidecarCreds(localFilePath, merged, { overwrite: true })
}

// Read a single KEY=VALUE from a sidecar file, or undefined if the file or key is absent.
// Uses the same createReadStream + readline path as the main config reader above.
async function readSidecarValue(localFilePath, key) {
    if (!fs.existsSync(localFilePath)) return undefined
    const stream = fs.createReadStream(localFilePath)
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
        const eqIndex = line.indexOf("=")
        if (eqIndex > 0 && line.substring(0, eqIndex) === key) return line.substring(eqIndex + 1)
    }
    return undefined
}

// Whether a per-install random DB password can actually be APPLIED to the live MariaDB
// account on the next provision. Rotation runs either via the external-DB path (EXTERNAL_DB)
// or by exec-ing into a local MariaDB container; on a native, non-container host neither
// runs, so a generated password would never reach the DB and would desync the sidecar from a
// DB still on the old password (the 2026-06-26 indexer outage). Returns false on any error
// (e.g. docker absent), the safe direction: prefer the static default over a password we
// cannot apply. Lazy require avoids a load-time cycle with DatabaseService.
async function dbPasswordCanRotate() {
    if (EXTERNAL_DB) return true
    try {
        const { getDatabaseContainerId } = require('./DatabaseService')
        return !!(await getDatabaseContainerId())
    } catch {
        return false
    }
}

// HUB_DB_PASS is a SHARED-service credential: the hub and every coin/network stack that
// connects to the hub DB must present the SAME password, so it cannot be generated per
// coin/network. Resolve it once from a shared 0600 sidecar (config/hub.local), generating
// and persisting it on first use. getDefaultConfig() calls are sequential in the installer,
// so the read-or-generate is not racy in practice.
async function getOrCreateHubDbPass() {
    const hubLocalPath = path.resolve(configDir, "hub.local")
    let pass = await readSidecarValue(hubLocalPath, "HUB_DB_PASS")
    if (!pass) {
        // Only mint a random shared password where the rotation can apply it; otherwise use
        // the static default so the sidecar never diverges from a DB the rotation cannot reach.
        if (await dbPasswordCanRotate()) {
            pass = crypto.randomBytes(24).toString('hex')
            upsertSidecarValues(hubLocalPath, { HUB_DB_PASS: pass })
        } else {
            pass = "xchain" + SEP + "password"
        }
    }
    return pass
}

async function getDefaultConfig(module, coin, network) {
    let defaultValues = null

    if (coin && network) {
        defaultValues = {
            "NETWORK":   network,
            "NODE_URL":  NODE_MODULE_NAME,
            "NODE_PORT": (network === Network.MAINNET ? 8332 : (network === Network.TESTNET ? 18332 : 18444)),
            "NODE_USER": "rpc",
            "NODE_PASSWORD": "rpc",
            "UTXO_TRACKER_URL":              getDockerContainerImageName(XChainService.XCHAIN_UTXO_TRACKER, coin, network),
            "UTXO_TRACKER_API_PORT":         3001,
            "UTXO_TRACKER_PORT":             3001,
            "UTXO_TRACKER_BOOTSTRAP_VOLUME": dataDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
            "DECODER_DB_NAME":   getModuleDatabaseName(XChainService.XCHAIN_DECODER, coin, network),
            "DECODER_DB_HOST":   "mariadb",
            "DECODER_DB_PORT":   3306,
            "DECODER_DB_USER":   "xchain" + DB_SEP + "decoder" + DB_SEP + coin + DB_SEP + network,
            "DECODER_DB_PASS":   "xchain" + SEP + "password",
            "DECODER_URL":       getDockerContainerImageName(XChainService.XCHAIN_DECODER, coin, network),
            "DECODER_API_PORT":  3002,
            "DECODER_PORT":      3002,
            "DECODER_BOOTSTRAP_VOLUME": dataDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
            "INDEXER_BOOTSTRAP_VOLUME": dataDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
            "ENCODER_URL":       getDockerContainerImageName(XChainService.XCHAIN_ENCODER, coin, network),
            "ENCODER_API_PORT":  3003,
            "ENCODER_PORT":      3003,
            "INDEXER_URL":       getDockerContainerImageName(XChainService.XCHAIN_INDEXER, coin, network),
            "INDEXER_API_PORT":  3004,
            "INDEXER_PORT":      3004,
            "INDEXER_COIN":      CoinTickerSymbol[coin],
            "INDEXER_NETWORK":   network,
            "INDEXER_DB_HOST":   "mariadb",
            "INDEXER_DB_PORT":   3306,
            "INDEXER_DB_NAME":   getModuleDatabaseName(XChainService.XCHAIN_INDEXER, coin, network),
            "INDEXER_DB_USER":   "xchain" + DB_SEP + "indexer" + DB_SEP + coin + DB_SEP + network,
            "INDEXER_DB_PASS":   "xchain" + SEP + "password",
            // The e2e-test harness reaches the indexer DB via DATABASE_URL/DATABASE_PORT
            // (test/initialCheck.test.js), not INDEXER_DB_HOST/PORT. Default them here so
            // the EXTERNAL_DB rewrite below can repoint them; on a host-native-DB box the
            // docker DNS name "mariadb" doesn't resolve and the suite fails at bootstrap.
            "DATABASE_URL":      "mariadb",
            "DATABASE_PORT":     3306,
            "HUB_HOST":          "0.0.0.0",
            "HUB_API_HOST":      getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":          10000,
            // The e2e federation suites (test:federation / test:attestation:llm) boot
            // in-process MultiValidatorHubs that create + drop XChain_<coin>_<net>_MVH_*
            // databases, so the container needs the hub DB credentials. DatabaseService
            // grants this user CREATE/DROP on the XChain_%_MVH_% pattern when the hub
            // module is installed. Omitting these made requireFederationEnv loud-fail.
            "HUB_DB_HOST":       "mariadb",
            "HUB_DB_PORT":       3306,
            "HUB_DB_USER":       "xchain" + DB_SEP + "hub",
            "HUB_DB_PASS":       "xchain" + SEP + "password",
            // Explorer is a SHARED service (no coin/network suffix). Like the hub
            // above, the e2e-test container needs to reach it on the docker network;
            // omitting it left EXPLORER_URL/EXPLORER_API_PORT unset, which failed the
            // e2e harness's checkAllEnvironmentalVariables() → broken hub-config fallback.
            "EXPLORER_URL":      getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""),
            "EXPLORER_API_PORT": 8080,
            "EXPLORER_PORT":     8080
        }

        if (network === "regtest") {
            defaultValues["REGTEST_MINER_URL"]      = getDockerContainerImageName(XChainService.XCHAIN_REGTEST_MINER, coin, network)
            defaultValues["REGTEST_MINER_API_PORT"] = 3005
            defaultValues["REGTEST_MINER_PORT"]     = 3005
            // Encoder's express-rate-limit defaults to 60 RPM, which the e2e
            // suite blows past whenever the stale-UTXO retry shim fires (up
            // to 15 retries per failing tx, easily 100+ RPM during the
            // order/swap blocks). Production-safe defaults stay at 60; we
            // raise it for regtest where load is by-design bursty.
            defaultValues["ENCODER_RATE_LIMIT_RPM"] = 99999
            // : the browser wallet calls the encoder cross-origin (create_tx,
            // ping). The encoder disables CORS unless CORS_ORIGIN is set, so a fresh
            // regtest stack blocks every browser request and the wallet reports the
            // chain "degraded". regtest is a local single-operator dev venue (same
            // reasoning as INDEXER_ALLOW_UNAUTHENTICATED below), so default it open;
            // a host CORS_ORIGIN or config-file value still wins. mainnet/testnet keep
            // the fail-safe default (CORS off unless the operator opts in).
            defaultValues["CORS_ORIGIN"] = process.env.CORS_ORIGIN || "*"
        }

        // Native-coin protocol fee destination (per coin/network). Defaults from the vendored
        // canonical coin registry (src/coins), so a stock install provisions the decoder's
        // FEE_DESTINATION (fee-output capture into transaction_outputs) and the indexer's
        // XCHAIN_FEE_DESTINATION_<COIN>_<NETWORK> without any operator env. Previously these
        // were host-env-only, so default installs left the decoder capturing nothing and
        // native-fee validation failing closed on every fee-bearing LTC/DOGE action (audit
        // F-11). getCoinConfigByFullName applies the per-coin host-env override itself
        // (ignored + warned on mainnet: fee acceptance is consensus and must not depend on
        // operator env); the generic FEE_DESTINATION host var is honored on non-mainnet only.
        // Injected as a default, so a value in the <coin>-<network> config file still wins.
        const feeDestEnvName = 'XCHAIN_FEE_DESTINATION_' + CoinTickerSymbol[coin] + '_' + network.toUpperCase()
        const registryFeeDestination = getCoinConfigByFullName(coin, network).addresses.FEE_DESTINATION
        const feeDestination = (network !== Network.MAINNET && !process.env[feeDestEnvName] && process.env.FEE_DESTINATION)
            ? process.env.FEE_DESTINATION
            : registryFeeDestination
        if (feeDestination) {
            defaultValues['FEE_DESTINATION'] = feeDestination
            defaultValues[feeDestEnvName]    = feeDestination
        }

        // Address-deriving modules (encoder/decoder/utxo-tracker) resolve their bitcoinjs
        // network via CryptoNetworks, which keys on the COIN-PREFIXED name (e.g.
        // "bitcoin-regtest"). A bare network ("regtest") matches no case → getBitcoinJsNetwork
        // returns undefined → bitcoinjs-lib falls back to MAINNET → addresses derive with
        // mainnet version bytes (a regtest "m..."/"n..." source comes out as "1..."), which then
        // never matches on-chain balances (e.g. an issuance fee-check reads the wrong address and
        // fails "insufficient funds (FEE)"). Those modules need the coin-prefixed network; the
        // indexer/node keep the bare network (protocol-change matching / bitcoind conf).
        if (module === XChainService.XCHAIN_ENCODER || module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_UTXO_TRACKER) {
            defaultValues["NETWORK"] = coin + "-" + network
        }

        // e2e-test also derives addresses (test/cryptoHelper.js) and resolves its
        // bitcoinjs network from COIN+NETWORK. initialCheck.test.js reads
        // process.env.COIN and only splits NETWORK when COIN is absent; without COIN
        // it mis-splits the bare network ("regtest" → COIN="regtest", NETWORK=undefined)
        // → getBitcoinJsNetwork returns undefined → bitcoinjs falls back to MAINNET
        // ("1..." addresses) and funded txs never confirm on regtest. Inject COIN so
        // the resolution is correct while NETWORK stays bare for other env consumers.
        //
        // The contract-template suites (test:sdk/*Template) load their source from
        // xchain-contracts. LIBRARY_BUNDLES stages it into the e2e-test build context
        // and the Dockerfile COPYs it to /XChainE2ETest/xchain-contracts, so point the
        // resolver there. Without the bundle present the suites skip (they no longer
        // abort the run).
        if (module === XChainService.XCHAIN_E2E_TEST) {
            defaultValues["COIN"] = coin
            defaultValues["XCHAIN_CONTRACTS_DIR"] = "/XChainE2ETest/xchain-contracts"
        }

        // Genesis-ledger bootstrap env (xchain-indexer only). The indexer binds its
        // consensus-critical genesis parameters from the container environment: mainnet/testnet
        // are frozen-pinned in the indexer's configs/<COIN>.js, but regtest reads the activation
        // block + ledger/dump hashes from env so an operator can dry-run genesis at a current
        // regtest block. Without this passthrough those host vars never reach the container, so
        // genesis can't be enabled on a regtest/dev stack. Mirrors hubPassthroughVars: only set,
        // non-empty host vars are injected (and a config-file value still wins), so an unset env
        // leaves GENESIS_BLOCK at its 0/default and genesis stays off. The path vars point at
        // in-container files; override them only when a custom CSV/dump is volume-mounted.
        if (module === XChainService.XCHAIN_INDEXER) {
            const genesisPassthroughVars = [
                "XCHAIN_GENESIS_BLOCK", "XCHAIN_GENESIS_LEDGER_HASH", "XCHAIN_GENESIS_DUMP_HASH",
                "GENESIS_LEDGER_PATH", "GENESIS_DUMP_PATH",
                "GENESIS_BLOCK_TIMEOUT_MS", "GENESIS_DUMP_TIMEOUT_MS"
            ]
            for (const varName of genesisPassthroughVars) {
                if (process.env[varName] !== undefined && process.env[varName] !== "") {
                    defaultValues[varName] = process.env[varName]
                }
            }
            // The indexer pushes chain tips / config to the hub (HUB_API_URL); when that
            // hub enforces HUB_API_KEY, the indexer must present the same key or its writes
            // 401. Sourced from host env (.env) so it persists across `update`. Unset leaves
            // the indexer sending no key (keyless, the prior default).
            if (process.env.HUB_API_KEY !== undefined && process.env.HUB_API_KEY !== "") {
                defaultValues.HUB_API_KEY = process.env.HUB_API_KEY
            }

            // The hub authenticates to each indexer's federation API (attestation, stake polling,
            // capability snapshots) with <COIN>_INDEXER_API_KEY; the indexer fails closed unless its
            // INDEXER_API_KEY matches. Source from host env so it persists across `update`, mirroring
            // HUB_API_KEY above. Unset leaves the indexer fail-closed (keyless reads rejected).
            if (process.env.INDEXER_API_KEY !== undefined && process.env.INDEXER_API_KEY !== "") {
                defaultValues.INDEXER_API_KEY = process.env.INDEXER_API_KEY
            } else if (network === Network.REGTEST) {
                // With no key configured the indexer fails closed: every gated method
                // (feequotedryrun, the federation reads the staking e2e family asserts
                // against) 401s, so a fresh regtest install can never pass those suites
                // (audit F-10). Regtest is a local single-operator venue, so default the
                // indexer's own documented keyless escape hatch on. A config-file value
                // or host INDEXER_API_KEY still wins; mainnet/testnet stay fail-closed.
                defaultValues.INDEXER_ALLOW_UNAUTHENTICATED = "true"
            }

            // Point the indexer's hub-DB connection (its price_snapshots/oracle_prices source)
            // at its OWN database on mainnet/testnet: in this single-box topology HubDbSync
            // mirrors those hub tables into the indexer DB, so the indexer reads prices from
            // itself using its own DB account. Without HUB_DB_NAME the connection is never made
            // and the mainnet native-fee price-source gate (XChainIndexer.start) fails closed.
            // This mirrors the proven prod per-coin override; operator config overrides still
            // win. regtest has no hub to sync from and the gate is mainnet-only, so it keeps the
            // local-price fallback. HUB_DB_PASS is reconciled after the per-install DB password
            // is resolved (see below); HUB_DB_HOST/PORT are already set above.
            if (network !== "regtest") {
                defaultValues.HUB_DB_NAME         = defaultValues.INDEXER_DB_NAME
                defaultValues.HUB_DB_USER         = defaultValues.INDEXER_DB_USER
                defaultValues.HUB_DB_SYNC_ENABLED = "true"
            }
        }
    } else {
        defaultValues = {
            "HUB_HOST":              "0.0.0.0",
            "HUB_API_HOST":          getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
            "HUB_PORT":              10000,
            "HUB_DB_HOST":           "mariadb",
            "HUB_DB_PORT":           3306,
            "HUB_DB_NAME":           "XChain" + DB_SEP + "Hub",
            "HUB_DB_USER":           "xchain" + DB_SEP + "hub",
            "HUB_DB_PASS":           "xchain" + SEP + "password",
            "EXPLORER_HOST":         "127.0.0.1",
            "EXPLORER_PORT":         18080,
            "EXPLORER_API_HOST":     getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""),
            "EXPLORER_API_USER":     false,
            "EXPLORER_API_PASS":     false,
            "EXPLORER_API_PORT_HTTP":  8080,
            "EXPLORER_PORT_HTTP":      18080,
            "EXPLORER_API_PORT_HTTPS": 8081,
            "EXPLORER_PORT_HTTPS":     18081,
            "SYNC_MODE":               "server",
            "SYNC_API_PORT":           3006,
            "SYNC_PORT":               3006,
            "SYNC_API_HOST":           getDockerContainerImageName(SYNC_MODULE_NAME, "", ""),
            "HUB_API_HOST_SYNC":       getDockerContainerImageName(HUB_MODULE_NAME, "", "")
        }

        // Allow the operator to override the explorer's published HOST ports via host
        // env. Shared services (explorer/hub) have no per-coin config file, so host env
        // is the injection point (same pattern as the hub passthrough vars below). The
        // motivating case: a second co-located xchain-node install (e.g. a federation
        // stack alongside the primary node) must publish the explorer on a non-default
        // port to avoid colliding with the primary's 18080/18081. Container-internal
        // ports (EXPLORER_API_PORT_HTTP/HTTPS) are unchanged.
        for (const k of ["EXPLORER_PORT_HTTP", "EXPLORER_PORT_HTTPS", "EXPLORER_PORT"]) {
            if (process.env[k] !== undefined && process.env[k] !== "") {
                defaultValues[k] = process.env[k]
            }
        }

        // The explorer hard-requires a co-located hub-mirror DB (state_checkpoints /
        // capability_snapshots / cross_chain_matches) per serving coin, since
        // xchain-sync never replicates those tables. Regtest and dev stacks don't run
        // that replication, so the explorer would crash-loop on startup there. Let the
        // operator opt out via host env (ALLOW_NO_COLOCATED_HUB_DB=1): the hub-mirrored
        // endpoints then fail loud per-request instead of blocking startup. Unset on
        // mainnet/testnet so the missing-DB guard still catches a real misconfiguration.
        if (process.env.ALLOW_NO_COLOCATED_HUB_DB !== undefined && process.env.ALLOW_NO_COLOCATED_HUB_DB !== "") {
            defaultValues.ALLOW_NO_COLOCATED_HUB_DB = process.env.ALLOW_NO_COLOCATED_HUB_DB
        }

        // Shared services that call the hub as clients (the sync server's config
        // discovery via getallconfigs, the explorer's hub reads) must present the
        // hub's API key once the hub enforces its sensitive-read tier: getallconfigs
        // 401s keyless when HUB_API_KEY is set hub-side. Sourced from host env so it
        // persists across `update`, mirroring the indexer's passthrough above. Unset
        // keeps the prior keyless behavior (fine against a keyless hub).
        if (process.env.HUB_API_KEY !== undefined && process.env.HUB_API_KEY !== "") {
            defaultValues.HUB_API_KEY = process.env.HUB_API_KEY
        }

        // : the browser wallet calls the hub cross-origin (ping, config reads).
        // The hub disables CORS unless CORS_ORIGIN is set, so a browser wallet is
        // blocked and reports the chain "degraded". The hub is a shared, network-
        // agnostic service (it may front mainnet), so unlike the per-network encoder
        // above it is NOT auto-defaulted open: the operator opts in via host env.
        // On a local regtest dev box set CORS_ORIGIN=* when installing the hub.
        if (process.env.CORS_ORIGIN !== undefined && process.env.CORS_ORIGIN !== "") {
            defaultValues.CORS_ORIGIN = process.env.CORS_ORIGIN
        }

        // : the explorer resolves each coin's utxo-tracker and decoder from
        // UTXO_TRACKER_URL_<CODE> (e.g. UTXO_TRACKER_URL_RBTC) and
        // DECODER_API_URL_<COIN>_<NETWORK> (e.g. DECODER_API_URL_BTC_REGTEST).
        // The explorer is a shared service with no per-venue config file, so these
        // were never emitted anywhere: every coin reported tracker_available:false
        // and decoder_health 'unconfigured', which blanks address balances/UTXOs
        // (the wallet's balance source). Emit the pair for every coin/network at
        // the venue containers' internal ports; entries for venues not installed
        // on this host are inert because the explorer only probes coins it serves.
        if (module === EXPLORER_MODULE_NAME) {
            const networkCodePrefix = { [Network.MAINNET]: "", [Network.TESTNET]: "T", [Network.REGTEST]: "R" }
            for (const coinName of Object.values(Coin)) {
                for (const net of Object.values(Network)) {
                    const tick = CoinTickerSymbol[coinName]
                    defaultValues["UTXO_TRACKER_URL_" + networkCodePrefix[net] + tick] =
                        "http://" + getDockerContainerImageName(XChainService.XCHAIN_UTXO_TRACKER, coinName, net) + ":3001"
                    defaultValues["DECODER_API_URL_" + tick + "_" + net.toUpperCase()] =
                        "http://" + getDockerContainerImageName(XChainService.XCHAIN_DECODER, coinName, net) + ":3002"
                }
            }
        }
    }

    // Usage-telemetry env is only meaningful to the hub (the telemetry collector).
    // TELEMETRY_IP_SALT is read from the host environment (e.g. xchain-node's .env) so
    // the IP-hash salt stays out of source and config files; without it the hub records
    // country/region but leaves ip_hash null. The hub is a shared service (no per
    // coin/network config file), so the host env is the injection point.
    if (module === HUB_MODULE_NAME) {
        defaultValues["TELEMETRY_ENABLED"]        = process.env.TELEMETRY_ENABLED || "true"
        defaultValues["TELEMETRY_RETENTION_DAYS"] = process.env.TELEMETRY_RETENTION_DAYS || 90
        defaultValues["TELEMETRY_IP_SALT"]        = process.env.TELEMETRY_IP_SALT || ""
        // Gate for the per-install detail endpoint (GET /telemetry/operators). Like the
        // salt, sourced from host env so the secret stays out of source/config files;
        // unset leaves the endpoint fail-closed (401 for everyone).
        defaultValues["TELEMETRY_ADMIN_KEY"]      = process.env.TELEMETRY_ADMIN_KEY || ""

        // BTC indexer JSON-RPC URL for the validator-mode price oracle's block-height
        // anchor (hub.getlatestblock). Sourced from host env so a hub NOT co-located with
        // a BTC indexer (e.g. the master hub box, where the BTC stack lives elsewhere) can
        // point at a reachable indexer. Empty default ⇒ the hub falls back to its configs
        // table, so co-located standalone/validator installs are unaffected.
        defaultValues["BTC_INDEXER_API_URL"]      = process.env.BTC_INDEXER_API_URL || ""

        // State-checkpoint engine + ANCHOR publisher (validator mode). The hub is a
        // shared service (no per coin/network config file), so like the telemetry
        // salt and BTC_INDEXER_API_URL above, the host env is the injection point.
        // Per-coin <COIN>_INDEXER_URLs feed getblockhashes (checkpoint state reads);
        // DOGE_* configures the on-chain ANCHOR/price publisher signer pipeline;
        // XDEX_* are the shared single-validator/regtest seams. Only set values are
        // injected, so unset host env leaves the hub's own defaults untouched.
        const hubPassthroughVars = [
            // HUB_API_KEY gates the hub's consensus-affecting write methods. Sourced from
            // host env (.env) so it persists across `update` (a hand-set container value is
            // dropped on rebuild). Set it on the publicly-fronted master hub so writes are
            // authenticated; unset leaves the hub keyless (the prior default).
            "HUB_API_KEY",
            "BTC_INDEXER_URL", "LTC_INDEXER_URL", "DOGE_INDEXER_URL",
            "BTC_INDEXER_API_KEY", "LTC_INDEXER_API_KEY", "DOGE_INDEXER_API_KEY",
            "CHECKPOINT_ENABLED", "CHECKPOINT_INTERVAL_BLOCKS", "CHECKPOINT_CONFIRMATIONS",
            "CHECKPOINT_POLL_MS", "CHECKPOINT_ROUND_TIMEOUT_MS", "CHECKPOINT_CHAINS",
            "ANCHOR_ENABLED", "ANCHOR_INTERVAL_MS", "ANCHOR_MATCH_BATCH_SIZE",
            "ANCHOR_MAX_BATCH", "ANCHOR_CHUNK_MAX_BYTES", "ANCHOR_ROUND_TIMEOUT_MS",
            // ANCHOR_CHUNK_RETRY_MS must outlast the utxo-tracker's mempool poll
            // (60s on mainnet) or back-to-back same-wallet anchor broadcasts
            // exhaust their retries on a stale UTXO view (txn-mempool-conflict).
            "ANCHOR_CHUNK_RETRY_MS",
            "ANCHOR_ELECTION_TOLERANCE_BLOCKS", "ANCHOR_REWARD_PER_PUBLISH",
            // Anchor every Nth checkpoint_seq on-chain (off-multiples stay in the
            // free off-chain mirror); decouples DOGE spend from checkpoint cadence.
            "ANCHOR_CHECKPOINT_EVERY_N",
            "DOGE_ENCODER_URL", "DOGE_ENCODER_API_KEY", "DOGE_ADDRESS",
            "DOGE_PUBKEY_HEX", "DOGE_LOW_BALANCE_THRESHOLD",
            "XDEX_SEED_LOCAL_VALIDATOR", "XDEX_SNAPSHOT_BLOCK",
            // Reverse-proxy trust for the hub's express API (rate-limiter IP
            // keying). Default 'loopback' suits the Apache-on-same-host prod
            // topology; containerized hubs see the docker bridge as the peer,
            // so an operator fronting the container with a proxy sets this.
            "HUB_TRUST_PROXY",
            // Deployment network for the hub's consensus gates (notably
            // STAKE_WEIGHTED_QUORUM, whose activation height is per-network).
            // REQUIRED by the hub in validator mode (it fails loud on a
            // blank/invalid value; no silent default here either) and must
            // match the INDEXER_NETWORK of the chains this hub federates.
            "HUB_NETWORK",
            // Oracle price-round finalization threshold. Defaults to 2 in the hub
            // (a 2-hub diversity floor so a lone external source never becomes a
            // federation-signed price). Single-host prod / regtest deployments must
            // set ORACLE_MIN_SUBMISSIONS=1 explicitly or no round ever finalizes,
            // which stalls every indexer's oracle price-sync barrier. Passed through
            // here so the host env survives a hub container regenerate.
            "ORACLE_MIN_SUBMISSIONS",
            // Per-IP request/min cap on the hub's express API (default 100). Too low
            // for legitimate multi-indexer re-bootstrap: every indexer on a box shares
            // one source IP, so a fleet bootstrapping HubDbSync tables (oracle_prices,
            // price_snapshots, cross_chain_calls, capability_snapshots, state_checkpoints)
            // collectively blows 100/min and gets 429'd, so the heartbeat gate then stays
            // closed and the chain stalls. Raise for prod fleets. Passed through so the
            // host env survives a hub container regenerate.
            "HUB_RATE_LIMIT_RPM"
        ]
        for (const varName of hubPassthroughVars) {
            if (process.env[varName] !== undefined && process.env[varName] !== "") {
                defaultValues[varName] = process.env[varName]
            }
        }

        // Operator signer for the on-chain DOGE publishers: when the host sets
        // XCHAIN_NODE_HUB_SIGNER_DIR, ModuleService mounts that directory
        // read-only at /XChainHub/operator-signer and the hub loads
        // <dir>/signer.js via HUB_SIGNER_MODULE (see xchain-hub
        // examples/doge-signer.example.js for the module contract).
        if (process.env.XCHAIN_NODE_HUB_SIGNER_DIR) {
            defaultValues["HUB_SIGNER_MODULE"] = "/XChainHub/operator-signer/signer.js"
        }

        // Validator mode: when `xchain-node validator init` has been run, inject the
        // P2P / signing-key / capability-config env so the hub starts as a full
        // validator. Returns {} (no change) for a standalone node, so the standalone
        // install path is unaffected.
        const { getValidatorEnv } = require('./ValidatorService')
        Object.assign(defaultValues, getValidatorEnv())
    }

    // Read the config file for this coin/network pair. Non-secret operator overrides live
    // in the main config file; runtime RPC credentials live in a separate, untracked
    // <coin>-<network>.local sidecar so the main file can be diffed/shared without ever
    // carrying rpcuser/rpcpassword.
    const defaultConfig = {}
    if (coin && network && coin !== "" && network !== "") {
        const configFilePath = path.resolve(configDir, `${coin}-${network}`)
        if (!configFilePath.startsWith(path.resolve(configDir) + path.sep) && configFilePath !== path.resolve(configDir)) {
            throw new Error('Config path traversal detected')
        }
        const localFilePath = configFilePath + ".local"

        // Track whether the main file still carries credentials so legacy installs can be migrated.
        let mainFileHasCreds = false

        if (!fs.existsSync(configFilePath)) {
            console.warn("Warning: config file not found: " + configFilePath + " (using defaults)")
        } else {
            const configFileStream = fs.createReadStream(configFilePath)
            const rl = readline.createInterface({ input: configFileStream, crlfDelay: Infinity })
            for await (const line of rl) {
                const eqIndex = line.indexOf("=")
                if (eqIndex > 0) {
                    const key   = line.substring(0, eqIndex)
                    let   value = line.substring(eqIndex + 1)
                    // Recover RPC credentials glued onto the tail of a preceding setting by
                    // an older appender that wrote NODE_USER=/NODE_PASSWORD= with no leading
                    // newline (e.g. `DUST_AMOUNT=546NODE_USER=<hex>`). Peel each credential
                    // off the value tail, password first so a double-glue
                    // `...NODE_USER=<u>NODE_PASSWORD=<p>` resolves cleanly, so the real value
                    // is uncorrupted and mainFileHasCreds arms the migration below, which
                    // relocates the credential to the sidecar and strips it from this file.
                    for (const credKey of ["NODE_PASSWORD", "NODE_USER"]) {
                        const at = value.indexOf(credKey + "=")
                        if (at >= 0) {
                            defaultConfig[credKey] = value.substring(at + credKey.length + 1)
                            value = value.substring(0, at)
                            mainFileHasCreds = true
                        }
                    }
                    defaultConfig[key] = value
                    if (key === "NODE_USER" || key === "NODE_PASSWORD") mainFileHasCreds = true
                }
            }
        }

        // Credentials from the sidecar take precedence over anything in the main file.
        if (fs.existsSync(localFilePath)) {
            const localStream = fs.createReadStream(localFilePath)
            const rlLocal = readline.createInterface({ input: localStream, crlfDelay: Infinity })
            for await (const line of rlLocal) {
                const eqIndex = line.indexOf("=")
                if (eqIndex > 0) {
                    defaultConfig[line.substring(0, eqIndex)] = line.substring(eqIndex + 1)
                }
            }
        }

        // One-time migration for legacy installs: older versions appended NODE_USER /
        // NODE_PASSWORD into the main config file alongside non-secret settings. Move the
        // credentials into the sidecar and strip them from the main file so the two never
        // share a file again. Existing creds keep working; they are simply relocated.
        if (mainFileHasCreds) {
            const creds = {}
            if ("NODE_USER" in defaultConfig)     creds["NODE_USER"]     = defaultConfig["NODE_USER"]
            if ("NODE_PASSWORD" in defaultConfig) creds["NODE_PASSWORD"] = defaultConfig["NODE_PASSWORD"]
            persistSidecarCreds(localFilePath, creds, { overwrite: true })
            const remaining = []
            for (const key in defaultConfig) {
                if (key !== "NODE_USER" && key !== "NODE_PASSWORD") remaining.push(`${key}=${defaultConfig[key]}`)
            }
            fs.writeFileSync(configFilePath, remaining.length ? remaining.join("\n") + "\n" : "")
        }

        // Generate and persist to the sidecar whichever RPC credential is missing,
        // evaluated PER KEY. The old both-absent (&&) guard meant a partial sidecar (one
        // key present, one absent) generated nothing, and the missing half then silently
        // resolved to the static "rpc" default via the merge below, leaving a well-known
        // default credential on a live stack with no operator signal.
        const genRpcCreds = {}
        if (!("NODE_USER" in defaultConfig)) {
            const nodeUser = crypto.randomBytes(12).toString('hex')
            defaultConfig["NODE_USER"] = nodeUser
            genRpcCreds["NODE_USER"]   = nodeUser
        }
        if (!("NODE_PASSWORD" in defaultConfig)) {
            const nodePassword = crypto.randomBytes(24).toString('hex')
            defaultConfig["NODE_PASSWORD"] = nodePassword
            genRpcCreds["NODE_PASSWORD"]   = nodePassword
        }
        if (Object.keys(genRpcCreds).length) persistSidecarCreds(localFilePath, genRpcCreds)

        // Generate and persist a per-install password for each per-coin/network DB account
        // (decoder, indexer) on first provision, so installs no longer share the static
        // default. An operator override in the main config file or the sidecar wins (the merge
        // above already loaded those into defaultConfig). Only generate where the next provision
        // can rotate the live account to the new value (EXTERNAL_DB or a DB container); on a
        // native, non-container host the rotation no-ops, so generating would desync the sidecar
        // from the DB and lock the service out (the 2026-06-26 indexer outage). There these fall
        // through to the static default in defaultValues, matching the un-rotatable live account.
        const freshDbCreds = {}
        if (await dbPasswordCanRotate()) {
            for (const k of ["DECODER_DB_PASS", "INDEXER_DB_PASS"]) {
                if (!(k in defaultConfig)) {
                    const val = crypto.randomBytes(24).toString('hex')
                    defaultConfig[k] = val
                    freshDbCreds[k] = val
                }
            }
        }
        if (Object.keys(freshDbCreds).length) upsertSidecarValues(localFilePath, freshDbCreds)

        // The indexer's hub-DB connection reuses its OWN DB account (HUB_DB_NAME/USER are set
        // to the indexer's in the indexer block above, mainnet/testnet), so its hub-DB password
        // must be the INDEXER_DB_PASS the container will actually get, not the shared hub
        // password. Set it here, before the shared HUB_DB_PASS fallback below, so that fallback
        // sees the key already present and skips. An operator override (already in
        // defaultConfig) wins. On the non-rotatable path (dbPasswordCanRotate() false, the
        // 2026-06-26 outage fallback) INDEXER_DB_PASS is still absent here and only lands via
        // the static-defaults merge below; mirror that same static default instead of copying
        // `undefined`, which would both mismatch the account AND occupy the key so the
        // fallback/merge never repaired it (HubDbSync ER_ACCESS_DENIED lockout, #2246).
        if (module === XChainService.XCHAIN_INDEXER && network !== "regtest" && !("HUB_DB_PASS" in defaultConfig)) {
            defaultConfig["HUB_DB_PASS"] = defaultConfig["INDEXER_DB_PASS"] !== undefined
                ? defaultConfig["INDEXER_DB_PASS"]
                : defaultValues["INDEXER_DB_PASS"]
        }
    }

    // HUB_DB_PASS is shared across the hub and every coin/network stack (decoder/indexer
    // connect to the hub DB). Resolve it from the shared sidecar (generate on first use)
    // unless an operator override already supplied it. Applies to both the coin/network
    // callers (HUB_DB_PASS in their defaults) and the shared-service hub caller.
    if (("HUB_DB_PASS" in defaultValues) && !("HUB_DB_PASS" in defaultConfig)) {
        defaultConfig["HUB_DB_PASS"] = await getOrCreateHubDbPass()
    }

    for (const key in defaultValues) {
        if (!(key in defaultConfig)) {
            defaultConfig[key] = defaultValues[key]
        }
    }

    // EXTERNAL_DB: rewrite the DB host/port keys so containerized services
    // reach the host-native MariaDB via the bridge gateway instead of the
    // docker DNS name "mariadb" (which no longer resolves once the bundled
    // container is decommissioned). The DB name/user/pass keys stay as-is;
    // those are about the credentials, not the network location.
    if (EXTERNAL_DB) {
        // Resolve the real external host/port via getExternalDbConfig() (env →
        // saved credentials.json → prompt) rather than the load-time
        // EXTERNAL_DB_HOST/PORT constants, which only reflect env vars or the
        // 127.0.0.1:3306 defaults. Otherwise a host/port saved at the first-run
        // prompt is ignored and provisioned containers get *_DB_HOST=127.0.0.1
        // (their own loopback), unreachable to the real DB (uuid:52c5b5f1).
        // Lazy require avoids a load-time cycle with DatabaseService.
        const { getExternalDbConfig } = require('./DatabaseService')
        const extCfg = await getExternalDbConfig()
        const extHost = extCfg.host
        const extPort = extCfg.port
        const dbHostKeys = ['HUB_DB_HOST', 'DECODER_DB_HOST', 'INDEXER_DB_HOST', 'DATABASE_URL']
        const dbPortKeys = ['HUB_DB_PORT', 'DECODER_DB_PORT', 'INDEXER_DB_PORT', 'DATABASE_PORT']
        for (const k of dbHostKeys) {
            if (k in defaultConfig) defaultConfig[k] = extHost
        }
        for (const k of dbPortKeys) {
            if (k in defaultConfig) defaultConfig[k] = extPort
        }
    }

    return defaultConfig
}

function filterCommandParameters(branch, modules, coins, networks) {
    const servicesList = {}
    let addExplorer = false

    if (coins && coins !== "all") {
        coins = [coins]
    } else {
        coins = Object.values(Coin)
    }

    if (networks && networks !== "all") {
        networks = [networks]
    } else {
        networks = Object.values(Network)
    }

    // Shared services (hub / explorer / db / sync) are registered under a single
    // empty coin+network key, not per-coin. A bare `update xchain-hub` must resolve
    // to that ""/"" container; otherwise it gets fanned out across real coins where
    // it matches nothing and the command silently no-ops.
    const SHARED_SERVICES = [HUB_MODULE_NAME, EXPLORER_MODULE_NAME, DB_MODULE_NAME, SYNC_MODULE_NAME]

    if (modules === "all") {
        modules = Object.values(XChainService).filter(m => m !== XChainService.XCHAIN_E2E_TEST)
        modules.push(NODE_MODULE_NAME)
        addExplorer = true
    } else if (modules === "explorer") {
        addExplorer = true
        coins = []
    } else if (SHARED_SERVICES.includes(modules)) {
        // Explicitly-named shared service → emit under the empty ""/"" key only.
        return { "": { "": [modules] } }
    } else if (modules === "node") {
        modules = [NODE_MODULE_NAME]
    } else if (modules) {
        modules = [modules]
    }

    if (addExplorer) {
        servicesList[""] = { "": [EXPLORER_MODULE_NAME] }
    }

    for (const nextCoin of coins) {
        if (!(nextCoin in servicesList)) servicesList[nextCoin] = {}

        for (const nextNetwork of networks) {
            if (!(nextNetwork in servicesList[nextCoin])) servicesList[nextCoin][nextNetwork] = []

            for (const nextModule of modules) {
                if (!REGTEST_MODULES.includes(nextModule) || nextNetwork === Network.REGTEST) {
                    servicesList[nextCoin][nextNetwork].push(nextModule)
                }
            }
        }
    }

    return servicesList
}

function resolveArgs(args, { expectBranch = false, defaultBranch = 'master' } = {}) {
    let service = 'all', chain = 'all', network = 'all', branch = null

    const knownServices = [
        ...Object.values(XChainService),
        NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME,
        EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, 'explorer'
    ]
    const knownChains   = Object.values(Coin)
    const knownNetworks = Object.values(Network)

    for (const arg of args) {
        if (!arg || arg === 'all') continue

        // 'xchain-node' is the CLI itself, not an installable service. Without this
        // guard the loop silently drops it and leaves service='all', so e.g.
        // `install master xchain-node` would expand to EVERY service. Fail loudly.
        if (arg === 'xchain-node') {
            throw new Error("'xchain-node' is the CLI itself, not an installable service. Omit it to operate on all services, or name a specific one (e.g. xchain-indexer, xchain-decoder, xchain-hub).")
        }

        if (knownChains.includes(arg)) {
            chain = arg
        } else if (knownNetworks.includes(arg)) {
            network = arg
        } else if (knownServices.includes(arg)) {
            service = arg
        } else if (expectBranch && !branch) {
            branch = arg
        }
    }

    if (expectBranch && !branch) branch = defaultBranch

    if (branch && !/^[a-zA-Z0-9._\-\/]+$/.test(branch)) {
        throw new Error("Invalid branch name: " + branch + " (branch names may only contain letters, numbers, dots, hyphens, underscores, and slashes)")
    }

    return { service, chain, network, branch }
}

module.exports = {
    getModuleDir,
    getModuleTmpDir,
    getCryptoNodeDir,
    removeModuleDir,
    removeModuleTmpDir,
    createModuleTmpDir,
    moduleDirExists,
    checkIfModuleExists,
    checkIfCryptoNodeSourceExists,
    getDockerContainerImageNamePrefix,
    getDockerContainerImageName,
    getUtxoTrackerVolumeName,
    getDockerNetwork,
    getModuleDatabaseName,
    validatePort,
    getDefaultConfig,
    persistSidecarCreds,
    upsertSidecarValues,
    readSidecarValue,
    filterCommandParameters,
    resolveArgs
}
