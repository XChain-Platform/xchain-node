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
 * DiscoveryService: container classification + registry reconciliation.
 *
 * Regression (a litecoin-mainnet xchain-indexer, 2026-06-11): the scan
 * keyed on the container's IMAGE name. Rebuilding a module's image while the
 * old container kept running steals the tag; docker reports the container's
 * image as a bare ID, so the scan went blind to a live container, and the
 * orphan purge then DELETED its registry row. From then on update/start/stop
 * silently no-op'd for that module while `sync` reported "already in sync".
 * Identity now comes from the CONTAINER NAME only; the image never decides it.
 ********************************************************************/

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function loadService({ containers = [], db = {} } = {}) {
    const dbStub = {
        // setModuleContainer answers true/false rather than throwing, and the
        // scan now honors that answer, so the stub has to model it truthfully.
        getModuleContainer:     sinon.stub().resolves(null),
        setModuleContainer:  sinon.stub().resolves(true),
        getAllModuleContainers: sinon.stub().resolves([]),
        deleteModuleContainer:  sinon.stub().resolves(),
        assertReady:            sinon.stub(),
        ...db,
    }
    const svc = proxyquire('../../src/services/discovery_service', {
        'child_process': {
            execFile: (cmd, args, cb) => cb(null, containers.map(c => JSON.stringify(c)).join('\n')),
        },
        '../state': { db: dbStub },
    })
    return { svc, db: dbStub }
}

const { svc } = loadService()

describe('DiscoveryService.classifyContainer', function () {
    it('keys on the container NAME even when the image tag was stolen (bare image ID)', function () {
        // The incident case: image rebuilt out from under a running container.
        expect(svc.classifyContainer({
            Names: 'xchain-node-litecoin-mainnet-xchain-indexer',
            Image: 'b237b2d40093',
        })).to.deep.equal({ module: 'xchain-indexer', coin: 'litecoin', network: 'mainnet' })
    })

    it('never classifies a container outside the naming scheme by its module image', function () {
        // Another stack on the same host (here a compose project) runs the same
        // module images; claiming its containers would point every command at them.
        for (const [name, image] of [
            ['other-stack-hub-1',       'xchain-node-xchain-hub'],
            ['other-stack-db-1',        'xchain-node-database'],
            ['other-stack-doge-miner-1', 'xchain-node-dogecoin-regtest-xchain-regtest-miner'],
            ['my-custom-name',          'xchain-node-bitcoin-regtest-xchain-decoder'],
        ]) {
            expect(svc.classifyContainer({ Names: name, Image: image }), name).to.equal(null)
        }
        // This install's own names still classify whatever image they run.
        expect(svc.classifyContainer({ Names: 'xchain-node-xchain-hub', Image: 'xchain-node-xchain-hub' }))
            .to.deep.equal({ module: 'xchain-hub', coin: '', network: '' })
        expect(svc.classifyContainer({
            Names: 'xchain-node-bitcoin-regtest-xchain-utxo-tracker',
            Image: 'xchain-node-bitcoin-regtest-xchain-utxo-tracker',
        })).to.deep.equal({ module: 'xchain-utxo-tracker', coin: 'bitcoin', network: 'regtest' })
    })

    it('classifies shared modules (no coin/network)', function () {
        expect(svc.classifyContainer({ Names: 'xchain-node-database', Image: 'mariadb:11' }))
            .to.deep.equal({ module: 'database', coin: '', network: '' })
        expect(svc.classifyContainer({ Names: 'xchain-node-xchain-hub', Image: 'x' }))
            .to.deep.equal({ module: 'xchain-hub', coin: '', network: '' })
        expect(svc.classifyContainer({ Names: 'xchain-node-xchain-explorer', Image: 'x' }))
            .to.deep.equal({ module: 'xchain-explorer', coin: '', network: '' })
        // Regression (2026-07-09): sync was missing from SHARED_MODULES, so
        // 'xchain-sync' fell through to the coin/network parser (2 parts < 3)
        // and returned null; the per-command orphan purge then deleted its
        // live (xchain-sync,'','') registry row and sync ops silently no-op'd.
        expect(svc.classifyContainer({ Names: 'xchain-node-xchain-sync', Image: 'x' }))
            .to.deep.equal({ module: 'xchain-sync', coin: '', network: '' })
    })
})

