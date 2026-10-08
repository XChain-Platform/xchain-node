'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const { configStub } = require('../../helpers/config_stub')
const { XChainService } = require('../../../src/config')

const COIN = 'litecoin'
const NETWORK = 'mainnet'

// Load the marker reader over the native client, with the stack's config file
// answering `cfg` and every derived default carrying a recognisable name.
function loadMarkers(cfg) {
    return proxyquire('../../../src/services/bootstrap_health_gate/halt_markers.js', {
        '../../config': configStub({ XChainService, EXTERNAL_DB: true }),
        '../config_service': {
            getDefaultConfig: sinon.stub().resolves(cfg),
            getModuleDatabaseName: sinon.stub().callsFake(m => `default_${m.replace(/-/g, '_')}`)
        }
    })
}

// A clean database answering every marker query, recording each statement.
function nativeDeps() {
    const executeNativeMariaDbCommand = sinon.stub().callsFake(async (c, sql) =>
        (/information_schema\.TABLES/.test(sql) ? '1\t1' : '0'))
    return { executeNativeMariaDbCommand, getExternalDbConfig: sinon.stub().resolves({ host: 'h' }) }
}

function statements(deps) {
    return deps.executeNativeMariaDbCommand.getCalls().map(c => String(c.args[1]))
}

describe('BootstrapHealthGate', function () {
    describe('halt markers on a stack with overridden database names', function () {
        it('probes the configured indexer database and its configured paired decoder database', async function () {
            const deps = nativeDeps()
            const markers = await loadMarkers({ DECODER_DB_NAME: 'CustomDecoder', INDEXER_DB_NAME: 'CustomIndexer' })
                .readHaltMarkers(COIN, NETWORK, XChainService.XCHAIN_INDEXER, deps)
            const sql = statements(deps)
            expect(sql.some(s => s.includes('CustomIndexer'))).to.equal(true)
            expect(sql.some(s => s.includes('CustomDecoder'))).to.equal(true)
            expect(sql.some(s => s.includes('default_'))).to.equal(false)
            expect(markers.upstream.dbName).to.equal('CustomDecoder')
        })

        it('probes the derived default when the config names no database', async function () {
            const deps = nativeDeps()
            await loadMarkers({}).readHaltMarkers(COIN, NETWORK, XChainService.XCHAIN_DECODER, deps)
            expect(statements(deps).some(s => s.includes('default_xchain_decoder'))).to.equal(true)
        })

        it('refuses to probe an unsafe configured name', async function () {
            const deps = nativeDeps()
            let error = null
            try {
                await loadMarkers({ DECODER_DB_NAME: 'Custom; DROP DATABASE mysql' })
                    .readHaltMarkers(COIN, NETWORK, XChainService.XCHAIN_DECODER, deps)
            } catch (err) { error = err }
            expect(error && error.message).to.match(/Unsafe MariaDB database name/)
            expect(deps.executeNativeMariaDbCommand.called).to.equal(false)
        })
    })
})
