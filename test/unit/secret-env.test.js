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

// Redaction-safe secret env names for the xchain-node sidecar keys .
//
// The load-bearing cases are not the table lookups. They are: a sidecar written
// under the new names still yields a working config (otherwise renaming a venue
// key takes the stack down, which is why the rename was never rolled out); a
// rotation does not re-introduce the legacy twin next to the renamed key; and a
// half-finished rename fails loudly instead of silently authenticating with the
// credential it was supposed to have rotated away from.

const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const fs         = require('fs')
const { Readable } = require('stream')

const { SEP, configDir } = require('../../src/config/constants')
const secretEnv = require('../../src/secret-env')

function streamFromString(str) {
    const s = new Readable()
    s.push(str)
    s.push(null)
    return s
}

// Same in-memory fs harness the ConfigService suite uses: getDefaultConfig both
// reads and WRITES sidecars, and a test that let it touch the real config dir
// would rewrite the operator's credentials.
function makeMemoryConfigService(initialFiles = {}, { dbContainerId = null, externalDb = false } = {}) {
    const files = { ...initialFiles }
    const fsStub = {
        existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
        createReadStream: (p) => streamFromString(files[p] || ''),
        readFileSync: (p) => files[p] != null ? String(files[p]) : '',
        writeFileSync: (p, body) => { files[p] = String(body) },
        appendFileSync: (p, body) => { files[p] = (files[p] || '') + String(body) },
        statSync: (p) => ({ size: String(files[p] || '').length }),
        openSync: () => 1,
        readSync: () => 0,
        closeSync: () => {},
        chmodSync: () => {},
        mkdirSync: () => {},
        rmSync: (p) => { delete files[p] }
    }
    const cs = proxyquire('../../src/services/ConfigService', {
        'fs': fsStub,
        './DatabaseService': {
            getDatabaseContainerId: async () => dbContainerId,
            getExternalDbConfig: async () => ({ host: '172.18.0.1', port: 3307, root_user: 'root', root_password: 'x' })
        },
        '../config/constants': { ...require('../../src/config/constants'), EXTERNAL_DB: externalDb }
    })
    return { cs, files }
}

const CONTAINER_ID = 'a'.repeat(64)
const coinSidecar = path.resolve(configDir, 'bitcoin-mainnet') + '.local'
const coinMain    = path.resolve(configDir, 'bitcoin-mainnet')

