'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    sinon,
    expect,
    PassThrough,
    XChainService,
    COIN,
    NETWORK,
    FAKE_CONTAINER_ID,
    makeAutoSpawn,
    findSnapshotCall,
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

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureDirWritable(): Docker fallback (dir exists, not writable)', function () {
        it('invokes docker mkdir/chown/chmod when outputDir exists but accessSync throws', async function () {
            const stubs = makeStubs()

            // existsSync: workDir=false (so ensureDir creates it); outputDir=true (exists)
            stubs.fs.existsSync.callsFake(p => {
                // workDir does not exist
                if (p.includes('bootstrap-work')) return false
                // outputDir (/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/) exists
                return true
            })

            // accessSync throws → fall through to Docker approach
            stubs.fs.accessSync.throws(new Error('EACCES: permission denied'))

            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            // All execFile calls succeed (snapshot cleanup, du, snapshot, docker
            // mkdir/chown/chmod)
            stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })

            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            const result = await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(result).to.be.true

            // Verify Docker fallback was invoked (chown + chmod calls)
            const execCalls = stubs.execFile.getCalls().map(c => c.args)
            const dockerCalls = execCalls.filter(([cmd, args]) => cmd === 'docker' && Array.isArray(args))
            const chownCall = dockerCalls.find(([, args]) => args.includes('chown'))
            const chmodCall = dockerCalls.find(([, args]) => args.includes('chmod'))
            expect(chownCall).to.exist
            expect(chmodCall).to.exist
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('creates a bootstrap for utxo-tracker: stops container, tars, checksums, wraps, restarts', async function () {
            const stubs = makeStubs()

            stubs.fs.existsSync.returns(false)  // workDir does not exist
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                if (cmd === 'docker' && args.includes('du')) {
                    return Promise.resolve({ stdout: '104857600\t/data\n' })
                }
                return Promise.resolve({ stdout: '' })
            })

            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            const result = await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(result).to.be.true
            expect(stubs.dockerService.stopContainer.calledWith(FAKE_CONTAINER_ID)).to.be.true
            expect(stubs.dockerService.startContainer.calledWith(FAKE_CONTAINER_ID)).to.be.true
        })
    })
})


    // Without the snapshot, the monthly publish holds the tracker down for
    // the whole compress: 2026-08-01 cost 3h36m on BTC, 1h04m on LTC and
    // 42m on DOGE, each of which the mainnet encoder published as
    // tracker_reachable:false. The container must come back BEFORE the tar.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('restarts the tracker before the compress, off a hardlink snapshot', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '104857600\t/data\n' })
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })

            let startedBeforeFirstSpawn = null
            const spawnCalls = makeAutoSpawn(stubs)
            const rawSpawn = stubs.spawn
            stubs.spawn = sinon.stub().callsFake((cmd, args) => {
                if (startedBeforeFirstSpawn === null) {
                    startedBeforeFirstSpawn = stubs.dockerService.startContainer.called
                }
                return rawSpawn(cmd, args)
            })

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

            // The outage is over before any compression starts.
            expect(startedBeforeFirstSpawn).to.be.true
            expect(stubs.dockerService.startContainer.callCount).to.equal(1)

            // The snapshot is a hardlink farm taken inside the volume, with the
            // mutable files detached from the live inodes. Pinned verbatim: this
            // exact text is what test/../scratch verification runs against real
            // busybox, and a silent edit here would go unvalidated.
            const snapshotCall = findSnapshotCall(stubs.execFile)
            expect(snapshotCall, 'expected a docker sh -c snapshot call').to.exist
            expect(snapshotCall[1]).to.include('xchain-utxo-tracker-bitcoin-mainnet-data:/data')
            expect(snapshotCall[1][snapshotCall[1].length - 1]).to.equal([
                'set -e',
                'rm -rf /data/.xchain-bootstrap-snapshot',
                'mkdir -p /data/.xchain-bootstrap-snapshot',
                "find /data -mindepth 1 -maxdepth 1 ! -name .xchain-bootstrap-snapshot -exec cp -al {} /data/.xchain-bootstrap-snapshot/ ';'",
                "find /data/.xchain-bootstrap-snapshot -type f ! -name '*.ldb' ! -name '*.sst' ! -name '*.xcsnap'" +
                    ` -exec sh -c 'cp -a "$1" "$1.xcsnap" && mv -f "$1.xcsnap" "$1"' _ {} ';'`
            ].join('\n'))

            // ...and the compress reads the snapshot, not the live store.
            const dockerTar = spawnCalls.find(c => c.cmd === 'docker' && c.args.includes('tar'))
            expect(dockerTar).to.exist
            expect(dockerTar.args).to.include('/data/.xchain-bootstrap-snapshot')
            expect(dockerTar.args).to.not.include('/data')

            // The snapshot is dropped again so it stops pinning compacted SSTs.
            const rmCalls = stubs.execFile.getCalls().map(c => c.args)
                .filter(([cmd, args]) => cmd === 'docker' && Array.isArray(args) &&
                    args.includes('rm') && args.includes('/data/.xchain-bootstrap-snapshot'))
            expect(rmCalls.length).to.be.at.least(2)  // stale-snapshot sweep + teardown
        })
    })
})


    // The outer archive only carries a checksum next
    // to an already-gzipped payload, so re-deflating 162.5 GB bought
    // nothing. Level 0 keeps the file a real .gz for every consumer.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('wraps the outer archive with a store-only gzip, not a second deflate', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '104857600\t/data\n' })
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })

            const gzipOptions = []
            stubs.zlib.createGzip = sinon.stub().callsFake(opts => {
                gzipOptions.push(opts)
                return new PassThrough()
            })

            const spawnCalls = makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

            // No `tar czf` anywhere: the wrap is a plain tar plus level-0 gzip.
            const czf = stubs.execFile.getCalls().map(c => c.args)
                .find(([cmd, args]) => cmd === 'tar' && Array.isArray(args) && args[0] === 'czf')
            expect(czf, 'outer archive must not be built with tar czf').to.not.exist

            const wrap = spawnCalls.find(c => c.cmd === 'tar')
            expect(wrap, 'expected a plain tar spawn for the outer archive').to.exist
            expect(wrap.args.slice(0, 2)).to.deep.equal(['cf', '-'])
            expect(wrap.args).to.include('data.tar.gz')
            expect(wrap.args).to.include('data.sha256')
            // The metadata member leads the wrapper (see BootstrapArchiveMeta).
            expect(wrap.args.slice(-3)).to.deep.equal(['bootstrap.json', 'data.tar.gz', 'data.sha256'])
            expect(stubs.archiveMeta.writeBootstrapMeta.calledOnce).to.equal(true)
            expect(stubs.archiveMeta.writeBootstrapMeta.firstCall.args[1]).to.include({ module: XChainService.XCHAIN_UTXO_TRACKER, height: null })

            // Inner payload keeps real compression; the outer wrap does not.
            expect(gzipOptions).to.have.length(2)
            expect(gzipOptions[0]).to.equal(undefined)
            expect(gzipOptions[1]).to.deep.equal({ level: 0 })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('checksums the inner archive inline instead of re-reading it', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '104857600\t/data\n' })
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.fs.createReadStream = sinon.stub().throws(new Error('the inner archive must not be re-read'))

            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

            // The digest written to data.sha256 is the digest of the bytes the
            // gzip stream actually emitted (the fake gzip is a PassThrough, so
            // that is the tar payload verbatim).
            const expected = require('crypto').createHash('sha256').update(Buffer.from('tar-bytes')).digest('hex')
            const [, body] = stubs.fs.promises.writeFile.getCall(0).args
            expect(body).to.equal(`${expected}  data.tar.gz\n`)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('falls back to compressing with the tracker stopped when the snapshot fails', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })

            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args.includes('sh')) {
                    return Promise.reject(new Error('cp: cannot create hard link'))
                }
                return Promise.resolve({ stdout: '104857600\t/data\n' })
            })

            let startedBeforeFirstSpawn = null
            const spawnCalls = makeAutoSpawn(stubs)
            const rawSpawn = stubs.spawn
            stubs.spawn = sinon.stub().callsFake((cmd, args) => {
                if (startedBeforeFirstSpawn === null) {
                    startedBeforeFirstSpawn = stubs.dockerService.startContainer.called
                }
                return rawSpawn(cmd, args)
            })

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

            // Old behavior, on purpose: a volume that cannot take hardlinks
            // still gets a correct archive, just with the outage back.
            expect(startedBeforeFirstSpawn).to.be.false
            expect(stubs.dockerService.startContainer.callCount).to.equal(1)
            const dockerTar = spawnCalls.find(c => c.cmd === 'docker' && c.args.includes('tar'))
            expect(dockerTar.args).to.include('/data')
            expect(dockerTar.args).to.not.include('/data/.xchain-bootstrap-snapshot')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('aborts before compressing when a failed snapshot cannot be cleaned up', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })

            // The stale-snapshot sweep before the stop succeeds; the snapshot
            // itself fails, and so does the cleanup of its debris. Tarring /data
            // now would sweep a half-built snapshot into the published archive.
            let rmCalls = 0
            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args.includes('sh')) {
                    return Promise.reject(new Error('cp: cannot create hard link'))
                }
                if (cmd === 'docker' && Array.isArray(args) && args.includes('rm')) {
                    rmCalls++
                    if (rmCalls > 1) return Promise.reject(new Error('rm: permission denied'))
                }
                return Promise.resolve({ stdout: '104857600\t/data\n' })
            })

            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            const err = await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.message).to.include('rm: permission denied')
            expect(stubs.spawn.called, 'must not compress a polluted volume').to.be.false
            // The tracker still comes back up.
            expect(stubs.dockerService.startContainer.calledWith(FAKE_CONTAINER_ID)).to.be.true
        })
    })
})
