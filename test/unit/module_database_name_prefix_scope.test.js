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

const { expect } = require('chai')
const path = require('path')

const SRC = path.resolve(__dirname, '../../src') + path.sep

// NODE_PREFIX is read once when src/config loads, so a prefixed stack needs a fresh load
// of every src module. Snapshot the require cache and the env var, then put both back so
// later suites keep their default-prefix singletons.
function isSrc(id) { return id.startsWith(SRC) }

const { scopedNodePrefixSegment, DB_NAME_MAX, HUB_MIRROR_SUFFIX, unscopedDefaultDatabaseName } = require('../../src/utils/module_database_name')
const seg = scopedNodePrefixSegment('stack-b.test', 'xchain-node', '_')
const scopedDecoder = 'XChain_' + seg + 'BTC_Mainnet_Decoder'
const scopedDecoderUser = 'xchain_' + seg + 'decoder_bitcoin_mainnet'
const scopedIndexerUser = 'xchain_' + seg + 'indexer_bitcoin_mainnet'

describe('prefix segment budget', function () {
    it('is empty for the default prefix', function () {
        expect(scopedNodePrefixSegment('xchain-node', 'xchain-node')).to.equal('')
    })
    it('keeps prefixes that fold to the same text distinct', function () {
        expect(scopedNodePrefixSegment('a-b', 'x')).to.not.equal(scopedNodePrefixSegment('a_b', 'x'))
        expect(scopedNodePrefixSegment('stack-b.test', 'x')).to.not.equal(scopedNodePrefixSegment('stack_b_test', 'x'))
    })
    it('keeps the longest indexer name plus _HubMirror within 64 characters', function () {
        const long = 'a-very-long-node-prefix-that-overflows-every-budget'
        const name = unscopedDefaultDatabaseName('xchain-indexer', 'DOGE', 'testnet').replace('XChain_', 'XChain_' + scopedNodePrefixSegment(long, 'x'))
        expect(name.length + HUB_MIRROR_SUFFIX.length).to.be.at.most(DB_NAME_MAX)
        expect(scopedNodePrefixSegment(long, 'x')).to.not.equal(scopedNodePrefixSegment(long + '2', 'x'))
    })
})

