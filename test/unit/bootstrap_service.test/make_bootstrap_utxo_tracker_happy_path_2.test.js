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
    FAKE_CONTAINER_ID,
    makeAutoSpawn,
    makeStubs,
    loadBootstrapService
} = require('./support')

let savedRequireSigned

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

        async function runWithDf(dfLine) {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args.includes('du')) {
                    // 100 GB store
                    return Promise.resolve({ stdout: `${100 * 1024 * 1024 * 1024}\t/data\n` })
                }
                if (cmd === 'docker' && Array.isArray(args) && args.includes('df')) {
                    return Promise.resolve({ stdout: `Filesystem 1024-blocks Used Available Capacity Mounted on\n${dfLine}\n` })
                }
                return Promise.resolve({ stdout: '' })
            })
            makeAutoSpawn(stubs)

            const logged  = []
            const origLog = console.log
            console.log = (...args) => logged.push(args.join(' '))
            try {
                const bs = loadBootstrapService(stubs)
                expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true
            } finally {
                console.log = origLog
            }
            return logged.join('\n')
        }


    // The snapshot buys uptime by pinning compacted SSTs, which costs volume
    // space for the length of the run. Filling the volume halts the tracker,
    // so a thin volume has to be said out loud.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        describe('volume headroom warning', function () {
            it('warns when free space is under the churn headroom', async function () {
                // 5 GB free against a 100 GB store (headroom wants 15 GB)
                const out = await runWithDf(`overlay 209715200 104857600 ${5 * 1024 * 1024} 96% /data`)
                expect(out).to.contain('WARNING')
                expect(out).to.contain('5.0 GB free against a 100.0 GB store')
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        describe('volume headroom warning', function () {
            it('stays quiet when the volume has room', async function () {
                // 40 GB free against a 100 GB store
                const out = await runWithDf(`overlay 209715200 104857600 ${40 * 1024 * 1024} 60% /data`)
                expect(out).to.not.contain('WARNING')
            })
        })
    })
})
