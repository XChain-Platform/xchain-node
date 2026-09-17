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
} = require('./bootstrap_service.test/helpers/support')

let savedRequireSigned

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

// Signature ENFORCEMENT is fail-closed by default (see BootstrapSigning.test.js
// for that policy). The restore/ensure tests below exercise restore MECHANICS
// with no pinned key/.sig in their stubbed fs, so they opt out of enforcement;
// otherwise checkBootstrapSignature would (correctly) refuse and abort the restore.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('getBootstrapFilesList()', function () {
        it('returns file list for XCHAIN_UTXO_TRACKER', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['boot1.tar.gz', 'boot2.tar.gz'])
            // The list is NEWEST FIRST now, so give the stub real mtimes
            // rather than asserting whatever order readdir happened to return.
            stubs.fs.promises.stat
                .onFirstCall().resolves({ isFile: () => true, mtimeMs: 1000 })
                .onSecondCall().resolves({ isFile: () => true, mtimeMs: 2000 })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['boot2.tar.gz', 'boot1.tar.gz'])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('getBootstrapFilesList()', function () {
        it('returns file list for XCHAIN_DECODER', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['dump.tar.gz'])
            stubs.fs.promises.stat.resolves({ isFile: () => true })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(list).to.deep.equal(['dump.tar.gz'])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('getBootstrapFilesList()', function () {
        it('returns file list for XCHAIN_INDEXER', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['indexer.tar.gz'])
            stubs.fs.promises.stat.resolves({ isFile: () => true })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(list).to.deep.equal(['indexer.tar.gz'])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('getBootstrapFilesList()', function () {
        it('filters out non-file entries', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['file.tar.gz', 'subdir'])
            stubs.fs.promises.stat
                .onFirstCall().resolves({ isFile: () => true })
                .onSecondCall().resolves({ isFile: () => false })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['file.tar.gz'])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('getBootstrapFilesList()', function () {
        it('throws for unsupported module', async function () {
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            try {
                await bs.getBootstrapFilesList(COIN, NETWORK, 'xchain-unknown')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Unsupported module for bootstrap')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('getBootstrapFilesList()', function () {
        it('propagates readdir error', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.rejects(new Error('ENOENT: no such file'))
            const bs = loadBootstrapService(stubs)
            try {
                await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('ENOENT')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrap(): dispatch', function () {
        it('throws for unsupported module', async function () {
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            try {
                await bs.makeBootstrap(COIN, NETWORK, 'xchain-unknown')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Unsupported module for bootstrap create')
            }
        })
    })
})

// A reset rebuilds a store on a new lineage, so every archive
// already published for that combo is wrong while looking perfectly fresh.
// `reset` marks the combo due; only a successful create clears it, and a
// create that never reached the archive must leave the marker standing or
// the forced republish is silently cancelled by the run that failed to do it.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrap(): the reindex republish marker', function () {
        it('clears the marker after a create that produced an archive', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '104857600\t/data\n' })
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

            expect(stubs.republishLedger.recordBootstrapPublished.calledOnce).to.be.true
            expect(stubs.republishLedger.recordBootstrapPublished.firstCall.args.slice(0, 3))
                .to.deep.equal([XChainService.XCHAIN_UTXO_TRACKER, COIN, NETWORK])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrap(): the reindex republish marker', function () {
        it('leaves the marker standing when the source-health gate refuses', async function () {
            const stubs = makeStubs()
            const refusal = new Error('Refusing to create a bootstrap from xchain-decoder')
            refusal.name = 'BootstrapSourceUnhealthyError'
            stubs.healthGate.assertBootstrapSourceHealthy.rejects(refusal)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)
                expect.fail('the refusal should propagate')
            } catch (err) {
                expect(err.name).to.equal('BootstrapSourceUnhealthyError')
            }
            expect(stubs.republishLedger.recordBootstrapPublished.called).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrap(): the reindex republish marker', function () {
        it('leaves the marker standing when the create itself fails', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '104857600\t/data\n' })
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            // spawn #0 is the docker tar (inner), spawn #1 the outer wrap: a
            // dead wrap means no publishable archive was produced.
            makeAutoSpawn(stubs, { exitCodes: { 1: 2 } })

            const bs = loadBootstrapService(stubs)
            const err = await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.message).to.include('tar exited with code 2')
            expect(stubs.republishLedger.recordBootstrapPublished.called).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrap(): dispatch', function () {
        it('throws for unsupported module', async function () {
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, 'xchain-unknown', 'file.tgz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Unsupported module for bootstrap restore')
            }
        })
    })
})

