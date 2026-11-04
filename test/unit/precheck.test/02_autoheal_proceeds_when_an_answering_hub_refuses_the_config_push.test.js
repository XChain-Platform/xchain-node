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

const sinon      = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function loadPrecheck(updateHub, redact) {
    const updateExplorer = sinon.stub().resolves()
    const precheck = proxyquire('../../../src/precheck.js', {
        'fs': { existsSync: () => true, mkdirSync: () => {} },
        './config': configStub({
            dataDir: '/tmp/x', moduleDir: '/tmp/x', tmpDir: '/tmp/x', containersFilesDir: '/tmp/x',
            EXTERNAL_DB: false
        }),
        './state': { db: { createDatabase: sinon.stub().resolves() }, isVerbose: () => false },
        './utils/helpers': { redactSecrets: redact || ((e) => e) },
        './services/docker_service': {
            checkDockerInstalledAndReachable: sinon.stub().resolves(),
            createDockerNetwork:              sinon.stub().resolves(),
            checkContainerdDataRootRelocation: sinon.stub().resolves(null),
            checkMemoryLimitSupport:           sinon.stub().resolves(null)
        },
        './services/config_service': {
            getDockerNetwork: () => 'xchain',
            applyHubApiKeyFromSidecar: sinon.stub().resolves()
        },
        './services/version_service': { checkAllRemoteVersions: sinon.stub().resolves() },
        './services/status_service':  { getStatus: sinon.stub().resolves() },
        './services/hub_service': {
            installHubModule: sinon.stub().resolves(),
            updateHub,
            isHubAnswering: sinon.stub().resolves(true)
        },
        './services/explorer_service': { updateExplorer },
        './services/database_service': {
            buildDatabaseModule:    sinon.stub().resolves(),
            ensureXchainNodeAccess: sinon.stub().resolves({ user: 'u', password: 'p', database: 'xchain_node' }),
            getDatabaseHostPort:    sinon.stub().resolves(13306),
            getExternalDbConfig:    sinon.stub().resolves({})
        },
        './services/discovery_service': { scanAndRegisterModules: sinon.stub().resolves() }
    })
    return { precheck, updateExplorer }
}

const refusal = () => sinon.stub().rejects(new Error('Consensus timeout for seq 324 (received 1 prepares, 0 commits, need 2)'))

describe('preCheck(): a command that does not need the hub config survives an answering hub that refuses the push @regression', function () {
    it('lets autoheal through on a warning and still pushes to the explorer', async function () {
        const { precheck, updateExplorer } = loadPrecheck(refusal(), (e) => 'R:' + e.message)
        const log = sinon.stub(console, 'log')
        let result = null
        try {
            result = await precheck.preCheck(false, true, null, true, { hubPushOptional: true })
        } finally {
            log.restore()
        }
        expect(result).to.be.true
        expect(updateExplorer.calledOnce).to.be.true
        expect(log.args.some(a => String(a[0]).includes('refused its config push'))).to.be.true
        // The logged cause goes through redactSecrets.
        expect(log.args.some(a => String(a[0]).startsWith('R:Consensus timeout'))).to.be.true
    })

    it('still aborts every other command against the same hub', async function () {
        const { precheck } = loadPrecheck(refusal())
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
        expect(threw.message).to.equal('There was an error trying to update the hub module')
    })
})

const SIGNALS = ['exit', 'SIGINT', 'SIGTERM']

// installDispatch adds exit and signal listeners; drop the ones a test added.
function isolateSignalListeners() {
    let before
    beforeEach(() => { before = {}; for (const ev of SIGNALS) before[ev] = process.listeners(ev) })
    afterEach(() => {
        for (const ev of SIGNALS) for (const fn of process.listeners(ev)) if (!before[ev].includes(fn)) process.removeListener(ev, fn)
        sinon.restore()
    })
}

async function runDispatch(argv) {
    const { Command } = require('commander')
    const { installDispatch } = require('../../../src/cli/dispatch')
    const deps = {
        config: {}, action: sinon.stub(), setVerbose: sinon.stub(),
        maybeSelfUpdateBeforeUpdate: sinon.stub().resolves(), redactSecrets: (s) => s,
        acquireCommandLock: sinon.stub().returns(sinon.stub()), preCheck: sinon.stub().resolves(),
        refForPreCheck: sinon.stub().returns(null), commandRepairsHub: sinon.stub().returns(true),
        maybeReportTelemetry: sinon.stub().resolves(), noticeNewerRelease: sinon.stub().resolves()
    }
    const program = new Command()
    program.exitOverride()
    program.option('--verbose').option('--no-telemetry')
    installDispatch(program, deps)
    for (const name of ['autoheal', 'update', 'reset']) program.command(name).allowUnknownOption().argument('[args...]').action(deps.action)
    await program.parseAsync(argv, { from: 'user' })
    return deps
}

describe('CLI dispatch: autoheal tells preCheck its hub push is optional @regression', function () {
    isolateSignalListeners()
    const run = runDispatch

    it('passes hubPushOptional for autoheal --dry-run and reaches the action', async function () {
        const deps = await run(['autoheal', '--dry-run'])
        expect(deps.preCheck.calledOnce).to.be.true
        expect(deps.preCheck.firstCall.args[4]).to.deep.equal({ hubPushOptional: true })
        expect(deps.action.calledOnce).to.be.true
    })

    it('does not pass it for another command', async function () {
        const deps = await run(['update', 'xchain-hub'])
        expect(deps.preCheck.firstCall.args[4]).to.equal(undefined)
    })
})

describe('CLI dispatch: an update of the indexer or decoder survives a hub that refuses its push @regression', function () {
    isolateSignalListeners()
    const run = runDispatch

    it('passes it for an update of the indexer or decoder, whatever the argument order', async function () {
        for (const argv of [
            ['update', 'xchain-indexer', 'dogecoin', 'regtest', 'develop'],
            ['update', 'regtest', 'develop', 'litecoin', 'xchain-indexer'],
            ['update', 'xchain-decoder', 'bitcoin', 'regtest']
        ]) {
            const deps = await run(argv)
            expect(deps.preCheck.firstCall.args[4], argv.join(' ')).to.deep.equal({ hubPushOptional: true })
            expect(deps.action.calledOnce).to.be.true
        }
    })

    it('does not pass it for update all, another service, or an argument shape resolveArgs refuses', async function () {
        for (const argv of [
            ['update', 'develop'],
            ['update', 'all', 'regtest', 'develop'],
            ['update', 'xchain-explorer', 'develop'],
            ['update', 'xchain-encoder', 'bitcoin', 'regtest'],
            ['update', 'xchain-node']
        ]) {
            const deps = await run(argv)
            expect(deps.preCheck.firstCall.args[4], argv.join(' ')).to.equal(undefined)
        }
    })
})

describe('CLI dispatch: reset hub-checkpoints survives the hub it repairs refusing the push @regression', function () {
    isolateSignalListeners()

    it('passes hubPushOptional for reset hub-checkpoints and nothing for an indexer reset', async function () {
        const repair = await runDispatch(['reset', 'hub-checkpoints', '--yes', '--with-capabilities'])
        expect(repair.preCheck.firstCall.args[4]).to.deep.equal({ hubPushOptional: true })
        expect(repair.action.calledOnce).to.be.true
        const indexer = await runDispatch(['reset', 'xchain-indexer', 'dogecoin', 'regtest'])
        expect(indexer.preCheck.firstCall.args[4]).to.equal(undefined)
    })
})
