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
 * XChain Node - Node Service: coin daemon version pin
 * The XCHAIN_NODE_NODE_VERSION_<COIN> pin, shared by every install path
 ********************************************************************/

const config = require('../../config');

// Optional exact-version pin for a coin daemon, read from
// XCHAIN_NODE_NODE_VERSION_<COIN> (e.g. XCHAIN_NODE_NODE_VERSION_LITECOIN=v0.21.4).
// Test harnesses (notably the multi-chain parity sweep) set this so the
// installed daemon matches the DEPLOYED fleet image instead of drifting to the
// latest upstream release. Returns null when no pin is set.
function resolveNodeVersionPin(coin) {
    const pin = config.NODE_VERSION_PIN_ENV['XCHAIN_NODE_NODE_VERSION_' + String(coin).toUpperCase()]
    return pin && pin.trim() !== '' ? pin.trim() : null
}

// One spelling for a daemon version: the bitcoin download writes a bare `28.1`
// to the version file while pins and release tags read `v28.1`.
function normalizeNodeVersion(version) {
    return String(version).trim().replace(/^v/, '')
}

// Enforce a version pin against an already-installed local daemon. A silent
// mismatch would defeat the pin (an install skips the download when a local
// copy exists), so fail loudly with the remediation instead.
function assertNodeVersionPin(coin, network, localNodeVersion, pin) {
    if (pin && localNodeVersion != null && normalizeNodeVersion(localNodeVersion) !== normalizeNodeVersion(pin)) {
        throw new Error(
            `Installed ${coin} node is ${String(localNodeVersion).trim()} but ` +
            `XCHAIN_NODE_NODE_VERSION_${String(coin).toUpperCase()} pins ${pin}. ` +
            `Remove the ${coin}/${network} stack (or the cached crypto node) and reinstall.`)
    }
}

module.exports = { resolveNodeVersionPin, normalizeNodeVersion, assertNodeVersionPin }