describe('module database names under a non-default NODE_PREFIX', function () {
    const EXTERNAL_ENV = { XCHAIN_NODE_EXTERNAL_DB: '1', XCHAIN_NODE_EXTERNAL_DB_HOST: '127.0.0.1',
        XCHAIN_NODE_EXTERNAL_DB_PORT: '3306', XCHAIN_NODE_EXTERNAL_DB_ROOT_USER: 'root',
        XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: 'unit-test-only' }
    let savedCache, savedPrefix, savedExternal, prefixed

    before(function () {
        savedPrefix = process.env.NODE_PREFIX
        savedCache = {}
        for (const id of Object.keys(require.cache)) {
            if (isSrc(id)) { savedCache[id] = require.cache[id]; delete require.cache[id] }
        }
        savedExternal = {}
        for (const k of Object.keys(EXTERNAL_ENV)) savedExternal[k] = process.env[k]
        process.env.NODE_PREFIX = 'stack-b.test'
        Object.assign(process.env, EXTERNAL_ENV)
        prefixed = require('../../src/services/config_service')
    })

    after(function () {
        if (savedPrefix === undefined) delete process.env.NODE_PREFIX
        else process.env.NODE_PREFIX = savedPrefix
        for (const [k, v] of Object.entries(savedExternal)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
        for (const id of Object.keys(require.cache)) {
            if (isSrc(id)) delete require.cache[id]
        }
        Object.assign(require.cache, savedCache)
    })

    it('carries the sanitized prefix in the derived database name', function () {
        expect(prefixed.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet'))
            .to.equal(scopedDecoder)
    })

    it('carries the prefix in the module DB user names', async function () {
        const decoder = await prefixed.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const indexer = await prefixed.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
        expect(decoder.DECODER_DB_USER).to.equal(scopedDecoderUser)
        expect(indexer.INDEXER_DB_USER).to.equal(scopedIndexerUser)
        expect(decoder.DECODER_DB_NAME).to.equal(scopedDecoder)
    })

    it('lets a configured name win over the scoped default in reset targets', async function () {
        const { configuredDatabaseName } = require('../../src/utils/module_database_name')
        const cs = prefixed
        const def = cs.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')
        expect(configuredDatabaseName('xchain-decoder', { DECODER_DB_NAME: 'Custom_Dec' }, def)).to.equal('Custom_Dec')
        expect(configuredDatabaseName('xchain-decoder', {}, def)).to.equal(def)
    })

    it('resolves reset targets through the configured name, not the raw derived name', async function () {
        const { resolveResetTargets } = require('../../src/services/database_service/reset_databases')
        const targets = await resolveResetTargets('bitcoin', 'mainnet', ['xchain-decoder', 'xchain-indexer'])
        expect(targets).to.deep.equal([scopedDecoder, 'XChain_' + seg + 'BTC_Mainnet_Indexer'])
        expect(targets[0]).to.not.equal('XChain_BTC_Mainnet_Decoder')
    })

    describe('legacy-collision refusal in buildAndUp', function () {
        const legacy = { 'xchain-decoder': ['DECODER_DB_NAME', 'XChain_BTC_Mainnet_Decoder'],
            'xchain-indexer': ['INDEXER_DB_NAME', 'XChain_BTC_Mainnet_Indexer'] }
        const reached = new Error('past the refusal')

        function wire(envFor) {
            const { configureDependencies, buildAndUp } = require('../../src/services/module_service/build_and_up')
            configureDependencies({
                checkIfModuleExists: () => true, checkBuildKitAvailable: async () => {},
                getDefaultConfig: async (m) => envFor(m), getModuleDir: () => '/nonexistent',
                getDockerContainerImageName: (m) => m, config: require('../../src/config'),
                execFileAsync: async () => ({ stdout: '' }),
                // First step after the refusal in assertDeploymentReady; proves ordering.
                goLiveGate: { assertGoLiveReady: () => { throw reached } }
            })
            return buildAndUp
        }

        for (const module of Object.keys(legacy)) {
            it('refuses the unprefixed default name for ' + module + ' before any other deploy step', async function () {
                const [key, name] = legacy[module]
                const buildAndUp = wire(() => ({ [key]: name }))
                let err
                try { await buildAndUp(module, 'bitcoin', 'mainnet') } catch (e) { err = e }
                expect(err).to.be.instanceOf(Error)
                expect(err).to.not.equal(reached)
                expect(err.message).to.include(key + '=' + name)
            })
            it('lets the scoped name for ' + module + ' through to the next deploy step', async function () {
                const [key] = legacy[module]
                const cfg = (await prefixed.getDefaultConfig(module, 'bitcoin', 'mainnet'))
                const buildAndUp = wire(() => ({ [key]: cfg[key] }))
                let err
                try { await buildAndUp(module, 'bitcoin', 'mainnet') } catch (e) { err = e }
                expect(err).to.equal(reached)
            })
        }

        it('does not refuse other modules', async function () {
            const buildAndUp = wire(() => ({}))
            let err
            try { await buildAndUp('xchain-encoder', 'bitcoin', 'mainnet') } catch (e) { err = e }
            expect(err).to.equal(reached)
        })
    })

    describe('precheck for default names under a non-default prefix', function () {
        it('warns when the configured name is the unprefixed default', async function () {
            const { getLogger } = require('../../src/observability/logger')
            const logger = getLogger()
            const original = logger.warn
            const warnings = []
            logger.warn = (m) => { warnings.push(String(m)) }
            try {
                const { resolveCheckedDatabaseName } = require('../../src/services/migration_precondition_service')
                const name = await resolveCheckedDatabaseName('xchain-decoder', 'bitcoin', 'mainnet',
                    { getDefaultConfig: async () => ({ DECODER_DB_NAME: 'XChain_BTC_Mainnet_Decoder' }) })
                expect(name).to.equal('XChain_BTC_Mainnet_Decoder')
                expect(warnings.some(w => w.includes('unprefixed default database'))).to.equal(true)
                warnings.length = 0
                await resolveCheckedDatabaseName('xchain-decoder', 'bitcoin', 'mainnet',
                    { getDefaultConfig: async () => ({ DECODER_DB_NAME: scopedDecoder }) })
                expect(warnings.some(w => w.includes('unprefixed default database'))).to.equal(false)
            } finally { logger.warn = original }
        })
    })

    it('restores the default-prefix modules after the suite', function () {
        // Runs while the prefixed load is still cached; the real check is that after()
        // reinstates the snapshot, asserted by the sibling describe below.
        expect(process.env.NODE_PREFIX).to.equal('stack-b.test')
    })
})

describe('module database names after the prefix suite', function () {
    it('leave the default-prefix names unchanged and the env restored', async function () {
        const cs = require('../../src/services/config_service')
        expect(cs.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')).to.equal('XChain_BTC_Mainnet_Decoder')
        const cfg = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(cfg.DECODER_DB_USER).to.equal('xchain_decoder_bitcoin_mainnet')
    })
})

describe('raw getModuleDatabaseName callers', function () {
    const fs = require('fs')
    const files = []
    ;(function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) walk(full)
            else if (e.name.endsWith('.js')) files.push(full)
        }
    })(SRC)
    const allowed = new Set(['services/config_service.js', 'services/config_service/defaults.js'])

    it('resolve the name through configuredDatabaseName wherever they call it', function () {
        const offenders = []
        for (const file of files) {
            const rel = path.relative(SRC, file)
            if (allowed.has(rel)) continue
            const text = fs.readFileSync(file, 'utf8')
            const calls = text.split('\n').filter(l => /getModuleDatabaseName\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
            if (calls.length > 0 && !/configuredDatabaseName\(/.test(text)) offenders.push(rel)
        }
        expect(offenders).to.deep.equal([])
    })
})
