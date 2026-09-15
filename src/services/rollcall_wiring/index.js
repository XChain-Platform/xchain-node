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
 * XChain Node - ROLLCALL wiring guard
 *
 * Refuses to deploy a BTC indexer, or a validator-mode hub, onto a network
 * that closes roll-call epochs when the env about to be written carries no
 * DOGE indexer read. Roll calls land on Dogecoin and are judged on Bitcoin:
 * the BTC indexer must prove who signed before it may close an epoch, and
 * with no DOGE read it DEFERS every block from the first close and never
 * advances, while its node and decoder stay healthy. The hub needs the same
 * read to learn what already landed before it publishes; without it a
 * sweeper publishes nothing and logs nothing. Unchecked, both surface only
 * at the wedge, days after the install that caused it.
 *
 * Runs from buildAndUp beside the go-live gate, so install, update and
 * recreate all pass through it, and the hub provisioned from precheck too.
 ********************************************************************/

const { HUB_MODULE_NAME, XChainService, Coin, Network } = require('../../config')
// The module itself as well: the override is a getter read when a deploy
// asks, not a value taken when this file loads.
const config = require('../../config')
const { rollcallArmedHeight, describeCloseFormula } = require('./arming_heights')
const { getLogger } = require('../../observability/logger')
const logger = getLogger()

// Escape hatch for a single-coin regtest venue that armed roll calls but
// will never close an epoch it cares about; downgrades the refusal to a
// warning. Named in the XCHAIN_NODE_* style of the other overrides.
const NO_DOGE_READ_OVERRIDE_ENV = 'XCHAIN_NODE_ALLOW_NO_DOGE_READ'

// Tags the refusal so a caller can tell it from an unrelated deploy failure.
const NO_DOGE_READ_ERROR_CODE = 'ROLLCALL_DOGE_READ_UNWIRED'

// The two spellings the indexer and the hub both accept, newest first.
const DOGE_READ_URL_KEYS = ['DOGE_INDEXER_API_URL', 'DOGE_INDEXER_URL']

// Where an outside validator without its own Dogecoin indexer points: the
// public explorer serves the federation reads off its replicated indexer
// databases, gated by the federation read key the validator was issued.
// Regtest is private, so it has no public value to name.
const PUBLIC_DOGE_READ_URL = Object.freeze({
    [Network.MAINNET]: 'https://explorer.xchain.io/DOGE/api/',
    [Network.TESTNET]: 'https://explorer.xchain.io/TDOGE/api/'
})

// The sentence that names the public value for a network, or the self-hosted
// remedy alone where there is none.
function describeWhereToPoint(network) {
    const publicUrl = PUBLIC_DOGE_READ_URL[network]
    if (!publicUrl) {
        return 'Set ' + DOGE_READ_URL_KEYS[0] + ' (and DOGE_INDEXER_API_KEY) in the host .env to a reachable dogecoin '
            + network + ' indexer, then re-run.'
    }
    return 'Set ' + DOGE_READ_URL_KEYS[0] + '=' + publicUrl + ' in the host .env, with DOGE_INDEXER_API_KEY set to the '
        + 'federation read key this validator was issued (the public explorer serves the federation reads off its '
        + 'replicated indexer databases); a validator running its own dogecoin ' + network
        + ' indexer points at that instead. Then re-run.'
}

function isTruthyEnv(value) {
    return value !== undefined && value !== '' && value !== '0'
        && String(value).toLowerCase() !== 'false' && String(value).toLowerCase() !== 'no'
}

// The network this deploy's roll calls would run on, or null when the module
// never closes or publishes one: a non-BTC indexer (LTC and DOGE indexers
// neither close epochs nor need a DOGE read), a standalone hub (no P2P, so
// no roll-call round), or a hub with no HUB_NETWORK to key an activation on.
function rollcallNetworkFor(module, coin, network, injectedEnv) {
    const env = injectedEnv || {}
    if (module === XChainService.XCHAIN_INDEXER) {
        return coin === Coin.BITCOIN && network ? String(network).toLowerCase() : null
    }
    if (module === HUB_MODULE_NAME) {
        if (!env.P2P_VALIDATOR_ADDR) return null
        return env.HUB_NETWORK ? String(env.HUB_NETWORK).toLowerCase() : null
    }
    return null
}

