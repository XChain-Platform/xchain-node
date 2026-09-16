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

const { expect, runArgsFor, mounts } = require('./support/helpers')

describe("NodeService: buildCryptoNode()", function () {

    describe("XCHAIN_NODE_BLOCKS_DIR (blocks + txindex split)", function () {
        it('bitcoin: -blocksdir against /blocks + relocates txindex', async function () {
            const args = await runArgsFor('bitcoin', 'mainnet')
            expect(mounts(args)).to.include('/bigdisk/bitcoin/mainnet:/blocks')
            expect(mounts(args)).to.include('/bigdisk/bitcoin/mainnet-txindex:/root/.bitcoin/indexes/txindex')
            expect(args).to.include('-blocksdir=/blocks')
        })

        it('litecoin: honors -blocksdir (Bitcoin 0.21 base)', async function () {
            const args = await runArgsFor('litecoin', 'mainnet')
            expect(mounts(args)).to.include('/bigdisk/litecoin/mainnet:/blocks')
            expect(args).to.include('-blocksdir=/blocks')
        })

        it('dogecoin mainnet: nests blocks onto the in-datadir path, never -blocksdir', async function () {
            const args = await runArgsFor('dogecoin', 'mainnet')
            expect(mounts(args)).to.include('/bigdisk/dogecoin/mainnet:/root/.dogecoin/blocks')
            expect(mounts(args)).to.include('/bigdisk/dogecoin/mainnet-txindex:/root/.dogecoin/indexes/txindex')
            expect(args.some(a => typeof a === 'string' && a.includes('-blocksdir'))).to.be.false
        })

        it('dogecoin testnet: nests under the testnet3 subdir', async function () {
            const args = await runArgsFor('dogecoin', 'testnet')
            expect(mounts(args)).to.include('/bigdisk/dogecoin/testnet:/root/.dogecoin/testnet3/blocks')
        })
    })
})

describe("NodeService: buildCryptoNode()", function () {

    describe("XCHAIN_NODE_BLOCKS_DIR (blocks + txindex split)", function () {
        it('dogecoin regtest: nests under the regtest subdir', async function () {
            const args = await runArgsFor('dogecoin', 'regtest')
            expect(mounts(args)).to.include('/bigdisk/dogecoin/regtest:/root/.dogecoin/regtest/blocks')
        })

        it('litecoin testnet: relocates txindex under testnet4', async function () {
            const args = await runArgsFor('litecoin', 'testnet')
            expect(mounts(args)).to.include('/bigdisk/litecoin/testnet-txindex:/root/.litecoin/testnet4/indexes/txindex')
        })

        it('bitcoin testnet: relocates txindex under testnet4 (bitcoin-testnet.conf sets testnet4=1)', async function () {
            const args = await runArgsFor('bitcoin', 'testnet')
            expect(mounts(args)).to.include('/bigdisk/bitcoin/testnet-txindex:/root/.bitcoin/testnet4/indexes/txindex')
            expect(args).to.include('-blocksdir=/blocks')
        })

        it('no blocks/txindex mounts when the env var is unset', async function () {
            const args = await runArgsFor('bitcoin', 'mainnet', null)
            expect(mounts(args).some(m => m.includes('/blocks') || m.includes('txindex'))).to.be.false
        })
    })
})
