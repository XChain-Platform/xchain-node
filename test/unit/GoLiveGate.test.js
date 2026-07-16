'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')

const {
    assertGoLiveReady,
    collectViolations,
    findFlagDayPlaceholders,
    FLAG_DAY_PLACEHOLDER
} = require('../../src/services/GoLiveGate')

const GATE_ENV_VARS = [
    'XCHAIN_NODE_GO_LIVE', 'XCHAIN_NODE_SKIP_GO_LIVE_GATE',
    'XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP',
    'INDEXER_API_KEY', 'HUB_API_KEY', 'API_KEY', 'ENCODER_API_KEY', 'SYNC_API_KEY'
]

describe('GoLiveGate', () => {
    let savedEnv, warnStub, tmpDir

    // A module dir with a clean src tree (no placeholder timestamps).
    const makeModuleDir = (files = { 'src/index.js': 'module.exports = 1' }) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-'))
        tmpDir = dir
        for (const [rel, content] of Object.entries(files)) {
            const full = path.join(dir, rel)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            fs.writeFileSync(full, content)
        }
        return dir
    }

    // Env every write surface needs so key checks pass.
    const armedKeys = { INDEXER_API_KEY: 'k', HUB_API_KEY: 'k', API_KEY: 'k', SYNC_API_KEY: 'k' }

    beforeEach(() => {
        savedEnv = {}
        for (const name of GATE_ENV_VARS) {
            savedEnv[name] = process.env[name]
            delete process.env[name]
        }
        warnStub = sinon.stub(console, 'warn')
        tmpDir = null
    })

    afterEach(() => {
        for (const name of GATE_ENV_VARS) {
            if (savedEnv[name] === undefined) delete process.env[name]
            else process.env[name] = savedEnv[name]
        }
        warnStub.restore()
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    describe('scope', () => {
        it('ignores read surfaces (decoder) on mainnet even when armed', () => {
            process.env.XCHAIN_NODE_GO_LIVE = '1'
            expect(() => assertGoLiveReady('xchain-decoder', 'bitcoin', 'mainnet', {}, makeModuleDir())).to.not.throw()
            expect(warnStub.called).to.equal(false)
        })

        it('ignores write surfaces on regtest even when armed', () => {
            process.env.XCHAIN_NODE_GO_LIVE = '1'
            expect(() => assertGoLiveReady('xchain-indexer', 'bitcoin', 'regtest', {}, makeModuleDir())).to.not.throw()
            expect(warnStub.called).to.equal(false)
        })
    })

    describe('pre-launch (XCHAIN_NODE_GO_LIVE unset): warn-only', () => {
        it('warns but does not throw on a mainnet indexer with missing keys', () => {
            expect(() => assertGoLiveReady('xchain-indexer', 'bitcoin', 'mainnet', {}, makeModuleDir())).to.not.throw()
            expect(warnStub.calledOnce).to.equal(true)
            expect(warnStub.firstCall.args[0]).to.include('INDEXER_API_KEY')
            expect(warnStub.firstCall.args[0]).to.include('HUB_API_KEY')
        })

        it('is silent when everything is armed', () => {
            const env = { INDEXER_API_KEY: 'k', HUB_API_KEY: 'k' }
            expect(() => assertGoLiveReady('xchain-indexer', 'bitcoin', 'mainnet', env, makeModuleDir())).to.not.throw()
            expect(warnStub.called).to.equal(false)
        })
    })

    describe('armed (XCHAIN_NODE_GO_LIVE=1): refuses', () => {
        beforeEach(() => { process.env.XCHAIN_NODE_GO_LIVE = '1' })

        it('refuses a mainnet indexer with missing keys, itemizing violations', () => {
            expect(() => assertGoLiveReady('xchain-indexer', 'bitcoin', 'mainnet', {}, makeModuleDir()))
                .to.throw(/REFUSING.*\n.*INDEXER_API_KEY[\s\S]*HUB_API_KEY/)
        })

        it('refuses the shared hub (no coin/network) with no HUB_API_KEY', () => {
            expect(() => assertGoLiveReady('xchain-hub', null, null, {}, makeModuleDir()))
                .to.throw(/HUB_API_KEY/)
        })

        it('refuses an open mainnet encoder (no API_KEY)', () => {
            expect(() => assertGoLiveReady('xchain-encoder', 'bitcoin', 'mainnet', {}, makeModuleDir()))
                .to.throw(/API_KEY.*broadcast_tx/)
        })

        it('refuses when flag-day placeholder timestamps remain in src', () => {
            const dir = makeModuleDir({
                'src/protocol_changes.js': "addChange('MINT_SELF_MINTED_ONLY','2.0.0'," + FLAG_DAY_PLACEHOLDER + ',0,0,0,0,0);'
            })
            const env = { INDEXER_API_KEY: 'k', HUB_API_KEY: 'k' }
            expect(() => assertGoLiveReady('xchain-indexer', 'bitcoin', 'mainnet', env, dir))
                .to.throw(new RegExp(FLAG_DAY_PLACEHOLDER + '.*protocol_changes\\.js'))
        })

        it('refuses when signed-bootstrap enforcement is opted out', () => {
            process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
            const env = { INDEXER_API_KEY: 'k', HUB_API_KEY: 'k' }
            expect(() => assertGoLiveReady('xchain-indexer', 'bitcoin', 'mainnet', env, makeModuleDir()))
                .to.throw(/REQUIRE_SIGNED_BOOTSTRAP/)
        })

        it('passes a fully armed deploy', () => {
            Object.assign(process.env, armedKeys)
            for (const module of ['xchain-indexer', 'xchain-encoder']) {
                expect(() => assertGoLiveReady(module, 'bitcoin', 'mainnet', {}, makeModuleDir())).to.not.throw()
                fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null
            }
            expect(() => assertGoLiveReady('xchain-hub', null, null, {}, makeModuleDir())).to.not.throw()
            expect(warnStub.called).to.equal(false)
        })

        it('honors the explicit skip escape hatch, loudly', () => {
            process.env.XCHAIN_NODE_SKIP_GO_LIVE_GATE = '1'
            expect(() => assertGoLiveReady('xchain-indexer', 'bitcoin', 'mainnet', {}, makeModuleDir())).to.not.throw()
            expect(warnStub.calledOnce).to.equal(true)
            expect(warnStub.firstCall.args[0]).to.include('SKIPPED')
        })
    })

    describe('collectViolations key resolution', () => {
        it('accepts keys from the generated container env over host env', () => {
            const violations = collectViolations('xchain-indexer', { INDEXER_API_KEY: 'k', HUB_API_KEY: 'k' }, null)
            expect(violations).to.deep.equal([])
        })

        it('falls back to host env for passthrough-only keys', () => {
            process.env.SYNC_API_KEY = 'k'
            expect(collectViolations('xchain-sync', {}, null)).to.deep.equal([])
        })
    })

    describe('findFlagDayPlaceholders', () => {
        it('finds the placeholder anywhere under src/ but skips node_modules', () => {
            const dir = makeModuleDir({
                'src/deep/activation.js': 'const T = ' + FLAG_DAY_PLACEHOLDER,
                'src/node_modules/dep.js': 'const T = ' + FLAG_DAY_PLACEHOLDER,
                'test/outside.js': 'const T = ' + FLAG_DAY_PLACEHOLDER
            })
            expect(findFlagDayPlaceholders(dir)).to.deep.equal([path.join('src', 'deep', 'activation.js')])
        })

        it('returns empty for a module with no src dir', () => {
            expect(findFlagDayPlaceholders(makeModuleDir({ 'lib/a.js': 'x' }))).to.deep.equal([])
        })
    })
})
