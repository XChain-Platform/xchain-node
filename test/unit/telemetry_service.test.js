/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * XChain Node - Telemetry Service unit tests
 ********************************************************************/

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
 * XChain Node - Telemetry Service unit tests
 ********************************************************************/
const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

function loadTelemetry({ env = '', pref = null, status = {} } = {}) {
    let savedPref = pref
    const report = sinon.stub().resolves()
    const fs = {
        readFileSync: sinon.stub().callsFake(() => {
            if (savedPref === null) throw new Error('missing preference')
            return JSON.stringify(savedPref)
        }),
        existsSync: sinon.stub().returns(true),
        mkdirSync: sinon.stub(),
        writeFileSync: sinon.stub().callsFake((filePath, value) => {
            savedPref = JSON.parse(value)
        }),
        chmodSync: sinon.stub()
    }
    const svc = proxyquire('../../src/services/telemetry_service', {
        fs,
        os: {
            homedir: () => '/operator',
            platform: () => 'linux',
            release: () => '6.12.0',
            arch: () => 'x64'
        },
        crypto: { randomUUID: () => 'generated-install-id' },
        child_process: { execFile: (command, args, options, callback) => callback(null, '27.3.1\n') },
        './status_service': { getStatus: sinon.stub().resolves(status) },
        './telemetry_connector': class { constructor() { this.report = report } },
        '../config': { XCHAIN_NODE_NO_TELEMETRY: env }
    })
    return { svc, report, fs, getSavedPref: () => savedPref }
}

function loadWithStatus(statusObj) {
    const getStatus = sinon.stub().resolves(statusObj)
    return proxyquire('../../src/services/telemetry_service', {
        './status_service': { getStatus },
        'child_process': { execFile: (cmd, args, cb) => cb(null, '') }
    })
}

describe('TelemetryService opt-out precedence', function () {

    it('gives the CLI flag priority and persists that choice', async function () {
        const harness = loadTelemetry({ env: 'false', pref: { optOut: false } })

        await harness.svc.maybeReportTelemetry('install', true)

        sinon.assert.notCalled(harness.report)
        expect(harness.getSavedPref().optOut).to.equal(true)
    })

    it('honours the environment when the CLI flag is absent', async function () {
        const harness = loadTelemetry({ env: 'yes', pref: { optOut: false } })

        await harness.svc.maybeReportTelemetry('install', false)

        sinon.assert.notCalled(harness.report)
        expect(harness.getSavedPref().optOut).to.equal(true)
    })

    it('honours the saved preference when flag and environment are absent', async function () {
        const harness = loadTelemetry({ pref: { optOut: true } })

        await harness.svc.maybeReportTelemetry('install', false)

        sinon.assert.notCalled(harness.report)
        sinon.assert.notCalled(harness.fs.writeFileSync)
    })

    it('reports when flag, environment, and preference all allow it', async function () {
        const harness = loadTelemetry({ pref: { optOut: false, installId: 'existing-install-id' } })

        await harness.svc.maybeReportTelemetry('install', false)

        sinon.assert.calledOnce(harness.report)
    })
})

describe('TelemetryService.gatherModules() (via gatherPayload)', function () {
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

describe('TelemetryService payload privacy', function () {

    it('emits only allowlisted payload keys with no IP or host field', async function () {
        const { svc } = loadTelemetry({
            status: {
                btc: {
                    mainnet: {
                        node: {
                            container_version: '1.2.3',
                            status: { State: { Status: 'running', Health: { Status: 'healthy' } } }
                        }
                    }
                }
            }
        })

        const payload = await svc.gatherPayload('heartbeat', 'install-abc')
        expect(Object.keys(payload).sort()).to.deep.equal([
            'arch', 'docker_version', 'event', 'install_id', 'modules',
            'node_version', 'os_platform', 'os_release'
        ])
        expect(Object.keys(payload.modules[0]).sort()).to.deep.equal([
            'coin', 'health', 'module', 'network', 'running', 'version'
        ])
        expect(Object.keys(payload).concat(Object.keys(payload.modules[0])))
            .not.to.satisfy(keys => keys.some(key => /(^|_)(host|ip)($|_)/i.test(key)))
    })
})
