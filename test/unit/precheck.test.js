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
//
// preCheck() opens the process-wide xchain_node pool. In EXTERNAL_DB mode the
// host/port must come from getExternalDbConfig() (env → saved credentials.json
// → prompt), NOT the load-time EXTERNAL_DB_HOST/PORT constants: those default
// to 127.0.0.1:3306, so an operator who supplied the host only at the first-run
// prompt had the pool opened against the wrong server on every command
// (uuid:52c5b5f1, the bug ensureDatabasePool already guards against).

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function loadPrecheck(overrides) {
    const stubs = Object.assign({
        externalDb:          false,
        getExternalDbConfig: sinon.stub().resolves({ host: 'saved.example.com', port: 3307 }),
        getDatabaseHostPort: sinon.stub().resolves(13306),
        createDatabase:      sinon.stub().resolves()
    }, overrides)

    const precheck = proxyquire('../../src/precheck.js', {
        'fs': { existsSync: () => true, mkdirSync: () => {} },
        './config/constants': {
            dataDir: '/tmp/x', moduleDir: '/tmp/x', tmpDir: '/tmp/x', containersFilesDir: '/tmp/x',
            EXTERNAL_DB: stubs.externalDb
        },
        './state': { db: { createDatabase: stubs.createDatabase }, isVerbose: () => false },
        './utils/helpers': { redactSecrets: (e) => e },
        './services/DockerService': {
            checkDockerInstalledAndReachable: sinon.stub().resolves(),
            createDockerNetwork:              sinon.stub().resolves()
        },
        './services/ConfigService':    { getDockerNetwork: () => 'xchain' },
        './services/VersionService':   { checkAllRemoteVersions: sinon.stub().resolves() },
        './services/StatusService':    { getStatus: sinon.stub().resolves() },
        './services/HubService':       { installHubModule: sinon.stub().resolves(), updateHub: sinon.stub().resolves() },
        './services/ExplorerService':  { updateExplorer: sinon.stub().resolves() },
        './services/DatabaseService': {
            buildDatabaseModule:   sinon.stub().resolves(),
            ensureXchainNodeAccess: sinon.stub().resolves({ user: 'u', password: 'p', database: 'xchain_node' }),
            getDatabaseHostPort:   stubs.getDatabaseHostPort,
            getExternalDbConfig:   stubs.getExternalDbConfig
        },
        './services/DiscoveryService': { scanAndRegisterModules: sinon.stub().resolves() }
    })
    return { precheck, stubs }
}

describe('preCheck(): xchain_node pool host/port resolution @regression', function () {

    it('EXTERNAL_DB → opens the pool against the getExternalDbConfig() host/port', async function () {
        const { precheck, stubs } = loadPrecheck({ externalDb: true })
        await precheck.preCheck(false, false)
        expect(stubs.getExternalDbConfig.calledOnce).to.be.true
        expect(stubs.createDatabase.calledOnce).to.be.true
        const args = stubs.createDatabase.firstCall.args[0]
        expect(args.host).to.equal('saved.example.com')
        expect(args.port).to.equal(3307)
        // The docker port-forward lookup is the non-external path only.
        expect(stubs.getDatabaseHostPort.called).to.be.false
    })

    it('EXTERNAL_DB → never falls back to the 127.0.0.1 load-time default', async function () {
        const { precheck, stubs } = loadPrecheck({
            externalDb: true,
            getExternalDbConfig: sinon.stub().resolves({ host: '10.0.0.9', port: 3306 })
        })
        await precheck.preCheck(false, false)
        expect(stubs.createDatabase.firstCall.args[0].host).to.equal('10.0.0.9')
    })

    it('docker mode → 127.0.0.1 with the live container port-forward', async function () {
        const { precheck, stubs } = loadPrecheck({ externalDb: false })
        await precheck.preCheck(false, false)
        const args = stubs.createDatabase.firstCall.args[0]
        expect(args.host).to.equal('127.0.0.1')
        expect(args.port).to.equal(13306)
        expect(stubs.getExternalDbConfig.called).to.be.false
    })

    it('a failing external-DB resolution surfaces as the pool-open error', async function () {
        const { precheck } = loadPrecheck({
            externalDb: true,
            getExternalDbConfig: sinon.stub().rejects(new Error('no route to host'))
        })
        try {
            await precheck.preCheck(false, false)
            expect.fail('preCheck should have thrown')
        } catch (err) {
            expect(err.message).to.equal("Couldn't open the xchain_node MariaDB database")
        }
    })
})
