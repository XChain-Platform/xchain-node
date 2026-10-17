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
const sinon = require('sinon')
const fs = require('fs')
const paths = require('../../../../src/services/config_service/paths')
const { moduleDir, tmpDir, cryptoNodesDir, Coin } = require('../../../../src/config')
const { stringToCoin } = require('../../../../src/utils/helpers')

function configure(overrides = {}) {
    const dependencies = {
        fs: { existsSync: sinon.stub(), rmSync: sinon.stub(), mkdirSync: sinon.stub() },
        moduleDir: '/modules',
        tmpDir: '/temporary',
        cryptoNodesDir: '/crypto-nodes',
        Coin: { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin' },
        stringToCoin: sinon.stub().callsFake(coin => coin.toUpperCase()),
        ...overrides
    }
    paths.configure(dependencies)
    return dependencies
}

describe('config_service/paths', function () {
    after(function () {
        paths.configure({ fs, moduleDir, tmpDir, cryptoNodesDir, Coin, stringToCoin })
    })

    it('derives module, temporary, and crypto-node directories', function () {
        const dependencies = configure()

        expect(paths.getModuleDir('xchain-decoder')).to.equal('/modules/xchain-decoder')
        expect(paths.getModuleTmpDir('xchain-indexer')).to.equal('/temporary/xchain-indexer')
        expect(paths.getCryptoNodeDir('BITCOIN')).to.equal('/crypto-nodes/bitcoin')
        expect(paths.getCryptoNodeDir('dogecoin')).to.equal('/crypto-nodes/dogecoin')
        expect(dependencies.stringToCoin.calledOnceWithExactly('dogecoin')).to.equal(true)
    })

    it('removes module directories and only removes existing temporary directories', function () {
        const dependencies = configure()
        dependencies.fs.existsSync.onFirstCall().returns(false).onSecondCall().returns(true)

        paths.removeModuleDir('xchain-decoder')
        paths.removeModuleTmpDir('xchain-decoder')
        paths.removeModuleTmpDir('xchain-indexer')

        expect(dependencies.fs.rmSync.firstCall.args).to.deep.equal([
            '/modules/xchain-decoder', { recursive: true }
        ])
        expect(dependencies.fs.rmSync.secondCall.args).to.deep.equal([
            '/temporary/xchain-indexer', { recursive: true }
        ])
        expect(dependencies.fs.rmSync.callCount).to.equal(2)
    })

    it('creates a missing temporary directory and preserves an existing one', function () {
        const dependencies = configure()
        dependencies.fs.existsSync.onFirstCall().returns(false).onSecondCall().returns(true)

        paths.createModuleTmpDir('xchain-decoder')
        paths.createModuleTmpDir('xchain-indexer')

        expect(dependencies.fs.mkdirSync.calledOnceWithExactly('/temporary/xchain-decoder')).to.equal(true)
    })

    it('reports module directory existence', function () {
        const dependencies = configure()
        dependencies.fs.existsSync.returns(false)
        dependencies.fs.existsSync.withArgs('/modules/xchain-decoder').returns(true)

        expect(paths.moduleDirExists('xchain-decoder')).to.equal(true)
        expect(paths.moduleDirExists('xchain-indexer')).to.equal(false)
    })

    it('requires every expected module source path', function () {
        const dependencies = configure()
        dependencies.fs.existsSync.callsFake(candidate => !candidate.endsWith('/package.json'))

        expect(paths.checkIfModuleExists('xchain-decoder')).to.equal(false)
        expect(dependencies.fs.existsSync.args.map(args => args[0])).to.deep.equal([
            '/modules/xchain-decoder',
            '/modules/xchain-decoder/Dockerfile',
            '/modules/xchain-decoder/src',
            '/modules/xchain-decoder/package.json'
        ])
    })

    it('requires the crypto-node directory, Dockerfile, and source directory', function () {
        const dependencies = configure()
        dependencies.fs.existsSync.returns(true)

        expect(paths.checkIfCryptoNodeSourceExists('BITCOIN')).to.equal(true)
        expect(dependencies.fs.existsSync.args.map(args => args[0])).to.deep.equal([
            '/crypto-nodes/bitcoin',
            '/crypto-nodes/bitcoin/Dockerfile',
            '/crypto-nodes/bitcoin/src'
        ])
    })
})
