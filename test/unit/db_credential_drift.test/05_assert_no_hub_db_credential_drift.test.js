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

const sinon = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const DECODER = 'xchain-decoder'
const INDEXER = 'xchain-indexer'
const HUB     = 'xchain-hub'

// The shared hub account every co-located install provisions under its own prefix.
const HUB_USER = 'xchain_hub'

function load() {
    return proxyquire('../../../src/services/db_credential_drift', {
        '../config': configStub({
            XChainService: { XCHAIN_DECODER: DECODER, XCHAIN_INDEXER: INDEXER },
            HUB_MODULE_NAME: HUB
        }),
        './config_service': {
            getDockerContainerImageName: (mod, coin, net) => `xchain-node-${coin}-${net}-${mod}`
        }
    })
}

// A docker daemon that answers both `ps` (the name sweep) and `inspect` (the env read).
function dockerStub(envsByName) {
    return sinon.stub().callsFake(async (cmd, args) => {
        if (args[0] === 'ps') return { stdout: Object.keys(envsByName).join('\n') + '\n' }
        const name = args[args.length - 1]
        const env = envsByName[name]
        if (!env) throw new Error('No such container: ' + name)
        return { stdout: JSON.stringify(Object.keys(env).map(k => `${k}=${env[k]}`)) + '\n' }
    })
}

describe('DbCredentialDrift', () => {

    describe('assertNoHubDbCredentialDrift', () => {

        const HUB_CONTAINERS = {
            'xchain-node-xchain-hub':    { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'hpass' },
            'scratch-clone-xchain-hub':  { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'sibling-secret' },
            'xchain-node-dogecoin-regtest-xchain-indexer': { HUB_DB_USER: 'xchain_indexer', HUB_DB_PASS: 'ipass' }
        }

        it('resolves when every holder of the shared account agrees', async () => {
            const { assertNoHubDbCredentialDrift } = load()
            const drift = await assertNoHubDbCredentialDrift(
                { user: HUB_USER, pass: 'hpass' },
                {
                    execFileAsync: dockerStub({
                        'xchain-node-xchain-hub': { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'hpass' }
                    }),
                    env: {}
                })
            expect(drift).to.deep.equal([])
        })

        // The sibling hub runs under another NODE_PREFIX, so a name-derived lookup
        // would never see it; the daemon sweep is what makes it visible.
        it('throws a tagged error naming a sibling hub under a different prefix', async () => {
            const { assertNoHubDbCredentialDrift, DRIFT_ERROR_CODE } = load()
            let thrown = null
            try {
                await assertNoHubDbCredentialDrift(
                    { user: HUB_USER, pass: 'hpass' },
                    { execFileAsync: dockerStub(HUB_CONTAINERS), env: {} })
            } catch (err) { thrown = err }
            expect(thrown).to.be.an('error')
            expect(thrown.code).to.equal(DRIFT_ERROR_CODE)
            expect(thrown.drift).to.have.length(1)
            expect(thrown.message).to.contain('scratch-clone-xchain-hub')
            expect(thrown.message).to.contain(`recreate ${HUB}`)
            // The refusal reaches logs and bug reports, so it may never carry a value.
            expect(thrown.message).to.not.contain('sibling-secret')
            expect(thrown.message).to.not.contain('hpass')
        })
    })

    describe('assertNoHubDbCredentialDrift', () => {

        const HUB_CONTAINERS = {
            'xchain-node-xchain-hub':    { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'hpass' },
            'scratch-clone-xchain-hub':  { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'sibling-secret' },
            'xchain-node-dogecoin-regtest-xchain-indexer': { HUB_DB_USER: 'xchain_indexer', HUB_DB_PASS: 'ipass' }
        }

        it('ignores a container the caller is about to replace, and never inspects it', async () => {
            const { assertNoHubDbCredentialDrift } = load()
            const docker = dockerStub({
                'xchain-node-xchain-hub': { HUB_DB_USER: HUB_USER, HUB_DB_PASS: 'stale' }
            })
            const drift = await assertNoHubDbCredentialDrift(
                { user: HUB_USER, pass: 'hpass' },
                { execFileAsync: docker, env: {}, excludeContainers: ['xchain-node-xchain-hub'] })
            expect(drift).to.deep.equal([])
            const inspected = docker.getCalls()
                .filter(c => c.args[1][0] === 'inspect')
                .map(c => c.args[1][c.args[1].length - 1])
            expect(inspected).to.not.contain('xchain-node-xchain-hub')
        })

        it('treats an unreadable docker daemon as no drift', async () => {
            const { assertNoHubDbCredentialDrift } = load()
            const drift = await assertNoHubDbCredentialDrift(
                { user: HUB_USER, pass: 'hpass' },
                { execFileAsync: sinon.stub().rejects(new Error('Cannot connect to the Docker daemon')), env: {} })
            expect(drift).to.deep.equal([])
        })

        it('proceeds with a warning when the override env is set', async () => {
            const { assertNoHubDbCredentialDrift, DRIFT_OVERRIDE_ENV } = load()
            const log = sinon.stub(console, 'log')
            try {
                const drift = await assertNoHubDbCredentialDrift(
                    { user: HUB_USER, pass: 'hpass' },
                    { execFileAsync: dockerStub(HUB_CONTAINERS), env: { [DRIFT_OVERRIDE_ENV]: '1' } })
                expect(drift).to.have.length(1)
            } finally {
                log.restore()
            }
        })
    })
})
