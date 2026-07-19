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
 * Regression (node-host-b litecoin-mainnet xchain-indexer, 2026-06-11): the scan
 * keyed on the container's IMAGE name. Rebuilding a module's image while the
 * old container kept running steals the tag; docker reports the container's
 * image as a bare ID, so the scan went blind to a live container, and the
 * orphan purge then DELETED its registry row. From then on update/start/stop
 * silently no-op'd for that module while `sync` reported "already in sync".
 * Identity now comes from the CONTAINER NAME (image as fallback).
 ********************************************************************/

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function loadService({ containers = [], db = {} } = {}) {
    const dbStub = {
        getModuleContainer:     sinon.stub().resolves(null),
        insertModuleContainer:  sinon.stub().resolves(),
        getAllModuleContainers: sinon.stub().resolves([]),
        removeModuleContainer:  sinon.stub().resolves(),
        ...db,
    }
    const svc = proxyquire('../../src/services/DiscoveryService', {
        'child_process': {
            execFile: (cmd, args, cb) => cb(null, containers.map(c => JSON.stringify(c)).join('\n')),
        },
        '../state': { db: dbStub },
    })
    return { svc, db: dbStub }
}

describe('DiscoveryService.classifyContainer', function () {

    const { svc } = loadService()

    it('keys on the container NAME even when the image tag was stolen (bare image ID)', function () {
        // The incident case: image rebuilt out from under a running container.
        expect(svc.classifyContainer({
            Names: 'xchain-node-litecoin-mainnet-xchain-indexer',
            Image: 'b237b2d40093',
        })).to.deep.equal({ module: 'xchain-indexer', coin: 'litecoin', network: 'mainnet' })
    })

    it('falls back to the image name when the container was renamed externally', function () {
        expect(svc.classifyContainer({
            Names: 'my-custom-name',
            Image: 'xchain-node-bitcoin-regtest-xchain-decoder',
        })).to.deep.equal({ module: 'xchain-decoder', coin: 'bitcoin', network: 'regtest' })
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
        sinon.assert.calledWith(db.insertModuleContainer,
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
        sinon.assert.notCalled(db.removeModuleContainer)
    })

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
        sinon.assert.notCalled(db.removeModuleContainer)
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
        sinon.assert.calledWith(db.removeModuleContainer, 'xchain-decoder', 'bitcoin', 'testnet')
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
        sinon.assert.calledWith(db.insertModuleContainer, 'database', '', '', 'newid')
        sinon.assert.notCalled(db.removeModuleContainer)
    })
})