describe('secret-env ', function () {

    describe('the alias table', function () {

        it('covers the three xchain-node sidecar keys the audit sweep flagged', function () {
            expect(secretEnv.SECRET_ENV_ALIASES).to.include({
                NODE_PASSWORD:   'NODE_SECRET',
                DECODER_DB_PASS: 'DECODER_DB_SECRET',
                INDEXER_DB_PASS: 'INDEXER_DB_SECRET'
            })
        })

        it('every preferred name is one automatic redaction actually matches', function () {
            // The whole point of the rename. A "preferred" name the filter misses
            // would move the leak rather than close it.
            for (const preferred of Object.values(secretEnv.SECRET_ENV_ALIASES)) {
                expect(preferred).to.match(/_(SECRET|KEY|TOKEN)$/)
            }
        })

        it('agrees with the xchain-hub table on every key both own', function () {
            // xchain-node composes the hub container's env, so if the two tables
            // disagreed on a name the hub would boot without its DB password.
            const hubTable = path.resolve(__dirname, '..', '..', '..', 'xchain-hub', 'src', 'secret-env.js')
            if (!fs.existsSync(hubTable)) this.skip()      // sibling repo not checked out
            const hubAliases = require(hubTable).SECRET_ENV_ALIASES
            for (const [legacy, preferred] of Object.entries(hubAliases)) {
                expect(secretEnv.SECRET_ENV_ALIASES[legacy], 'xchain-node is missing ' + legacy)
                    .to.equal(preferred)
            }
        })

        it('agrees with the rename the platform audit gate tells operators to make', function () {
            // claude/bin/env-secret-name-audit.js prints "rename X to Y". Y has to
            // be a name this module reads, or following the gate breaks the stack.
            const auditTool = path.resolve(__dirname, '..', '..', '..', 'claude', 'bin', 'env-secret-name-audit.js')
            if (!fs.existsSync(auditTool)) this.skip()     // platform repo not checked out
            const { preferredName } = require(auditTool)
            for (const [legacy, preferred] of Object.entries(secretEnv.SECRET_ENV_ALIASES)) {
                expect(preferredName(legacy), 'the audit gate suggests a name xchain-node does not accept for ' + legacy)
                    .to.equal(preferred)
            }
        })
    })

    describe('foldSecretEnvAliases()', function () {

        it('folds a redaction-safe name onto the canonical name and drops the alias', function () {
            const config = secretEnv.foldSecretEnvAliases({ NODE_SECRET: 'p', NODE_USER: 'u' })
            expect(config).to.deep.equal({ NODE_PASSWORD: 'p', NODE_USER: 'u' })
        })

        it('never hands a credential to a container under two names at once', function () {
            const config = secretEnv.foldSecretEnvAliases({ INDEXER_DB_SECRET: 'p', INDEXER_DB_PASS: 'p' })
            expect(config).to.not.have.property('INDEXER_DB_SECRET')
            expect(config['INDEXER_DB_PASS']).to.equal('p')
        })

        it('refuses a half-finished rename rather than guessing which value is current', function () {
            expect(() => secretEnv.foldSecretEnvAliases({ HUB_DB_SECRET: 'new', HUB_DB_PASS: 'old' }))
                .to.throw(/HUB_DB_SECRET and HUB_DB_PASS are both set to different values/)
        })

        it('names no value in the conflict message', function () {
            // The message reaches stderr and whatever collects stderr.
            try {
                secretEnv.foldSecretEnvAliases({ HUB_DB_SECRET: 'newsecretvalue', HUB_DB_PASS: 'oldsecretvalue' })
                expect.fail('expected a conflict')
            } catch (e) {
                expect(e.message).to.not.include('newsecretvalue')
                expect(e.message).to.not.include('oldsecretvalue')
            }
        })

        it('treats an EMPTY alias as absent so it cannot blank out a real credential', function () {
            // docker --env-file writes an unset key as empty. Letting that win would
            // hand the stack an empty password.
            const config = secretEnv.foldSecretEnvAliases({ DECODER_DB_SECRET: '', DECODER_DB_PASS: 'real' })
            expect(config).to.deep.equal({ DECODER_DB_PASS: 'real' })
        })

        it('leaves keys it does not govern alone', function () {
            const config = secretEnv.foldSecretEnvAliases({ NODE_USER: 'u', DUST_AMOUNT: '546' })
            expect(config).to.deep.equal({ NODE_USER: 'u', DUST_AMOUNT: '546' })
        })
    })

    describe('deprecatedSecretEnvNames()', function () {

        it('reports a legacy name that has no redaction-safe twin', function () {
            expect(secretEnv.deprecatedSecretEnvNames({ NODE_PASSWORD: 'p' }))
                .to.deep.equal([{ legacy: 'NODE_PASSWORD', preferred: 'NODE_SECRET' }])
        })

        it('stays quiet once the rename has landed', function () {
            expect(secretEnv.deprecatedSecretEnvNames({ NODE_SECRET: 'p' })).to.deep.equal([])
            expect(secretEnv.deprecatedSecretEnvNames({ NODE_PASSWORD: '' })).to.deep.equal([])
        })
    })

    describe('readSecretHostEnv()', function () {

        it('prefers the redaction-safe name from the host env', function () {
            const env = { XCHAIN_PRICE_INDEXER_DB_SECRET: 'p' }
            expect(secretEnv.readSecretHostEnv('XCHAIN_PRICE_INDEXER_DB_PASS', env)).to.equal('p')
        })

        it('falls back to the legacy name so no existing .env breaks on upgrade', function () {
            const env = { XCHAIN_PRICE_INDEXER_DB_PASS: 'p' }
            expect(secretEnv.readSecretHostEnv('XCHAIN_PRICE_INDEXER_DB_PASS', env)).to.equal('p')
        })

        it('throws on a conflicting half-finished rename', function () {
            const env = { HUB_DB_SECRET: 'new', HUB_DB_PASS: 'old' }
            expect(() => secretEnv.readSecretHostEnv('HUB_DB_PASS', env)).to.throw(/both set to different values/)
        })

        it('is a plain env read for a name it does not govern', function () {
            expect(secretEnv.readSecretHostEnv('HUB_API_KEY', { HUB_API_KEY: 'k' })).to.equal('k')
        })
    })

    // ------------------------------------------------------------------
    // The thing that was actually blocked: renaming a key on a live venue.
    // ------------------------------------------------------------------
    describe('ConfigService accepts the renamed sidecar keys', function () {

        it('a sidecar written entirely under the new names produces a working config', async function () {
            const { cs } = makeMemoryConfigService({
                [coinSidecar]: [
                    'NODE_USER=u',
                    'NODE_SECRET=nodepass',
                    'DECODER_DB_SECRET=decoderpass',
                    'INDEXER_DB_SECRET=indexerpass'
                ].join('\n') + '\n'
            }, { dbContainerId: CONTAINER_ID })
            const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('nodepass')
            expect(config['DECODER_DB_PASS']).to.equal('decoderpass')
            expect(config['INDEXER_DB_PASS']).to.equal('indexerpass')
        })

        it('does not regenerate a credential that arrived under the new name', async function () {
            // The failure this guards: the generation step keys off the legacy name,
            // sees it absent, mints a fresh password and writes it over the operator's
            // renamed key. The stack then presents a password the DB has never seen.
            const { cs, files } = makeMemoryConfigService({
                [coinSidecar]: 'NODE_USER=u\nNODE_SECRET=nodepass\nDECODER_DB_SECRET=d\nINDEXER_DB_SECRET=i\n'
            }, { dbContainerId: CONTAINER_ID })
            const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('nodepass')
            expect(files[coinSidecar]).to.not.include('NODE_PASSWORD=')
            expect(files[coinSidecar]).to.not.include('DECODER_DB_PASS=')
        })

        it('the new name in the sidecar beats the legacy name in the main config file', async function () {
            // Sidecar-wins is the existing precedence rule; the rename must not invert it.
            const { cs } = makeMemoryConfigService({
                [coinMain]:    'DECODER_DB_PASS=stale\n',
                [coinSidecar]: 'NODE_USER=u\nNODE_SECRET=n\nDECODER_DB_SECRET=current\nINDEXER_DB_SECRET=i\n'
            }, { dbContainerId: CONTAINER_ID })
            const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
            expect(config['DECODER_DB_PASS']).to.equal('current')
        })

        it('a half-finished rename in a sidecar fails the config load instead of picking one', async function () {
            const { cs } = makeMemoryConfigService({
                [coinSidecar]: 'NODE_USER=u\nNODE_SECRET=new\nNODE_PASSWORD=old\n'
            })
            let threw = null
            try { await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet') } catch (e) { threw = e }
            expect(threw, 'a sidecar with both names took the load silently').to.be.an('error')
            expect(threw.message).to.match(/NODE_SECRET and NODE_PASSWORD/)
        })

        it('an install still on the legacy names keeps working', async function () {
            const { cs } = makeMemoryConfigService({
                [coinSidecar]: 'NODE_USER=u\nNODE_PASSWORD=legacypass\n'
            })
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('legacypass')
        })

        it('a credential in the MAIN config file is relocated to the sidecar under either name', async function () {
            // The legacy-install migration keys off NODE_PASSWORD; NODE_SECRET has to
            // arm it too, or a renamed credential stays in the shareable file forever.
            const { cs, files } = makeMemoryConfigService({
                [coinMain]: 'DUST_AMOUNT=546\nNODE_USER=u\nNODE_SECRET=inmainfile\n'
            })
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config['NODE_PASSWORD']).to.equal('inmainfile')
            expect(files[coinMain]).to.not.include('inmainfile')
            expect(files[coinSidecar]).to.include('NODE_PASSWORD=inmainfile')
        })
    })

    describe('sidecar helpers', function () {
        const sidecar = path.resolve(configDir, 'bitcoin-regtest') + '.local'

        it('readSidecarValue() finds a secret under its redaction-safe name', async function () {
            const { cs } = makeMemoryConfigService({ [sidecar]: 'HUB_DB_SECRET=rotated\n' })
            expect(await cs.readSidecarValue(sidecar, 'HUB_DB_PASS')).to.equal('rotated')
        })

        it('readSidecarValue() prefers the renamed key when a stale legacy line lingers', async function () {
            const { cs } = makeMemoryConfigService({ [sidecar]: 'HUB_DB_PASS=stale\nHUB_DB_SECRET=rotated\n' })
            expect(await cs.readSidecarValue(sidecar, 'HUB_DB_PASS')).to.equal('rotated')
        })

        it('readSidecarValue() is unchanged for keys with no alias', async function () {
            const { cs } = makeMemoryConfigService({ [sidecar]: 'XCHAIN_NODE_BLOCKS_DIR=/mnt/blocks\n' })
            expect(await cs.readSidecarValue(sidecar, 'XCHAIN_NODE_BLOCKS_DIR')).to.equal('/mnt/blocks')
        })

        it('a rotation writes back under the name the sidecar already uses', async function () {
            // Otherwise the next rotation re-introduces DECODER_DB_PASS beside the
            // renamed DECODER_DB_SECRET, and the very next config load hard-errors
            // on the conflict.
            const { cs, files } = makeMemoryConfigService({ [sidecar]: 'NODE_USER=u\nDECODER_DB_SECRET=old\n' })
            cs.upsertSidecarValues(sidecar, { DECODER_DB_PASS: 'rotated' })
            expect(files[sidecar]).to.include('DECODER_DB_SECRET=rotated')
            expect(files[sidecar]).to.not.include('DECODER_DB_PASS=')
            expect(files[sidecar]).to.include('NODE_USER=u')
        })

        it('a rotation on a sidecar still using legacy names does not force a rename', async function () {
            // Renaming has to stay an operator step (it lands with the credential
            // rotation and a consumer restart); a silent rewrite would break any
            // xchain-node old enough to read only the legacy name.
            const { cs, files } = makeMemoryConfigService({ [sidecar]: 'DECODER_DB_PASS=old\n' })
            cs.upsertSidecarValues(sidecar, { DECODER_DB_PASS: 'rotated' })
            expect(files[sidecar]).to.include('DECODER_DB_PASS=rotated')
            expect(files[sidecar]).to.not.include('DECODER_DB_SECRET=')
        })
    })
})
