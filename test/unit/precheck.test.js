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
        createDatabase:      sinon.stub().resolves(),
        checkAllRemoteVersions: sinon.stub().resolves(),
        getStatus:              sinon.stub().resolves(),
        checkContainerdDataRootRelocation: sinon.stub().resolves(null),
        updateHub:              sinon.stub().resolves(),
        updateExplorer:         sinon.stub().resolves(),
        installHubModule:       sinon.stub().resolves(),
        applyHubApiKeyFromSidecar: sinon.stub().resolves()
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
            createDockerNetwork:              sinon.stub().resolves(),
            checkContainerdDataRootRelocation: stubs.checkContainerdDataRootRelocation
        },
        './services/ConfigService':    {
            getDockerNetwork:          () => 'xchain',
            applyHubApiKeyFromSidecar: stubs.applyHubApiKeyFromSidecar
        },
        './services/VersionService':   { checkAllRemoteVersions: stubs.checkAllRemoteVersions },
        './services/StatusService':    { getStatus: stubs.getStatus },
        './services/HubService':       { installHubModule: stubs.installHubModule, updateHub: stubs.updateHub },
        './services/ExplorerService':  { updateExplorer: stubs.updateExplorer },
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
            getExternalDbConfig: sinon.stub().resolves({ host: '203.0.113.9', port: 3306 })
        })
        await precheck.preCheck(false, false)
        expect(stubs.createDatabase.firstCall.args[0].host).to.equal('203.0.113.9')
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

describe('preCheck(): remote version check degrades gracefully @regression', function () {

    it('a GitHub 403 rate-limit rejection does not abort preCheck', async function () {
        const { precheck, stubs } = loadPrecheck({
            checkAllRemoteVersions: sinon.stub().rejects(new Error('API rate limit exceeded (403)'))
        })
        const log = sinon.stub(console, 'log')
        try {
            await precheck.preCheck(true, false)
        } finally {
            log.restore()
        }
        // Degrades: status still fetched, but without remote-version columns.
        expect(stubs.getStatus.calledOnce).to.be.true
        expect(stubs.getStatus.firstCall.args[3]).to.be.false
        expect(log.args.some(a => String(a[0]).includes('rate-limited'))).to.be.true
    })

    it('a successful version check keeps checkVersions=true for getStatus', async function () {
        const { precheck, stubs } = loadPrecheck({})
        await precheck.preCheck(true, false)
        expect(stubs.checkAllRemoteVersions.calledOnce).to.be.true
        expect(stubs.getStatus.firstCall.args[3]).to.be.true
    })

    it('checkVersions=false skips the remote version fetch entirely', async function () {
        const { precheck, stubs } = loadPrecheck({})
        await precheck.preCheck(false, false)
        expect(stubs.checkAllRemoteVersions.called).to.be.false
        expect(stubs.getStatus.firstCall.args[3]).to.be.false
    })
})

describe('preCheck(): containerd data-root relocation warning @regression', function () {

    it('prints a warning when Docker data-root moved off / but containerd is still on /', async function () {
        const { precheck } = loadPrecheck({
            checkContainerdDataRootRelocation: sinon.stub().resolves({
                dockerRootDir: '/misc/docker', containerdRoot: '/var/lib/containerd'
            })
        })
        const log = sinon.stub(console, 'log')
        try {
            await precheck.preCheck(false, false)
        } finally {
            log.restore()
        }
        expect(log.args.some(a => String(a[0]).includes('containerd'))).to.be.true
    })

    it('prints no containerd warning when the probe reports no relocation hazard', async function () {
        const { precheck } = loadPrecheck({
            checkContainerdDataRootRelocation: sinon.stub().resolves(null)
        })
        const log = sinon.stub(console, 'log')
        try {
            await precheck.preCheck(false, false)
        } finally {
            log.restore()
        }
        expect(log.args.some(a => String(a[0]).includes('containerd'))).to.be.false
    })

    it('does not block the command when the containerd probe throws', async function () {
        const { precheck, stubs } = loadPrecheck({
            checkContainerdDataRootRelocation: sinon.stub().rejects(new Error('probe blew up'))
        })
        // preCheck must still complete its normal flow despite the probe failing.
        await precheck.preCheck(false, false)
        expect(stubs.createDatabase.calledOnce).to.be.true
    })
})

