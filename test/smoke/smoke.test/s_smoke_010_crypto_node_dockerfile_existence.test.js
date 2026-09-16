'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const path       = require('path')
const fs         = require('fs')

const ROOT = path.join(__dirname, '..', '..', '..')

describe('S-SMOKE-010 – Crypto Node Dockerfile Existence', function () {

    const cryptoNodesDir = path.join(ROOT, 'crypto_nodes')

    for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
        it(`${coin}/Dockerfile exists and is non-empty`, function () {
            const dockerfilePath = path.join(cryptoNodesDir, coin, 'Dockerfile')
            expect(fs.existsSync(dockerfilePath), `${coin}/Dockerfile missing`).to.be.true

            const content = fs.readFileSync(dockerfilePath, 'utf8')
            expect(content.trim(), `${coin}/Dockerfile is empty`).to.not.be.empty
        })
    }
})
