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

// The per-coin/network main config files are operator-authored and untracked
// (7c03f7a stopped tracking them; ConfigService falls back to defaults when one
// is absent), so this suite checks whichever of the nine exist on this machine
// and marks the rest pending instead of failing a checkout that never ran an
// install for that coin/network. Comment lines are allowed: the reader skips
// any line without a KEY= prefix, and the restored regtest files open with a
// comment block explaining where the credentials live.
describe('S-SMOKE-005 – Config Template File Integrity', function () {

    const configDir = path.join(ROOT, 'config')

    const coins = ['bitcoin', 'litecoin', 'dogecoin']
    const networks = ['mainnet', 'testnet', 'regtest']
    const requiredKeys = ['NETWORK', 'NODE_EXPOSED_PORT', 'DUST_AMOUNT']

    for (const coin of coins) {
        for (const network of networks) {
            const fileName = `${coin}-${network}`

            describe(fileName, function () {

                let content, lines

                before(function () {
                    const filePath = path.join(configDir, fileName)
                    if (!fs.existsSync(filePath)) this.skip()
                    content = fs.readFileSync(filePath, 'utf8')
                    lines = content.split('\n')
                        .filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
                })

                it('is non-empty', function () {
                    expect(content.trim()).to.not.be.empty
                })

                it('all non-comment lines match KEY=VALUE format', function () {
                    for (const line of lines) {
                        // Name the key, never the value: a legacy file may still hold a credential.
                        expect(line, `malformed line starting "${line.split('=')[0]}"`).to.match(/^[A-Z][A-Z0-9_]*=.+$/)
                    }
                })

                for (const key of requiredKeys) {
                    it(`contains ${key}`, function () {
                        const hasKey = lines.some(l => l.startsWith(key + '='))
                        expect(hasKey, `missing key: ${key}`).to.be.true
                    })
                }

                it('has no duplicate keys', function () {
                    const keys = lines.map(l => l.split('=')[0])
                    const unique = new Set(keys)
                    expect(keys.length, 'duplicate keys found').to.equal(unique.size)
                })
            })
        }
    }
})