// updateHub() reports the coin networks a shared container could not be
// attached to instead of swallowing the docker error and returning true. The
// hub and explorer pushes are separate targets, so that rejection must not also
// skip the explorer's: it would leave a second service on stale config for a
// fault that is not its own.
describe('preCheck(): hub/explorer config push @regression', function () {

    it('still pushes explorer config when updateHub rejects, and fails the command', async function () {
        const updateHub      = sinon.stub().rejects(new Error('xchain-hub -> bitcoin/mainnet unreachable'))
        const updateExplorer = sinon.stub().resolves()
        const { precheck }   = loadPrecheck({ updateHub, updateExplorer })

        const log = sinon.stub(console, 'log')
        let threw = null
        try {
            await precheck.preCheck(false, true)
        } catch (err) {
            threw = err
        } finally {
            log.restore()
        }

        expect(threw).to.be.an('error')
        expect(threw.message).to.equal('There was an error trying to update the hub module')
        expect(updateExplorer.calledOnce).to.be.true
        expect(log.args.some(a => String(a[0]).includes('bitcoin/mainnet'))).to.be.true
    })

    it('pushes both and returns true when neither rejects', async function () {
        const updateHub      = sinon.stub().resolves()
        const updateExplorer = sinon.stub().resolves()
        const { precheck }   = loadPrecheck({ updateHub, updateExplorer })

        expect(await precheck.preCheck(false, true)).to.be.true
        expect(updateHub.calledOnce).to.be.true
        expect(updateExplorer.calledOnce).to.be.true
    })
})

// preCheck provisions the hub BEFORE commander parses the action's arguments, so
// for its whole history the one module installed from this file was also the one
// module no `install <ref>` could influence: it always took the default branch.
// A frozen-ref release e2e therefore graded a release stack with a master hub,
// and the hub is the config oracle every other service reads.
describe('preCheck: the hub is staged at the ref the command named', function () {

    it('passes the ref through to installHubModule', async function () {
        const installHubModule = sinon.stub().resolves()
        const { precheck } = loadPrecheck({ installHubModule })

        await precheck.preCheck(false, true, 'release/v0.10.0')

        expect(installHubModule.calledOnce).to.be.true
        expect(installHubModule.firstCall.args[0]).to.equal('release/v0.10.0')
    })

    it('passes null when the command named no ref, preserving the old behaviour', async function () {
        const installHubModule = sinon.stub().resolves()
        const { precheck } = loadPrecheck({ installHubModule })

        await precheck.preCheck(false, true)

        expect(installHubModule.calledOnce).to.be.true
        expect(installHubModule.firstCall.args[0]).to.equal(null)
    })
})

// `validator init` mints HUB_API_KEY into config/hub.local and the hub container
// deploys keyed from that sidecar, but HubConnector only sends process.env.HUB_API_KEY,
// which dotenv fills from .env alone. Nothing bridged the two, so on every validator
// host provisioned per the runbook the CLI's own updateconfig push was keyless against
// a keyed hub: `install xchain-hub` started the hub, then failed "HTTP 401" on the
// push, and so did every state-changing command after it (reported by a community
// testnet validator, 2026-09-02).
describe('preCheck: the CLI presents the sidecar HUB_API_KEY to the hub @regression', function () {

    const saved = process.env.HUB_API_KEY
    afterEach(function () {
        if (saved === undefined) delete process.env.HUB_API_KEY
        else process.env.HUB_API_KEY = saved
    })

    it('hydrates process.env from the sidecar before the hub is installed or pushed to', async function () {
        delete process.env.HUB_API_KEY
        const applyHubApiKeyFromSidecar = sinon.stub().callsFake(async (target) => {
            target.HUB_API_KEY = 'sidecar-key'
        })
        const installHubModule = sinon.stub().callsFake(async () => {
            expect(process.env.HUB_API_KEY).to.equal('sidecar-key')
        })
        const updateHub = sinon.stub().callsFake(async () => {
            expect(process.env.HUB_API_KEY).to.equal('sidecar-key')
        })
        const { precheck } = loadPrecheck({ applyHubApiKeyFromSidecar, installHubModule, updateHub })

        await precheck.preCheck(false, true)

        expect(applyHubApiKeyFromSidecar.calledOnce).to.be.true
        expect(applyHubApiKeyFromSidecar.firstCall.args[0]).to.equal(process.env)
        expect(installHubModule.calledOnce).to.be.true
        expect(updateHub.calledOnce).to.be.true
        expect(applyHubApiKeyFromSidecar.calledBefore(installHubModule)).to.be.true
    })

    it('runs the hydration through the real sidecar reader with a host-env key left untouched', async function () {
        // The real reader, not a stub: host env wins, and an unset key with no
        // sidecar on disk stays unset (never minted).
        const cs = require('../../src/services/ConfigService')
        process.env.HUB_API_KEY = 'host-env-key'
        await cs.applyHubApiKeyFromSidecar(process.env)
        expect(process.env.HUB_API_KEY).to.equal('host-env-key')
    })

    it('is a no-op on a host with no sidecar (a standalone install stays keyless)', async function () {
        delete process.env.HUB_API_KEY
        const { precheck, stubs } = loadPrecheck({})
        await precheck.preCheck(false, true)
        expect(stubs.applyHubApiKeyFromSidecar.calledOnce).to.be.true
        expect(process.env.HUB_API_KEY).to.equal(undefined)
    })
})
