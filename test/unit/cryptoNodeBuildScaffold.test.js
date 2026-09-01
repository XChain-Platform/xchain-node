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

// Runs against the REAL filesystem on purpose. The bug these tests cover was a
// mismatch between the build directory and the source tree, and a mocked fs is
// exactly what hid it: every unit test stubbed the conf file as present, so the
// one case that mattered (a build directory holding nothing but the downloaded
// tarball) was never expressed.

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const { expect } = require('chai')

const { stageBuildScaffold } = require('../../src/services/NodeService')

const REPO_ROOT  = path.join(__dirname, '..', '..')
const CREDS      = { NODE_USER: 'u_test', NODE_PASSWORD: 'p_test' }

describe('crypto-node build scaffold (XCHAIN_NODE_CRYPTO_NODES_DIR)', function () {
    let tmpRoot

    beforeEach(function () {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xcn-scaffold-'))
    })
    afterEach(function () {
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    })

    // The reported failure: with the env var pointed at a separate volume the
    // installer created <dir>/<coin>/ and downloaded the daemon tarball into it,
    // then ran `docker build .` there. The context held no Dockerfile, so docker
    // reported "transferring dockerfile: 2B" and failed after the whole download.
    it('stages a Dockerfile into a build dir that holds only the downloaded tarball', function () {
        const nodeDir = path.join(tmpRoot, 'litecoin')
        fs.mkdirSync(nodeDir, { recursive: true })
        fs.writeFileSync(path.join(nodeDir, 'litecoin-0.21.tar.gz'), 'tarball')
        expect(fs.readdirSync(nodeDir)).to.not.include('Dockerfile')

        const confName = stageBuildScaffold('litecoin', 'testnet', nodeDir, CREDS)

        expect(fs.existsSync(path.join(nodeDir, 'Dockerfile'))).to.be.true
        expect(fs.existsSync(path.join(nodeDir, confName))).to.be.true
    })

    it('creates the build dir when it does not exist yet', function () {
        const nodeDir = path.join(tmpRoot, 'dogecoin')
        stageBuildScaffold('dogecoin', 'mainnet', nodeDir, CREDS)
        expect(fs.existsSync(path.join(nodeDir, 'Dockerfile'))).to.be.true
    })

    it('injects the provisioned credentials, leaving no placeholder in the built conf', function () {
        const nodeDir = path.join(tmpRoot, 'bitcoin')
        const confName = stageBuildScaffold('bitcoin', 'testnet', nodeDir, CREDS)
        const conf = fs.readFileSync(path.join(nodeDir, confName), 'utf8')

        expect(conf).to.match(/^rpcuser=u_test$/m)
        expect(conf).to.match(/^rpcpassword=p_test$/m)
        expect(conf).to.not.include('__XCHAIN_NODE_RPC_')
    })

    // The template is tracked in git. Injecting in place wrote live RPC
    // credentials into a tracked file and left every host that ever built a node
    // with a dirty worktree holding a secret.
    it('never writes credentials back into the tracked template', function () {
        const nodeDir  = path.join(tmpRoot, 'bitcoin')
        const template = path.join(REPO_ROOT, 'crypto_nodes', 'bitcoin', 'bitcoin-testnet.conf')
        const before   = fs.readFileSync(template, 'utf8')

        const confName = stageBuildScaffold('bitcoin', 'testnet', nodeDir, CREDS)

        expect(fs.readFileSync(template, 'utf8')).to.equal(before)
        expect(before).to.include('__XCHAIN_NODE_RPC_PASSWORD__')
        // ...and the generated file is a different file, kept out of git.
        expect(confName).to.not.equal('bitcoin-testnet.conf')
        expect(confName).to.include('.generated.')
    })

    it('writes the credential-bearing conf 0600', function () {
        const nodeDir  = path.join(tmpRoot, 'bitcoin')
        const confName = stageBuildScaffold('bitcoin', 'regtest', nodeDir, CREDS)
        const mode = fs.statSync(path.join(nodeDir, confName)).mode & 0o777
        expect(mode).to.equal(0o600)
    })

    // Missing credentials must stop the build, not silently skip the injection:
    // the absent-conf case is precisely the custom-directory one, and skipping
    // ships an image carrying the placeholder tokens as its RPC credentials.
    it('fails closed when the provisioned credentials are missing', function () {
        const nodeDir = path.join(tmpRoot, 'bitcoin')
        expect(() => stageBuildScaffold('bitcoin', 'mainnet', nodeDir, {}))
            .to.throw(/Missing NODE_USER\/NODE_PASSWORD/)
        expect(() => stageBuildScaffold('bitcoin', 'mainnet', nodeDir, { NODE_USER: 'u' }))
            .to.throw(/Missing NODE_USER\/NODE_PASSWORD/)
    })

    it('names the missing path when the scaffold is not in the source tree', function () {
        const nodeDir = path.join(tmpRoot, 'bitcoin')
        expect(() => stageBuildScaffold('bitcoin', 'nosuchnetwork', nodeDir, CREDS))
            .to.throw(/Missing build scaffold .*bitcoin-nosuchnetwork\.conf/)
    })

    // The default layout points the build dir at the source tree itself. The copy
    // must not turn into a self-copy, and must not disturb the tracked files.
    it('is a no-op copy when the build dir IS the source tree', function () {
        const bundled = path.join(REPO_ROOT, 'crypto_nodes', 'bitcoin')
        const dockerfileBefore = fs.readFileSync(path.join(bundled, 'Dockerfile'), 'utf8')

        const confName = stageBuildScaffold('bitcoin', 'regtest', bundled, CREDS)
        try {
            expect(fs.readFileSync(path.join(bundled, 'Dockerfile'), 'utf8')).to.equal(dockerfileBefore)
            expect(fs.existsSync(path.join(bundled, confName))).to.be.true
        } finally {
            fs.rmSync(path.join(bundled, confName), { force: true })
        }
    })

    // Not about the build scaffold, but the same class of problem: a secret the
    // repo writes into the working tree that no ignore rule covered.
    describe('secrets the CLI writes are ignored by git', function () {
        const { execFileSync } = require('child_process')

        function isIgnored(relPath) {
            try {
                execFileSync('git', ['check-ignore', '-q', relPath], { cwd: REPO_ROOT })
                return true
            } catch (err) {
                // exit 1 means "not ignored"; anything else is a broken probe.
                if (err.status === 1) return false
                throw err
            }
        }

        // `validator init` writes an Ed25519 consensus key here and
        // `validator stake` writes a spendable Bitcoin key beside it. This is a
        // public repo that operators clone, so an unignored key is one
        // `git add -A` away from being published.
        it('ignores the validator identity directory', function () {
            expect(isIgnored('config/validator/signing.key'), 'signing.key').to.be.true
            expect(isIgnored('config/validator/stake.wif'), 'stake.wif').to.be.true
        })

        it('ignores the hub credential sidecar', function () {
            expect(isIgnored('config/hub.local')).to.be.true
        })

        // The build writes RPC credentials into this file; the template beside
        // it stays tracked and must keep its placeholders.
        it('ignores the generated crypto-node conf but not the template', function () {
            expect(isIgnored('crypto_nodes/bitcoin/bitcoin-testnet.generated.conf')).to.be.true
            expect(isIgnored('crypto_nodes/bitcoin/bitcoin-testnet.conf')).to.be.false
        })
    })

    it('covers every coin and network the installer supports', function () {
        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                const nodeDir = path.join(tmpRoot, `${coin}-${network}`)
                const confName = stageBuildScaffold(coin, network, nodeDir, CREDS)
                expect(fs.existsSync(path.join(nodeDir, 'Dockerfile')), `${coin} ${network} Dockerfile`).to.be.true
                expect(fs.readFileSync(path.join(nodeDir, confName), 'utf8')).to.match(/^rpcpassword=p_test$/m)
            }
        }
    })
})
