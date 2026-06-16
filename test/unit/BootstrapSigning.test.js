'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bootstrap archive signing (supply-chain integrity).
//
// The outer bootstrap archive bundles its own checksum, so that checksum only
// detects transport corruption — a tampering publisher/CDN recomputes it.
// These tests cover the detached Ed25519 signature layer: sign at create,
// verify against the pinned public key at restore, and the fail-open/closed
// policy around missing keys/signatures.
//
// Unlike BootstrapService.test.js (fully stubbed fs), this suite uses REAL
// fs + crypto against a temp directory — the signing math is the subject
// under test, not something to stub.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const crypto     = require('crypto')

function loadServiceWithRealFs() {
    return proxyquire('../../src/services/BootstrapService', {
        '../state': { db: {} },
        './ConfigService':   { getDefaultConfig: sinon.stub(), getModuleDatabaseName: sinon.stub() },
        './DockerService':   { stopContainer: sinon.stub(), startContainer: sinon.stub() },
        './DatabaseService': { getDatabaseContainerId: sinon.stub(), ensureDatabasePool: sinon.stub() }
    })
}

describe('Bootstrap signing', function () {
    let tmpDir, archivePath, privPath, pubPath, svc
    const savedEnv = {}

    function stashEnv(name) {
        savedEnv[name] = process.env[name]
        delete process.env[name]
    }

    beforeEach(function () {
        tmpDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bootstrap-sign-'))
        archivePath = path.join(tmpDir, 'mainnet-xchain-utxo-tracker-test.tar.gz')
        privPath    = path.join(tmpDir, 'signing_key.pem')
        pubPath     = path.join(tmpDir, 'signing_pubkey.pem')

        fs.writeFileSync(archivePath, 'pretend-this-is-a-bootstrap-archive')

        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
        fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
        fs.writeFileSync(pubPath,  publicKey.export({ type: 'spki', format: 'pem' }))

        stashEnv('XCHAIN_NODE_BOOTSTRAP_PUBKEY')
        stashEnv('XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY')
        stashEnv('XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP')

        svc = loadServiceWithRealFs()
    })

    afterEach(function () {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
        fs.rmSync(tmpDir, { recursive: true, force: true })
        sinon.restore()
    })

    it('sign → verify round-trip passes', async function () {
        const sigPath = await svc.signBootstrapArchive(archivePath, privPath)
        expect(sigPath).to.equal(archivePath + '.sig')
        const sigText = fs.readFileSync(sigPath, 'utf8')
        expect(sigText).to.match(/^v1 ed25519 [A-Za-z0-9+/=]+\n$/)

        const publicKey = crypto.createPublicKey(fs.readFileSync(pubPath, 'utf8'))
        // Resolves without throwing.
        await svc.verifyBootstrapSignature(archivePath, sigPath, publicKey)
    })

    it('rejects a tampered archive', async function () {
        const sigPath = await svc.signBootstrapArchive(archivePath, privPath)
        fs.appendFileSync(archivePath, 'evil-bytes')

        const publicKey = crypto.createPublicKey(fs.readFileSync(pubPath, 'utf8'))
        let threw = false
        try {
            await svc.verifyBootstrapSignature(archivePath, sigPath, publicKey)
        } catch (err) {
            threw = true
            expect(err.message).to.match(/signature verification FAILED/)
        }
        expect(threw, 'tampered archive must fail verification').to.be.true
    })

    it('rejects a signature from the wrong key', async function () {
        await svc.signBootstrapArchive(archivePath, privPath)
        const { publicKey: wrongPub } = crypto.generateKeyPairSync('ed25519')

        let threw = false
        try {
            await svc.verifyBootstrapSignature(archivePath, archivePath + '.sig', wrongPub)
        } catch (err) {
            threw = true
            expect(err.message).to.match(/signature verification FAILED/)
        }
        expect(threw).to.be.true
    })

    it('rejects a malformed signature file', async function () {
        fs.writeFileSync(archivePath + '.sig', 'not a real signature')
        const publicKey = crypto.createPublicKey(fs.readFileSync(pubPath, 'utf8'))

        let threw = false
        try {
            await svc.verifyBootstrapSignature(archivePath, archivePath + '.sig', publicKey)
        } catch (err) {
            threw = true
            expect(err.message).to.match(/malformed/)
        }
        expect(threw).to.be.true
    })

    describe('checkBootstrapSignature() policy', function () {

        it('verifies and passes when pinned key + valid signature are present', async function () {
            await svc.signBootstrapArchive(archivePath, privPath)
            process.env.XCHAIN_NODE_BOOTSTRAP_PUBKEY = pubPath
            await svc.checkBootstrapSignature(archivePath) // must not throw
        })

        it('throws when pinned key + signature are present but the signature is bad', async function () {
            await svc.signBootstrapArchive(archivePath, privPath)
            fs.appendFileSync(archivePath, 'evil-bytes')
            process.env.XCHAIN_NODE_BOOTSTRAP_PUBKEY = pubPath

            let threw = false
            try {
                await svc.checkBootstrapSignature(archivePath)
            } catch (err) {
                threw = true
                expect(err.message).to.match(/signature verification FAILED/)
            }
            expect(threw).to.be.true
        })

        it('fails closed BY DEFAULT when no public key is pinned', async function () {
            // Default policy is now require-signed. Point the pubkey override at a
            // nonexistent path so loadBootstrapPublicKey() returns null (the repo
            // now ships a real pinned key at the default path).
            process.env.XCHAIN_NODE_BOOTSTRAP_PUBKEY = path.join(tmpDir, 'does-not-exist.pem')

            let threw = false
            try {
                await svc.checkBootstrapSignature(archivePath)
            } catch (err) {
                threw = true
                expect(err.message).to.match(/Refusing unsigned bootstrap/)
            }
            expect(threw).to.be.true
        })

        it('warns but proceeds when enforcement is explicitly disabled (=0)', async function () {
            process.env.XCHAIN_NODE_BOOTSTRAP_PUBKEY = path.join(tmpDir, 'does-not-exist.pem')
            process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
            await svc.checkBootstrapSignature(archivePath) // must not throw
        })

        it('fails closed without a pinned key when XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP is set', async function () {
            process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '1'

            let threw = false
            try {
                await svc.checkBootstrapSignature(archivePath)
            } catch (err) {
                threw = true
                expect(err.message).to.match(/Refusing unsigned bootstrap/)
            }
            expect(threw).to.be.true
        })

        it('fails closed when the key is pinned but the signature file is missing and REQUIRE is set', async function () {
            process.env.XCHAIN_NODE_BOOTSTRAP_PUBKEY = pubPath
            process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '1'

            let threw = false
            try {
                await svc.checkBootstrapSignature(archivePath)
            } catch (err) {
                threw = true
                expect(err.message).to.match(/Refusing unsigned bootstrap/)
            }
            expect(threw).to.be.true
        })
    })

    describe('downloadBootstrap() — companion signature fetch', function () {

        function loadServiceWithAxios(axiosStub) {
            return proxyquire('../../src/services/BootstrapService', {
                'axios': axiosStub,
                '../state': { db: {} },
                './ConfigService':   { getDefaultConfig: sinon.stub(), getModuleDatabaseName: sinon.stub() },
                './DockerService':   { stopContainer: sinon.stub(), startContainer: sinon.stub() },
                './DatabaseService': { getDatabaseContainerId: sinon.stub(), ensureDatabasePool: sinon.stub() }
            })
        }

        function makeArchiveResponse() {
            const { PassThrough } = require('stream')
            const dataStream = new PassThrough()
            setImmediate(() => { dataStream.end('archive-bytes') })
            return { status: 200, headers: { 'content-length': '13' }, data: dataStream }
        }

        it('downloads and stores the .sig next to the archive', async function () {
            const axiosStub = sinon.stub().callsFake(async ({ url }) => {
                if (url.endsWith('.sig')) return { status: 200, data: 'v1 ed25519 c2ln\n' }
                return makeArchiveResponse()
            })
            const svc2 = loadServiceWithAxios(axiosStub)

            const fileName = await svc2.downloadBootstrap('bitcoin', 'mainnet', 'xchain-utxo-tracker', tmpDir)
            expect(fileName).to.equal('latest.tgz')
            expect(fs.readFileSync(path.join(tmpDir, 'latest.tgz.sig'), 'utf8')).to.equal('v1 ed25519 c2ln\n')
        })

        it('removes a stale local .sig when the server has none (404)', async function () {
            fs.writeFileSync(path.join(tmpDir, 'latest.tgz.sig'), 'stale signature from a previous archive')
            const axiosStub = sinon.stub().callsFake(async ({ url }) => {
                if (url.endsWith('.sig')) return { status: 404, data: null }
                return makeArchiveResponse()
            })
            const svc2 = loadServiceWithAxios(axiosStub)

            await svc2.downloadBootstrap('bitcoin', 'mainnet', 'xchain-utxo-tracker', tmpDir)
            expect(fs.existsSync(path.join(tmpDir, 'latest.tgz.sig'))).to.be.false
        })
    })
})
