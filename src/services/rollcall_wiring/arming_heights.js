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
 * XChain Node - ROLLCALL arming heights, the CLI's read-only mirror
 *
 * Mirrors ROLLCALL_ACTIVATION, ROLLCALL_ACCEPT_WINDOW_BLOCKS and
 * ROLLCALL_PROOF_DELAY_BLOCKS from xchain-indexer/src/rollcall_activation.js
 * (twin: xchain-hub/src/rollcall_activation.js). The CLI never judges a
 * block with these; it only decides, before a deploy, whether the network
 * being deployed to will ever close a roll-call epoch, and names the block
 * that close lands on. Consensus stays in the indexer and the hub.
 *
 * A mirror rather than a require of the vendored checkout, because the
 * checkout under modules/ does not exist before the first `install` clones it
 * (the hub is provisioned from precheck ahead of any indexer clone), moves
 * with every update and pinned ref, and reads process.env at require time
 * for regtest. The unit suite pins this mirror against the sibling indexer
 * checkout whenever one is present, so a drift shows up in CI.
 ********************************************************************/

const { Network } = require('../../config')

// The one host variable that arms regtest, spelled the way the indexer spells
// it; it reaches the container through the CLI's own passthrough.
const ROLLCALL_REGTEST_ENV = 'XC_ROLLCALL_REGTEST_ACTIVATION'

// BTC height at/above which roll-call epochs exist on each shared-ledger
// network. Regtest is absent on purpose: it arms only from the environment.
const ROLLCALL_ARMED_HEIGHT = Object.freeze({
    [Network.MAINNET]: 0,
    [Network.TESTNET]: 151200
})

// How long after the epoch block a signature may still land, in BTC blocks.
const ROLLCALL_ACCEPT_WINDOW_BLOCKS = Object.freeze({
    [Network.MAINNET]: 144, [Network.TESTNET]: 144, [Network.REGTEST]: 12
})

// BTC blocks after the window closes before the epoch closes.
const ROLLCALL_PROOF_DELAY_BLOCKS = Object.freeze({
    [Network.MAINNET]: 36, [Network.TESTNET]: 36, [Network.REGTEST]: 2
})

// The regtest arming height the value of XC_ROLLCALL_REGTEST_ACTIVATION
// resolves to, or null for inert. Same accepted forms as the indexer's
// resolveRegtestActivation, and the same fail-closed reading of garbage.
function resolveRegtestArming(raw) {
    if (raw === undefined || raw === null) return null
    const s = String(raw).trim().toLowerCase()
    if (s === '' || s === 'off' || s === 'inert' || s === 'false' || s === 'no' || s === 'none') return null
    if (s === 'armed' || s === 'genesis' || s === 'on' || s === 'true' || s === 'yes') return 0
    if (/^\d+$/.test(s)) return parseInt(s, 10)
    return null
}

/**
 * The height roll-call epochs arm at on `network`, or null when the network
 * has no activation at all. Regtest arms only through the variable the
 * container is about to receive, which is why the injected env is the input.
 *
 * @param {string} network mainnet|testnet|regtest
 * @param {Object<string,string>} injectedEnv the env the deploy is about to write
 * @returns {number|null}
 */
function rollcallArmedHeight(network, injectedEnv) {
    if (network === Network.REGTEST) return resolveRegtestArming((injectedEnv || {})[ROLLCALL_REGTEST_ENV])
    const height = ROLLCALL_ARMED_HEIGHT[network]
    return Number.isFinite(height) ? height : null
}

// "epoch + 144 + 36": the close block of an epoch, spelled for an operator.
function describeCloseFormula(network) {
    const window = ROLLCALL_ACCEPT_WINDOW_BLOCKS[network]
    const delay  = ROLLCALL_PROOF_DELAY_BLOCKS[network]
    if (!Number.isFinite(window) || !Number.isFinite(delay)) return null
    return 'epoch + ' + window + ' + ' + delay
}

module.exports = {
    ROLLCALL_REGTEST_ENV,
    ROLLCALL_ARMED_HEIGHT,
    ROLLCALL_ACCEPT_WINDOW_BLOCKS,
    ROLLCALL_PROOF_DELAY_BLOCKS,
    resolveRegtestArming,
    rollcallArmedHeight,
    describeCloseFormula
}