// True when either spelling of the DOGE read URL is set and non-empty in the
// env about to be written. Only the injected env counts: a value in the host
// shell that the passthrough does not carry never reaches the container, so a
// guard that credited it would pass a deploy that still wedges. A DOGE
// indexer co-installed on this box counts only through the URL for the same
// reason; joining its docker network resolves the name, not the read.
function dogeReadWired(injectedEnv) {
    const env = injectedEnv || {}
    return DOGE_READ_URL_KEYS.some((key) => env[key] !== undefined && env[key] !== null && String(env[key]).trim() !== '')
}

// The one message an operator reads: the variable, the wedge block, the hub.
function describeUnwiredDogeRead(module, coin, network, armedHeight) {
    const target = module + (coin ? ' ' + coin + '/' + network : ' (validator mode, HUB_NETWORK=' + network + ')')
    const formula = describeCloseFormula(network) || 'epoch + accept window + proof delay'
    return 'ROLLCALL wiring (' + target + '): no DOGE indexer read is configured. ' +
        DOGE_READ_URL_KEYS[0] + ' is unset (and so is the older ' + DOGE_READ_URL_KEYS[1] + '), and ' + network +
        ' has a ROLLCALL activation (epochs from BTC height ' + armedHeight + '). ' +
        'A BTC indexer must prove on Dogecoin who signed each roll call before it may close an epoch; ' +
        'with no DOGE read it DEFERS every block from the first epoch close, at ' + formula +
        ' (the accept window plus the proof delay), and never advances while its node and decoder stay healthy. ' +
        'Every hub in validator mode needs the same URL: it asks its DOGE indexer what already landed ' +
        '(getrollcallsigners) before publishing, and without one a sweeper publishes nothing and logs nothing. ' +
        describeWhereToPoint(network) + ' A single-coin regtest venue that will never close an epoch can set ' +
        NO_DOGE_READ_OVERRIDE_ENV + '=1 to deploy on a warning instead.'
}

/**
 * Refuse a deploy that would wedge at its first epoch close. Silent when the
 * module is not one that reads roll calls, the network has no activation, or
 * a DOGE read URL is in the env about to be written. Throws otherwise, unless
 * the override is set, in which case the same text is logged as a warning.
 *
 * @param {string} module
 * @param {string|null} coin
 * @param {string|null} network
 * @param {Object<string,string>} environmentVariables the env this deploy is about to write (getDefaultConfig output)
 * @param {{env?: object}} [deps] `env` stands in for the config home in tests
 * @returns {{network: string, armedHeight: number, overridden: boolean}|null} what was found, or null when nothing applied
 */
function assertDogeReadWired(module, coin, network, environmentVariables, deps = {}) {
    const rollcallNetwork = rollcallNetworkFor(module, coin, network, environmentVariables)
    if (!rollcallNetwork) return null

    const armedHeight = rollcallArmedHeight(rollcallNetwork, environmentVariables)
    if (armedHeight === null) return null
    if (dogeReadWired(environmentVariables)) return null

    const hostEnv = deps.env || config
    const message = describeUnwiredDogeRead(module, coin, rollcallNetwork, armedHeight)
    if (isTruthyEnv(hostEnv[NO_DOGE_READ_OVERRIDE_ENV])) {
        logger.warn('WARNING: ' + message + ' (' + NO_DOGE_READ_OVERRIDE_ENV + ' is set; deploying anyway.)')
        return { network: rollcallNetwork, armedHeight, overridden: true }
    }
    const error = new Error('REFUSING to deploy: ' + message)
    error.code = NO_DOGE_READ_ERROR_CODE
    throw error
}

module.exports = {
    NO_DOGE_READ_OVERRIDE_ENV,
    NO_DOGE_READ_ERROR_CODE,
    DOGE_READ_URL_KEYS,
    PUBLIC_DOGE_READ_URL,
    describeWhereToPoint,
    rollcallNetworkFor,
    dogeReadWired,
    describeUnwiredDogeRead,
    assertDogeReadWired
}
