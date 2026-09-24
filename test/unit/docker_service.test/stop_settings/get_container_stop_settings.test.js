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

// Pins the stop-settings readback: the stamped budget and the drain value
// come back, the rest of the env (which carries secrets) does not, and a
// docker that cannot answer reads as unknown rather than throwing.

const sinon      = require('sinon')
const { expect } = require('chai')
const { proxyquireDockerService } = require('../../../helpers/docker_service_loader')

function loadDockerService(execFile) {
    return proxyquireDockerService(require.resolve('../../../../src/services/docker_service'), {
        'child_process': { execFile, spawn: sinon.stub(), spawnSync: sinon.stub() },
        'util': { promisify: (fn) => fn },
        'fs': { readFileSync: sinon.stub() },
        'blessed': { screen: sinon.stub(), text: sinon.stub(), log: sinon.stub() }
    })
}

function answering(error, stdout) {
    return sinon.stub().callsFake((cmd, args, cb) => cb(error, stdout))
}

describe('DockerService', function () {
    describe('getContainerStopSettings()', function () {
        it('returns the stamped budget and SHUTDOWN_TIMEOUT_MS and nothing else from the env', async function () {
            const config = { StopTimeout: 300, Env: ['DECODER_DB_PASS=hunter2', 'SHUTDOWN_TIMEOUT_MS=280000'] }
            const execFile = answering(null, JSON.stringify(config) + '\n')
            const settings = await loadDockerService(execFile).getContainerStopSettings('abc123')
            expect(execFile.firstCall.args[1]).to.deep.equal(['inspect', '--format', '{{json .Config}}', 'abc123'])
            expect(settings).to.deep.equal({ stopTimeout: 300, shutdownTimeoutMs: '280000' })
        })

        it('reports each value as null when the container was created without it', async function () {
            const execFile = answering(null, JSON.stringify({ StopTimeout: null, Env: ['NETWORK=bitcoin-mainnet'] }))
            const settings = await loadDockerService(execFile).getContainerStopSettings('abc123')
            expect(settings).to.deep.equal({ stopTimeout: null, shutdownTimeoutMs: null })
        })

        it('resolves null when docker fails or answers something unparseable', async function () {
            expect(await loadDockerService(answering(new Error('no such container'), '')).getContainerStopSettings('gone')).to.equal(null)
            expect(await loadDockerService(answering(null, 'not json')).getContainerStopSettings('abc123')).to.equal(null)
        })
    })
})