describe('DiscoveryService.classifyContainer', function () {

    it('classifies the coin node module', function () {
        expect(svc.classifyContainer({ Names: 'xchain-node-dogecoin-testnet-node', Image: 'x' }))
            .to.deep.equal({ module: 'node', coin: 'dogecoin', network: 'testnet' })
    })

    it('tolerates docker API name variants (array form, leading slash)', function () {
        expect(svc.classifyContainer({
            Names: ['/xchain-node-bitcoin-mainnet-xchain-indexer'],
            Image: 'whatever',
        })).to.deep.equal({ module: 'xchain-indexer', coin: 'bitcoin', network: 'mainnet' })
    })

    it('exempts the one-shot e2e-test runner from classification (never registered)', function () {
        // The run path installs xchain-e2e-test with onlyExecution=true and skips the
        // registry insert; the discovery scan must mirror that so a transient e2e
        // container (or a crash-left carcass) is never recorded as an installed module.
        expect(svc.classifyContainer({ Names: 'xchain-node-bitcoin-regtest-xchain-e2e-test', Image: 'x' }))
            .to.equal(null)
        expect(svc.classifyContainer({ Names: 'renamed', Image: 'xchain-node-bitcoin-regtest-xchain-e2e-test' }))
            .to.equal(null)
    })

    it('returns null for foreign containers and malformed identities', function () {
        expect(svc.classifyContainer({ Names: 'nginx', Image: 'nginx:latest' })).to.equal(null)
        expect(svc.classifyContainer({ Names: 'xchain-node-fakecoin-mainnet-xchain-indexer', Image: 'x' })).to.equal(null)
        expect(svc.classifyContainer({ Names: 'xchain-node-bitcoin-mainnet', Image: 'x' })).to.equal(null)
        expect(svc.classifyContainer({ Names: 'xchain-node-bitcoin-mainnet-not-a-module', Image: 'x' })).to.equal(null)
        expect(svc.classifyContainer({ Names: '', Image: '' })).to.equal(null)
    })
})

describe('DiscoveryService.scanAndRegisterModules', function () {

    afterEach(() => sinon.restore())

    it('registers a live container whose image tag was stolen (the incident case)', async function () {
        const { svc, db } = loadService({
            containers: [{
                Names: 'xchain-node-litecoin-mainnet-xchain-indexer',
                Image: 'b237b2d40093',                       // bare ID: old scan skipped this
                ID:    'cafebabecafebabecafebabe',
                State: 'running',
            }],
        })
        const changed = await svc.scanAndRegisterModules({ silent: true })
        expect(changed).to.equal(1)
        sinon.assert.calledWith(db.setModuleContainer,
            'xchain-indexer', 'litecoin', 'mainnet', 'cafebabecafebabecafebabe')
    })

    it('does NOT purge the registry row of a live, name-keyed container', async function () {
        const { svc, db } = loadService({
            containers: [{
                Names: 'xchain-node-litecoin-mainnet-xchain-indexer',
                Image: 'b237b2d40093',
                ID:    'cafebabecafebabecafebabe',
                State: 'running',
            }],
            db: {
                getModuleContainer:     sinon.stub().resolves('cafebabecafebabecafebabe'),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-indexer', coin: 'litecoin', network: 'mainnet', container_id: 'cafebabecafebabecafebabe' },
                ]),
            },
        })
        const changed = await svc.scanAndRegisterModules({ silent: true })
        expect(changed).to.equal(0)
        sinon.assert.notCalled(db.deleteModuleContainer)
    })
})

describe('DiscoveryService.scanAndRegisterModules', function () {

    afterEach(() => sinon.restore())

    it('does NOT purge the live sync service row (shared, coin/network-independent)', async function () {
        // Regression (2026-07-09): with sync absent from SHARED_MODULES its key
        // never entered `seen`, so every CLI command's sweep purged the row
        // buildAndUp had just inserted.
        const { svc, db } = loadService({
            containers: [{
                Names: 'xchain-node-xchain-sync', Image: 'xchain-node-xchain-sync',
                ID: 'sync1234sync1234', State: 'running',
            }],
            db: {
                getModuleContainer:     sinon.stub().resolves('sync1234sync1234'),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-sync', coin: '', network: '', container_id: 'sync1234sync1234' },
                ]),
            },
        })
        const changed = await svc.scanAndRegisterModules({ silent: true })
        expect(changed).to.equal(0)
        sinon.assert.notCalled(db.deleteModuleContainer)
    })

    it('still purges genuinely orphaned rows', async function () {
        const { svc, db } = loadService({
            containers: [],
            db: {
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-decoder', coin: 'bitcoin', network: 'testnet', container_id: 'deadbeef' },
                ]),
            },
        })
        const changed = await svc.scanAndRegisterModules({ silent: true })
        expect(changed).to.equal(1)
        sinon.assert.calledWith(db.deleteModuleContainer, 'xchain-decoder', 'bitcoin', 'testnet')
    })

    it('reconciles a stale container_id in place', async function () {
        const { svc, db } = loadService({
            containers: [{
                Names: 'xchain-node-database', Image: 'xchain-node-database',
                ID: 'newid', State: 'running',
            }],
            db: {
                getModuleContainer:     sinon.stub().resolves('oldid'),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'database', coin: '', network: '', container_id: 'oldid' },
                ]),
            },
        })
        const changed = await svc.scanAndRegisterModules({ silent: true })
        expect(changed).to.equal(1)
        sinon.assert.calledWith(db.setModuleContainer, 'database', '', '', 'newid')
        sinon.assert.notCalled(db.deleteModuleContainer)
    })
})

