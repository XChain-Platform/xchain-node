'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    sinon,
    expect,
    XChainService,
    COIN,
    NETWORK,
    makeStubs,
    stubVerifiedInner,
    loadBootstrapService
} = require('./helpers/support')

const TRACKER_ARCHIVE = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/latest.tgz'
const DECODER_ARCHIVE = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/latest.tgz'

let savedRequireSigned

function refuseTip() {
    return {
        verdict: 'behind-refuse', refuse: true,
        archiveHeight: 964970, nodeHeight: 962304, gap: 2666, ibd: false
    }
}

function destructiveCall(stubs) {
    return stubs.execFile.getCalls().find(call => {
        const args = Array.isArray(call.args[1]) ? call.args[1] : []
        return args[0] === 'xzf' || args.join(' ').includes('-delete') || args.join(' ').includes('DROP DATABASE')
    })
}

describe('BootstrapService restore node tip guard', function () {
    beforeEach(function () {
        savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
    })

    afterEach(function () {
        if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
    })

    it('refuses a manual tracker restore before extraction, stop, wipe, or archive removal', async function () {
        const stubs = makeStubs()
        stubVerifiedInner(stubs, { archivePath: TRACKER_ARCHIVE })
        stubs.nodeTipGuard.assessNodeTipForRestore.resolves(refuseTip())
        const bs = loadBootstrapService(stubs)

        const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'latest.tgz')
            .then(() => null, failure => failure)

        expect(err).to.be.instanceOf(bs.BootstrapNodeTipRefusedError)
        expect(err.message).to.match(/Nothing was stopped, wiped, or deleted/)
        expect(stubs.databaseService.ensureDatabasePool.calledBefore(stubs.nodeTipGuard.assessNodeTipForRestore)).to.equal(true)
        expect(stubs.dockerService.stopContainer.called).to.equal(false)
        expect(stubs.fs.rmSync.called).to.equal(false)
        expect(destructiveCall(stubs)).to.equal(undefined)
    })

    it('refuses a manual decoder restore before extraction, stop, or database drop', async function () {
        const stubs = makeStubs()
        stubVerifiedInner(stubs, {
            archivePath: DECODER_ARCHIVE, innerName: 'dump.sql.gz', checksumName: 'dump.sha256'
        })
        stubs.spawn = sinon.stub()
        stubs.nodeTipGuard.assessNodeTipForRestore.resolves(refuseTip())
        const bs = loadBootstrapService(stubs)

        const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'latest.tgz')
            .then(() => null, failure => failure)

        expect(err.name).to.equal('BootstrapNodeTipRefusedError')
        expect(stubs.dockerService.stopContainer.called).to.equal(false)
        expect(stubs.spawn.called).to.equal(false)
        expect(destructiveCall(stubs)).to.equal(undefined)
    })
})

describe('BootstrapService restore supplied node tip assessment', function () {
    beforeEach(function () {
        savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
    })

    afterEach(function () {
        if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
    })

    it('honors a supplied refusal without probing the node again', async function () {
        const stubs = makeStubs()
        stubVerifiedInner(stubs, { archivePath: TRACKER_ARCHIVE })
        const bs = loadBootstrapService(stubs)

        const err = await bs.restoreBootstrap(
            COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'latest.tgz', { nodeTip: refuseTip() }
        ).then(() => null, failure => failure)

        expect(err.name).to.equal('BootstrapNodeTipRefusedError')
        expect(stubs.nodeTipGuard.assessNodeTipForRestore.called).to.equal(false)
        expect(destructiveCall(stubs)).to.equal(undefined)
    })
})