// uuid:7037604f: the caller reads "empty" as "fresh, restore a bootstrap over
// it", so an inspection FAILURE must never answer empty. Only a CONFIRMED
// empty volume may.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('utxoTrackerVolumeFreshness()', function () {
        it("reports empty when docker itself says there is no such volume", async function () {
            const stubs = makeStubs()
            stubs.execFile = sinon.stub().rejects(new Error('Error: No such volume: xchain-utxo-tracker-x'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeFreshness(COIN, NETWORK)
            expect(result).to.equal('empty')
        })
    })
})


    // A daemon that cannot be reached says nothing about the volume.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('utxoTrackerVolumeFreshness()', function () {
        it('reports unknown when the inspect fails for any other reason', async function () {
            const stubs = makeStubs()
            stubs.execFile = sinon.stub().rejects(
                new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeFreshness(COIN, NETWORK)
            expect(result).to.equal('unknown')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('utxoTrackerVolumeFreshness()', function () {
        it('reports populated when volume ls shows a non-empty entry', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '' })       // inspect OK
                return Promise.resolve({ stdout: 'LOCK\n' })                       // ls shows data
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeFreshness(COIN, NETWORK)
            expect(result).to.equal('populated')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('utxoTrackerVolumeFreshness()', function () {
        it('reports empty when volume ls output is empty', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '' })       // inspect OK
                return Promise.resolve({ stdout: '' })                             // empty volume
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeFreshness(COIN, NETWORK)
            expect(result).to.equal('empty')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('utxoTrackerVolumeFreshness()', function () {
        it('reports unknown when ls exec fails', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '' })       // inspect OK
                return Promise.reject(new Error('exec error'))                     // ls fails
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeFreshness(COIN, NETWORK)
            expect(result).to.equal('unknown')
        })
    })
})


    // The decisive assertion for this probe is about the SHELL, and no stub
    // can make it: the test above stubs a REJECTED exec, which is the one
    // shape a failed `ls` never produced. `ls -A /data 2>/dev/null | head -1`
    // exits with head's status, so a failed listing resolved with exit 0 and
    // empty stdout, and empty stdout is read as a confirmed-empty volume. So
    // run the string the module actually hands the container through a real
    // shell and require it to fail when the listing fails.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('utxoTrackerVolumeFreshness()', function () {
        it('uses a listing command that exits non-zero when the listing fails', async function () {
            const fs = require('fs')
            const os = require('os')
            const path = require('path')
            const { spawnSync } = require('child_process')
            const stubs = makeStubs()
            let lastArgs = null
            stubs.execFile = sinon.stub().callsFake((...args) => {
                lastArgs = args[1]
                return Promise.resolve({ stdout: '' })
            })
            const bs = loadBootstrapService(stubs)
            await bs.utxoTrackerVolumeFreshness(COIN, NETWORK)

            // The constant under test is the one the probe really passes.
            expect(lastArgs).to.include(bs.UTXO_TRACKER_LISTING_COMMAND)

            const failed = spawnSync('/bin/sh',
                ['-c', bs.UTXO_TRACKER_LISTING_COMMAND.replace('/data', '/nonexistent-xchain-freshness-probe')],
                { encoding: 'utf8' })
            expect(failed.status).to.not.equal(0)

            // A healthy directory must still succeed, or every probe answers unknown.
            // Use a dir this test creates, not the shared OS tmpdir: a crowded
            // TMPDIR makes `ls -A` outrun the mocha timeout on a long-lived box.
            const healthyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-freshness-probe-'))
            try {
                const healthy = spawnSync('/bin/sh',
                    ['-c', bs.UTXO_TRACKER_LISTING_COMMAND.replace('/data', healthyDir)],
                    { encoding: 'utf8' })
                expect(healthy.status).to.equal(0)
            } finally {
                fs.rmSync(healthyDir, { recursive: true, force: true })
            }
        })
    })
})

require('./bootstrap_service.test/download_bootstrap.test')
require('./bootstrap_service.test/download_bootstrap_2.test')
require('./bootstrap_service.test/bootstrap_restore_is_reported_not_just_logged.test')
require('./bootstrap_service.test/ensure_bootstrap_maria_db.test')
require('./bootstrap_service.test/bootstrap_archive_cleanup_after_a_restore_attempt.test')
require('./bootstrap_service.test/maria_db_module_freshness.test')
require('./bootstrap_service.test/restore_bootstrap_utxo_tracker_fresh_extract.test')
require('./bootstrap_service.test/restore_bootstrap_maria_db_happy_path.test')
require('./bootstrap_service.test/ensure_dir_writable_docker_fallback_dir_exists_not_wri.test')
require('./bootstrap_service.test/make_bootstrap_utxo_tracker_happy_path.test')
require('./bootstrap_service.test/make_bootstrap_utxo_tracker_happy_path_2.test')
require('./bootstrap_service.test/make_bootstrap_maria_db_happy_path.test')
require('./bootstrap_service.test/bootstrap_listing_and_staging_safety.test')