// A regtest stack was reported "lost" because a probe read
// the registry through an unconfigured store, which answers [] instead of
// erroring. The store's fail-open is what makes that indistinguishable from an
// empty install, so every path that ACTS on the row set now asserts first.
describe('DiscoveryService.scanAndRegisterModules fail-closed registry', function () {

    it('refuses to scan against an unconfigured store instead of reporting a clean run', async function () {
        const { svc } = loadService({
            containers: [{
                Names: 'xchain-node-database', Image: 'xchain-node-database',
                ID: 'abc', State: 'running',
            }],
            db: {
                assertReady: sinon.stub().throws(new Error('MariaDbStore is not connected')),
            },
        })
        let err = null
        try { await svc.scanAndRegisterModules({ silent: true }) } catch (e) { err = e }
        expect(err, 'scan should surface the unconfigured store').to.not.equal(null)
        expect(err.message).to.match(/not connected/)
    })

    it('throws when the registry write fails rather than counting the row as added', async function () {
        const { svc, db } = loadService({
            containers: [{
                Names: 'xchain-node-database', Image: 'xchain-node-database',
                ID: 'abc', State: 'running',
            }],
            db: {
                setModuleContainer: sinon.stub().resolves(false),
            },
        })
        let err = null
        try { await svc.scanAndRegisterModules({ silent: true }) } catch (e) { err = e }
        expect(err, 'a swallowed write error must not read as success').to.not.equal(null)
        expect(err.message).to.match(/Couldn't register database/)
        sinon.assert.calledOnce(db.setModuleContainer)
    })

    it('throws when a reconcile write fails', async function () {
        const { svc } = loadService({
            containers: [{
                Names: 'xchain-node-database', Image: 'xchain-node-database',
                ID: 'newid', State: 'running',
            }],
            db: {
                getModuleContainer:    sinon.stub().resolves('oldid'),
                setModuleContainer: sinon.stub().resolves(false),
            },
        })
        let err = null
        try { await svc.scanAndRegisterModules({ silent: true }) } catch (e) { err = e }
        expect(err).to.not.equal(null)
        expect(err.message).to.match(/Couldn't reconcile database/)
    })
})

// A container started by hand from a module image under another name is not a
// module, so it must never take the row from the container holding the CLI name.
describe('DiscoveryService.scanAndRegisterModules name-over-image ranking', function () {

    afterEach(() => sinon.restore())

    const IMAGE = 'xchain-node-bitcoin-mainnet-xchain-indexer'
    const debug = { Names: 'some-debug-name', Image: IMAGE, ID: 'debugdebugdebugdebug', State: 'running' }
    const real  = { Names: IMAGE, Image: IMAGE, ID: 'realrealrealrealreal', State: 'running' }

    it('gives the row to the named container when a newer image-only container also runs', async function () {
        const { svc, db } = loadService({ containers: [debug, real] })
        await svc.scanAndRegisterModules({ silent: true })
        sinon.assert.calledWith(db.setModuleContainer, 'xchain-indexer', 'bitcoin', 'mainnet', 'realrealrealrealreal')
        sinon.assert.neverCalledWith(db.setModuleContainer, 'xchain-indexer', 'bitcoin', 'mainnet', 'debugdebugdebugdebug')
    })

    it('leaves a row already holding the named container alone', async function () {
        const { svc, db } = loadService({
            containers: [debug, real],
            db: {
                getModuleContainer:     sinon.stub().resolves('realrealrealrealreal'),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-indexer', coin: 'bitcoin', network: 'mainnet', container_id: 'realrealrealrealreal' },
                ]),
            },
        })
        const changed = await svc.scanAndRegisterModules({ silent: true })
        expect(changed).to.equal(0)
        sinon.assert.notCalled(db.setModuleContainer)
    })

    it('keeps the row on a stopped named container over a running image-only one', async function () {
        const { svc, db } = loadService({ containers: [debug, { ...real, State: 'exited' }] })
        await svc.scanAndRegisterModules({ silent: true })
        sinon.assert.calledOnceWithExactly(db.setModuleContainer, 'xchain-indexer', 'bitcoin', 'mainnet', 'realrealrealrealreal')
    })

    it('registers nothing when only containers outside the naming scheme run module images', async function () {
        const stale = { Names: 'renamed-old', Image: IMAGE, ID: 'staleSTALEstaleSTALE', State: 'exited' }
        const live  = { Names: 'other-stack-indexer-1', Image: IMAGE, ID: 'liveLIVEliveLIVElive', State: 'running' }
        const { svc, db } = loadService({ containers: [stale, live] })
        await svc.scanAndRegisterModules({ silent: true })
        sinon.assert.notCalled(db.setModuleContainer)
    })
})
