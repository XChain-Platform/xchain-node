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
 * XChain Node - Release Signature Assets
 ********************************************************************/

const path = require('path')

// The XChain Platform release key: RSA 4096, created 2026-07-23, expires
// 2036-07-20. NOT the wallet's keys - the wallet signs its tags and its release
// manifests with two different keys of its own, and confusing the three is a
// named hazard in wallet-release-rails.md. If a document or a check says "the
// release key" without a fingerprint, it is not saying which key.
const PLATFORM_KEY_FINGERPRINT = '1DA7C4896F56EA22CF491EDF4361611A82F90B70'

const KEY_PATH        = path.join(__dirname, '../../../tools/release/release-signing-key.asc')
const SUMS_ASSET      = 'SHA256SUMS'
const SIG_ASSET       = 'SHA256SUMS.asc'
const MANIFEST_ASSET  = 'release-manifest.json'

// Same shape as BootstrapIntegrityError: a refusal here is the gate working,
// and left as a bare Error it reaches the operator as a stack trace, which reads
// as "the installer is broken, retry it" when it means "this release is not
// what it claims to be, do not install it".
class ReleaseIntegrityError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ReleaseIntegrityError'
    }
}

module.exports = {
    PLATFORM_KEY_FINGERPRINT,
    KEY_PATH,
    SUMS_ASSET,
    SIG_ASSET,
    MANIFEST_ASSET,
    ReleaseIntegrityError
}
