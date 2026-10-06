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
 * XChain Node - Interactive UI / Coin node version order
 ********************************************************************/

// Coin daemons tag two-, three- and four-part versions (28.1, 1.14.9, 0.21.5.6),
// and semver rejects the first and the last, so node versions compare by parts.

// Splits "v0.21.5.6" or "28.1\n" into numbers; null for anything else, "0" included.
function nodeVersionParts(raw) {
    if (raw == null) return null
    // Require at least two parts, so the menu's "0" (unavailable) never reads as a version
    const match = /^v?(\d+(?:\.\d+)+)$/.exec(String(raw).trim())
    return match ? match[1].split('.').map(Number) : null
}

// Orders two parsed versions; a missing trailing part counts as zero.
function compareParts(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0)
        if (diff !== 0) return Math.sign(diff)
    }
    return 0
}

// The valid / gt / eq questions the module-action menu asks of a version scheme.
const NODE_VERSION_ORDER = {
    valid: version => nodeVersionParts(version) !== null,
    gt: (a, b) => compareParts(nodeVersionParts(a), nodeVersionParts(b)) > 0,
    eq: (a, b) => compareParts(nodeVersionParts(a), nodeVersionParts(b)) === 0
}

// Reads the stored GitHub release's tag; "0" when no release has been looked up.
function remoteNodeVersion(release) {
    return release?.["tag_name"] ?? "0"
}

module.exports = { NODE_VERSION_ORDER, nodeVersionParts, remoteNodeVersion }
