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
 ********************************************************************/

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

describe('TelemetryService.gatherModules() (via gatherPayload)', function () {

    function loadWithStatus(statusObj) {
        const getStatus = sinon.stub().resolves(statusObj)
        const svc = proxyquire('../../src/services/TelemetryService', {
            './StatusService': { getStatus },
            // avoid spawning a real `docker version`
            'child_process': { execFile: (cmd, args, cb) => cb(null, '') }
        })
        return svc
    }

    it('adds a null-safe `health` field and leaves `running` a pure liveness signal', async function () {
        const svc = loadWithStatus({
            btc: {
                mainnet: {
                    // healthy running container
                    encoder: { status: { State: { Status: 'running', Health: { Status: 'healthy' } } } },
                    // running but health probe is red
                    decoder: { status: { State: { Status: 'running', Health: { Status: 'unhealthy' } } } },
                    // running, no healthcheck configured at all
                    node: { status: { State: { Status: 'running' } } },
                    // stopped container
                    indexer: { status: { State: { Status: 'exited' } } }
                }
            }
        })

        const payload = await svc.gatherPayload('heartbeat', 'install-abc')
        const byName = {}
        payload.modules.forEach(m => { byName[m.module] = m })

        // running semantics unchanged: derived purely from State.Status === 'running'
        expect(byName.encoder.running).to.equal(true)
        expect(byName.decoder.running).to.equal(true)
        expect(byName.node.running).to.equal(true)
        expect(byName.indexer.running).to.equal(false)

        // additive health field carries the docker health string, null when absent
        expect(byName.encoder.health).to.equal('healthy')
        expect(byName.decoder.health).to.equal('unhealthy')
        expect(byName.node.health).to.equal(null)
        expect(byName.indexer.health).to.equal(null)
    })

    it('never throws a TypeError when status shape is sparse', async function () {
        const svc = loadWithStatus({
            btc: { mainnet: { node: {} } }
        })
        const payload = await svc.gatherPayload('heartbeat', 'install-abc')
        expect(payload.modules[0]).to.include({ module: 'node', running: false, health: null })
    })
})
