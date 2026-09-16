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

// A `docker inspect --format {{json .Config.Env}}` response for one container.
function inspectStub(envsByName) {
    return sinon.stub().callsFake(async (cmd, args) => {
        const name = args[args.length - 1]
        const env = envsByName[name]
        if (!env) throw new Error('No such container: ' + name)
        return { stdout: JSON.stringify(Object.keys(env).map(k => `${k}=${env[k]}`)) + '\n' }
    })
}

describe('DbCredentialDrift', () => {

    describe('readContainerEnv', () => {

        it('parses docker inspect output into a plain object', async () => {
            const { readContainerEnv } = load()
            const execFileAsync = inspectStub({ dec: { A: '1', DECODER_DB_PASS: 'x=y' } })
            const env = await readContainerEnv('dec', { execFileAsync })
            expect(env).to.deep.equal({ A: '1', DECODER_DB_PASS: 'x=y' })
        })

        it('returns null for a container that does not exist', async () => {
            const { readContainerEnv } = load()
            const env = await readContainerEnv('missing', { execFileAsync: inspectStub({}) })
            expect(env).to.equal(null)
        })

        it('returns null on unparseable output rather than throwing', async () => {
            const { readContainerEnv } = load()
            const execFileAsync = sinon.stub().resolves({ stdout: 'not json' })
            expect(await readContainerEnv('dec', { execFileAsync })).to.equal(null)
        })
    })
})
