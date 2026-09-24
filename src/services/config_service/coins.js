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
 * Config Service Coin Defaults
 ********************************************************************/

'use strict'

let config, CoinTickerSymbol, Network, XChainService, getCoinConfigByFullName, getDockerContainerImageName

function configure(dependencies) {
    ({ config, CoinTickerSymbol, Network, XChainService, getCoinConfigByFullName, getDockerContainerImageName } = dependencies)
}

// Encoder's express-rate-limit defaults to 60 RPM, which the e2e
// suite blows past whenever the stale-UTXO retry shim fires (up
// to 15 retries per failing tx, easily 100+ RPM during the
// order/swap blocks). Production-safe defaults stay at 60; we
// raise it for regtest where load is by-design bursty.
// The browser wallet calls the encoder cross-origin (create_tx,
// ping). The encoder disables CORS unless CORS_ORIGIN is set, so a fresh
// regtest stack blocks every browser request and the wallet reports the
// chain "degraded". regtest is a local single-operator dev venue (same
// reasoning as INDEXER_ALLOW_UNAUTHENTICATED below), so default it open;
// a host CORS_ORIGIN or config-file value still wins. mainnet/testnet keep
// the fail-safe default (CORS off unless the operator opts in).
// Encoder passthrough. A production encoder sits behind a reverse proxy on
// ANOTHER box, reached over a public address, so its default trust-proxy
// setting (loopback, uniquelocal) never honours X-Forwarded-For and the
// per-IP limiter keys every visitor on the proxy's egress address: one
// bucket per encoder for the whole world. ENCODER_TRUST_PROXY names that
// egress address so the container recovers the real client.
// ENCODER_RATE_LIMIT_RPM rides the same passthrough, placed after the
// regtest block above so a host value wins over the 99999 regtest literal
// and survives update/recreate. Read BY NAME, same as the explorer
// passthrough below: a computed process.env read is invisible to the
// platform's env-var coverage gate, which is what turns an undocumented
// variable into a silent one.
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
// Address-deriving modules (encoder/decoder/utxo-tracker) resolve their bitcoinjs
// network via CryptoNetworks, which keys on the COIN-PREFIXED name (e.g.
// "bitcoin-regtest"). A bare network ("regtest") matches no case → getBitcoinJsNetwork
// returns undefined → bitcoinjs-lib falls back to MAINNET → addresses derive with
// mainnet version bytes (a regtest "m..."/"n..." source comes out as "1..."), which then
// never matches on-chain balances (e.g. an issuance fee-check reads the wrong address and
// fails "insufficient funds (FEE)"). Those modules need the coin-prefixed network; the
// indexer/node keep the bare network (protocol-change matching / bitcoind conf).
// LevelDB tuning passthrough (xchain-utxo-tracker only). src/store/level_up_db.js reads
// LEVELDB_CACHE_BYTES (documented default 4 GiB, components/utxo-tracker/configuration.md:41)
// and LEVELDB_WRITE_BUFFER_BYTES from process.env inside the container, but
// getDefaultConfig never forwarded either host var into the tracker's
// defaultValues, so an operator exporting LEVELDB_CACHE_BYTES before
// install/update got silence: the container never saw it and LevelUpDb fell
// back to its in-container default every time. Mirrors hubPassthroughVars /
// genesisPassthroughVars: only set, non-empty host vars are injected, so an
// unset env leaves the tracker's own default untouched.
// Read by name rather than through a loop: the env-var doc-coverage gate can
// only see a variable it can name, and a computed process.env[varName] read
// widens its blind spot.
function applyCoinDefaults(defaultValues, module, coin, network) {
    if (network === "regtest") {
        defaultValues["REGTEST_MINER_URL"]      = getDockerContainerImageName(XChainService.XCHAIN_REGTEST_MINER, coin, network)
        defaultValues["REGTEST_MINER_API_PORT"] = 3005
        defaultValues["REGTEST_MINER_PORT"]     = 3005
        defaultValues["ENCODER_RATE_LIMIT_RPM"] = 99999
        defaultValues["CORS_ORIGIN"] = config.CORS_ORIGIN || "*"
    }
    if (module === XChainService.XCHAIN_ENCODER) {
        const encoderPassthroughVars = ["ENCODER_TRUST_PROXY", "ENCODER_RATE_LIMIT_RPM"]
        for (const key of encoderPassthroughVars) {
            const value = {
                ENCODER_TRUST_PROXY:    config.ENCODER_TRUST_PROXY,
                ENCODER_RATE_LIMIT_RPM: config.ENCODER_RATE_LIMIT_RPM
            }[key]
            if (value === undefined || value === "") continue
            defaultValues[key] = value
        }
    }
    const feeDestEnvName = 'XCHAIN_FEE_DESTINATION_' + CoinTickerSymbol[coin] + '_' + network.toUpperCase()
    const registryFeeDestination = getCoinConfigByFullName(coin, network).addresses.FEE_DESTINATION
    const feeDestination = (network !== Network.MAINNET && !config.FEE_DESTINATION_ENV[feeDestEnvName] && config.FEE_DESTINATION)
        ? config.FEE_DESTINATION
        : registryFeeDestination
    if (feeDestination) {
        defaultValues['FEE_DESTINATION'] = feeDestination
        defaultValues[feeDestEnvName]    = feeDestination
    }
    if (module === XChainService.XCHAIN_ENCODER || module === XChainService.XCHAIN_DECODER || module === XChainService.XCHAIN_UTXO_TRACKER) {
        defaultValues["NETWORK"] = coin + "-" + network
    }
    if (module === XChainService.XCHAIN_UTXO_TRACKER) {
        const levelDbPassthrough = {
            LEVELDB_CACHE_BYTES:        config.LEVELDB_CACHE_BYTES,
            LEVELDB_WRITE_BUFFER_BYTES: config.LEVELDB_WRITE_BUFFER_BYTES
        }
        for (const [varName, value] of Object.entries(levelDbPassthrough)) {
            if (value !== undefined && value !== "") {
                defaultValues[varName] = value
            }
        }
    }
}

module.exports = { configure, applyCoinDefaults }
