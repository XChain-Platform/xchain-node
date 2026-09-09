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
        // Default: the hub answers. Everything below the config push behaves as
        // it always has unless a test says the hub is down.
        isHubAnswering:         sinon.stub().resolves(true),
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
        './services/HubService':       {
            installHubModule: stubs.installHubModule,
            updateHub:        stubs.updateHub,
            isHubAnswering:   stubs.isHubAnswering
        },
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

// A hub that is crash-looping (a rebuild that left it holding the wrong database
// password is the usual way in) answers nothing, so preCheck's config push spends
// ten attempts on connection refusals and then aborts. It aborted EVERY command,
// `update xchain-hub` included, which is the command that rebuilds the hub and
// ends the crash loop; removing the container by hand was the only way out.
describe('preCheck(): a hub that is not answering does not wedge its own repair @regression', function () {

    // What a crash-looping hub does to the config push: every attempt refused.
    const refused = () => sinon.stub().rejects(
        new Error('There was a problem trying to update a config in the xchain-hub module (connect ECONNREFUSED)'))

    it('lets a repairing command through on a warning, skipping the push', async function () {
        const updateHub = sinon.stub().resolves()
        const { precheck, stubs } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(false),
            updateHub
        })
        const log = sinon.stub(console, 'log')
        let result = null
        try {
            result = await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
        }

        expect(result).to.be.true
        // Skipped, not retried: the ten attempts three seconds apart are the delay
        // that made the wedge look like a hang.
        expect(updateHub.calledOnce).to.be.true
        expect(updateHub.firstCall.args[0]).to.deep.equal({ skipConfigPush: true })
        // The explorer is a separate target and is still pushed to.
        expect(stubs.updateExplorer.calledOnce).to.be.true
        expect(log.args.some(a => String(a[0]).includes('config push was skipped'))).to.be.true
    })

    it('still continues when the skipped push leaves updateHub rejecting anyway', async function () {
        // The network attaches updateHub still makes can fail on their own; a
        // repairing command must not be aborted by that either, or the wedge is
        // simply moved one call along.
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(false),
            updateHub: sinon.stub().rejects(new Error('xchain-hub -> bitcoin/regtest unreachable'))
        })
        const log = sinon.stub(console, 'log')
        let result = null
        try {
            result = await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
        }
        expect(result).to.be.true
        expect(log.args.some(a => String(a[0]).includes('bitcoin/regtest'))).to.be.true
    })

    it('a NON-repairing command still aborts against a hub that is not answering', async function () {
        const updateHub = refused()
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(false),
            updateHub
        })
        const log = sinon.stub(console, 'log')
        let threw = null
        try {
            await precheck.preCheck(false, true, null, false)
        } catch (err) {
            threw = err
        } finally {
            log.restore()
        }

        expect(threw).to.be.an('error')
        // Loud, and it names the way out instead of leaving the operator to find it.
        expect(threw.message).to.contain('There was an error trying to update the hub module')
        expect(threw.message).to.contain('not answering')
        expect(threw.message).to.contain('update xchain-hub')
        // The push was attempted: nothing is silenced for a command that needs a hub.
        expect(updateHub.firstCall.args[0]).to.deep.equal({ skipConfigPush: false })
    })

    it('a repairing command against a HEALTHY hub still pushes and still fails on a real error', async function () {
        const updateHub = refused()
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(true),
            updateHub
        })
        const log = sinon.stub(console, 'log')
        let threw = null
        try {
            await precheck.preCheck(false, true, null, true)
        } catch (err) {
            threw = err
        } finally {
            log.restore()
        }

        expect(threw).to.be.an('error')
        // A hub that answers gets the unchanged message: no repair hint, because
        // the fault is not that the hub is down.
        expect(threw.message).to.equal('There was an error trying to update the hub module')
        expect(updateHub.firstCall.args[0]).to.deep.equal({ skipConfigPush: false })
    })

    it('treats a liveness probe that throws as "not answering"', async function () {
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().rejects(new Error('no hub config on this host')),
            updateHub: sinon.stub().resolves()
        })
        const log = sinon.stub(console, 'log')
        let result = null
        try {
            result = await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
        }
        expect(result).to.be.true
        expect(log.args.some(a => String(a[0]).includes('config push was skipped'))).to.be.true
    })

    it('is not consulted at all for a read-only command that skips the push', async function () {
        const { precheck, stubs } = loadPrecheck({})
        await precheck.preCheck(false, false, null, true)
        expect(stubs.isHubAnswering.called).to.be.false
        expect(stubs.updateHub.called).to.be.false
    })

    // The sidecar key must be in process.env before ANYTHING talks to the hub,
    // and the liveness probe is new traffic on that path: an unhealthy hub is
    // exactly where an ordering mistake would hide, because the branch is new.
    it('hydrates the sidecar key before the liveness probe on the unhealthy path', async function () {
        const saved = process.env.HUB_API_KEY
        delete process.env.HUB_API_KEY
        const applyHubApiKeyFromSidecar = sinon.stub().callsFake(async (target) => {
            target.HUB_API_KEY = 'sidecar-key'
        })
        const isHubAnswering = sinon.stub().callsFake(async () => {
            expect(process.env.HUB_API_KEY).to.equal('sidecar-key')
            return false
        })
        const { precheck } = loadPrecheck({
            applyHubApiKeyFromSidecar, isHubAnswering, updateHub: sinon.stub().resolves()
        })
        const log = sinon.stub(console, 'log')
        try {
            await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
            if (saved === undefined) delete process.env.HUB_API_KEY
            else process.env.HUB_API_KEY = saved
        }
        expect(applyHubApiKeyFromSidecar.calledOnce).to.be.true
        expect(isHubAnswering.calledOnce).to.be.true
        expect(applyHubApiKeyFromSidecar.calledBefore(isHubAnswering)).to.be.true
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
