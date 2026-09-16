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

const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const NOW = Date.parse('2026-07-21T12:00:00Z')

function makeStubs() {
    return {
        db: { getAllModuleContainers: sinon.stub().resolves([]), assertReady: sinon.stub() },
        getStatusFromContainer: sinon.stub(),
        restartContainer: sinon.stub().resolves(true)
    }
}

function loadService(stubs) {
    return proxyquire('../../../src/services/autoheal_service', {
        '../state': { db: stubs.db },
        './docker_service': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            restartContainer: stubs.restartContainer
        },
        // Real descriptor table: asserts the actual opt-in flags too.
        './module_service': { SERVICE_HEALTHCHECK: require('../../../src/services/module_service').SERVICE_HEALTHCHECK }
    })
}

describe('AutohealService', () => {
    let stubs, service, stateDir, logStub

    beforeEach(() => {
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-test-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = stateDir
        stubs = makeStubs()
        service = loadService(stubs)
        logStub = sinon.stub(console, 'log')
    })

    afterEach(() => {
        logStub.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        delete process.env.XCHAIN_NODE_AUTOHEAL_GRACE_MS
        delete process.env.XCHAIN_NODE_AUTOHEAL_COOLDOWN_MS
        fs.rmSync(stateDir, { recursive: true, force: true })
    })

    it('rates a pass as recovery only when no restart can claim it or it outlasted probation', () => {
        const probation = service.DEFAULT_RESTART_PROBATION_MS
        expect(probation).to.equal(150 * 1000)
        // No autoheal restart to attribute the pass to: it is recovery outright.
        expect(service.isRecoveryEstablished(NOW, undefined, probation)).to.equal(true)
        expect(service.isRecoveryEstablished(NOW, NOW - probation - 1, probation)).to.equal(true)
        // Exactly at the boundary is still inside probation: the test is strict.
        expect(service.isRecoveryEstablished(NOW, NOW - probation, probation)).to.equal(false)
        expect(service.isRecoveryEstablished(NOW, NOW - 1000, probation)).to.equal(false)
        // Absence of a pass is not evidence of one.
        expect(service.isRecoveryEstablished(null, undefined, probation)).to.equal(false)
        expect(service.isRecoveryEstablished(NaN, undefined, probation)).to.equal(false)
    })

    it('caps the doubled cooldown at the ceiling instead of growing without bound', () => {
        const base = service.DEFAULT_COOLDOWN_MS
        const ceiling = service.DEFAULT_COOLDOWN_CEILING_MS

        // Attempts 0 and 1 both keep the documented base cooldown, so the first
        // retry of a fresh wedge times exactly as it always has.
        expect(service.restartBackoffMs(0, base, ceiling)).to.equal(base)
        expect(service.restartBackoffMs(1, base, ceiling)).to.equal(base)
        expect(service.restartBackoffMs(2, base, ceiling)).to.equal(base * 2)
        expect(service.restartBackoffMs(3, base, ceiling)).to.equal(base * 4)
        expect(service.restartBackoffMs(99, base, ceiling)).to.equal(ceiling)
        // 2**(attempts-1) overflows to Infinity long before this; the cap must
        // still resolve to a finite wait rather than never retrying again.
        expect(service.restartBackoffMs(5000, base, ceiling)).to.equal(ceiling)
    })
})
