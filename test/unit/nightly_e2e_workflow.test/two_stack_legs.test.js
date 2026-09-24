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
//
// The `E2E (regtest)` matrix legs for litecoin and dogecoin boot a bitcoin stack
// beside the coin under test, because the bridge lock from BTC is the only gas
// path onto a non-BTC chain (xchain-e2e-test 8df86bb). This drives the two
// workflow steps that make that work, as bash with a recording `node` stub, so
// what is asserted is what the runner would do: which stacks get installed, in
// which order, and what the per-coin config files say. The port blocks are
// pinned to the values xchain-e2e-test/test/helpers/chainRail.js DEFAULT_PORTS
// expects (BTC 3020-3025, DOGE 3120-3125, LTC 3220-3225): a leg that published
// any other block would boot green and then fail to reach its own gas rail.

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const yaml = require('js-yaml')

const WORKFLOW = path.join(__dirname, '../../../.github/workflows/nightly-e2e.yml')

const CHAIN_RAIL_DEFAULT_PORTS = {
    bitcoin:  { NODE_EXPOSED_PORT: 3020, UTXO_TRACKER_PORT: 3021, DECODER_PORT: 3022, ENCODER_PORT: 3023, INDEXER_PORT: 3024, REGTEST_MINER_PORT: 3025 },
    dogecoin: { NODE_EXPOSED_PORT: 3120, UTXO_TRACKER_PORT: 3121, DECODER_PORT: 3122, ENCODER_PORT: 3123, INDEXER_PORT: 3124, REGTEST_MINER_PORT: 3125 },
    litecoin: { NODE_EXPOSED_PORT: 3220, UTXO_TRACKER_PORT: 3221, DECODER_PORT: 3222, ENCODER_PORT: 3223, INDEXER_PORT: 3224, REGTEST_MINER_PORT: 3225 },
}

function loadSteps() {
    const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
    // The stack steps live on the shard job since the action suite was sharded;
    // `e2e` is now the per-coin aggregate, which boots nothing.
    const steps = doc.jobs['e2e-shard'].steps
    const find = (prefix) => {
        const step = steps.find(s => typeof s.name === 'string' && s.name.startsWith(prefix))
        if (!step) throw new Error('workflow step not found: ' + prefix)
        return step
    }
    return {
        ports: find('Publish distinct host ports'), boot: find('Boot the regtest stack'), db: find('Start headless MariaDB'),
        validator: find('Initialize the validator identity'),
        // Step order matters for the validator step: it must precede the install.
        order: steps.map(s => s.name || ''),
    }
}

// Parses KEY=VALUE lines the way ConfigService.getDefaultConfig reads a
// config/<coin>-<network> file: first `=` splits, everything after is the value.
function parseConfigFile(file) {
    const out = {}
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) out[line.substring(0, eq)] = line.substring(eq + 1)
    }
    return out
}

// Runs one step's `run` script under bash in a scratch checkout with a `node`
// stub that appends its argv to a log, so an install is observed rather than
// performed. Returns the scratch dir, the stub's call log and the step output.
//
// The scratch checkout has NO config/ directory, like a real one: every file
// under config/ is gitignored, so actions/checkout never materializes it, and
// the first dispatch of this step died on exactly that (run 35108669606,
// "config/litecoin-regtest: No such file or directory").
function runStep(step, env) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-e2e-')), 'checkout')
    fs.mkdirSync(dir, { recursive: true })
    const bin = path.join(dir, 'stub-bin')
    fs.mkdirSync(bin)
    const log = path.join(dir, 'node-calls.log')
    fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "' + log + '"\n', { mode: 0o755 })
    const stdout = execFileSync('bash', ['-e', '-c', step.run], {
        cwd: dir,
        env: Object.assign({ PATH: bin + ':' + process.env.PATH, HOME: dir }, env),
        encoding: 'utf8',
    })
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
    return { dir, calls, stdout }
}

let steps

function registerSharedWorkflowChecks() {
    it('gates the ports step off the bitcoin leg, whose single-stack shape stays as it was', function () {
        expect(steps.ports.if).to.equal("env.COIN != 'bitcoin'")
    })

    it('raises the runner DB connection cap above what two stacks of ten-connection pools need', function () {
        // mariadb:11 defaults to 151, which the first two-stack leg exhausted while
        // opening the BTC rail's indexer pool (run 35109600216).
        const m = /mariadb:11 --max-connections=(\d+)/.exec(steps.db.run)
        expect(m, 'docker run mariadb:11 --max-connections=N').to.not.equal(null)
        expect(parseInt(m[1], 10)).to.be.at.least(400)
    })
}

function registerCoinLegChecks(coin) {
    describe(coin + ' leg', function () {
        const env = { COIN: coin, STACK_REF: 'release/vX.Y.Z', XCHAIN_NODE_EXTERNAL_DB_HOST: '172.17.0.1' }

        it('writes the coin and bitcoin config files with the chainRail port blocks', function () {
            const { dir } = runStep(steps.ports, env)
            const own = parseConfigFile(path.join(dir, 'config', coin + '-regtest'))
            const btc = parseConfigFile(path.join(dir, 'config', 'bitcoin-regtest'))
            for (const [key, port] of Object.entries(CHAIN_RAIL_DEFAULT_PORTS[coin])) expect(own[key], coin + ' ' + key).to.equal(String(port))
            for (const [key, port] of Object.entries(CHAIN_RAIL_DEFAULT_PORTS.bitcoin)) expect(btc[key], 'bitcoin ' + key).to.equal(String(port))
            // Same host block twice would collide at the second install's port check.
            expect(new Set([...Object.values(own), ...Object.values(btc)].filter(v => /^\d+$/.test(v))).size).to.equal(12)
        })

        it('routes the e2e container to the bitcoin rail through the docker bridge gateway', function () {
            const { dir } = runStep(steps.ports, env)
            const own = parseConfigFile(path.join(dir, 'config', coin + '-regtest'))
            const btc = parseConfigFile(path.join(dir, 'config', 'bitcoin-regtest'))
            expect(own.BTC_SERVICE_HOST).to.equal('172.17.0.1')
            // The bitcoin stack's own containers need no such route.
            expect(btc).to.not.have.property('BTC_SERVICE_HOST')
        })

        it('routes the coin indexer to the bitcoin indexer for the bridge escrow proof', function () {
            // The destination indexer fetches the escrow proof from the origin
            // chain's indexer at BTC_INDEXER_API_URL before it credits a bridged
            // transfer, and holds the block at the proof barrier when nothing is
            // wired (run 35140173657: 900 s at bridge_proof_barrier, 143 blocks
            // behind). The bitcoin indexer joins the coin's docker network, so
            // its container name on the indexer's own port is the route.
            const { dir } = runStep(steps.ports, env)
            const own = parseConfigFile(path.join(dir, 'config', coin + '-regtest'))
            const btc = parseConfigFile(path.join(dir, 'config', 'bitcoin-regtest'))
            expect(own.BTC_INDEXER_API_URL).to.equal('http://xchain-node-bitcoin-regtest-xchain-indexer:3004')
            expect(btc).to.not.have.property('BTC_INDEXER_API_URL')
        })

        it('never writes a credential into either file (the install generates those into the .local sidecars)', function () {
            const { dir } = runStep(steps.ports, env)
            for (const file of [coin + '-regtest', 'bitcoin-regtest']) {
                const keys = Object.keys(parseConfigFile(path.join(dir, 'config', file)))
                expect(keys.filter(k => /USER|PASS|SECRET|KEY/.test(k)), file).to.deep.equal([])
            }
        })

        it('installs the coin under test first, then the bitcoin gas rail, both at the same ref', function () {
            const { calls, dir } = runStep(steps.boot, Object.assign({ XCHAIN_NODE_DATA_DIR: path.join(os.tmpdir(), 'nightly-e2e-data-' + process.pid) }, env))
            expect(calls).to.deep.equal([
                'src/index.js install release/vX.Y.Z all ' + coin + ' regtest',
                'src/index.js install release/vX.Y.Z all bitcoin regtest',
            ])
            expect(dir).to.be.a('string')
        })
    })
}

function registerValidatorModeChecks() {
    // The bridged credit needs a hub that FINALIZES transfers, which a standalone
    // hub never does: startCrossChain returns before constructing
    // CrossChainBridgeEngine without a peerManager, and even with an identity the
    // engine signs against the cross_chain capability set, empty on a fresh
    // regtest until XDEX_SEED_LOCAL_VALIDATOR=1 seeds the hub's own key into it
    // (xchain-hub src/cross_chain/bridge/plumbing.js resolveCapabilityValidators).
    // Runs 35115449692 and 35115452598 got the BTC lock valid and debited with no
    // credit on the destination for exactly this reason.
    describe('validator mode on the two-stack legs', function () {
        function runValidatorStep(coin) {
            const githubEnv = path.join(os.tmpdir(), 'nightly-e2e-github-env-' + process.pid + '-' + coin)
            fs.writeFileSync(githubEnv, '')
            const out = runStep(steps.validator, { COIN: coin, GITHUB_ENV: githubEnv })
            out.exported = parseConfigFile(githubEnv)
            return out
        }

        it('runs the validator init for every non-bitcoin leg, and for bitcoin only on the opt-in input', function () {
            expect(steps.validator.if).to.equal("github.event.inputs.validator == 'true' || env.COIN != 'bitcoin'")
        })

        it('initializes the identity BEFORE the ports and boot steps, which render the hub env from it', function () {
            const at = (prefix) => steps.order.findIndex(n => n.startsWith(prefix))
            expect(at('Initialize the validator identity')).to.be.below(at('Publish distinct host ports'))
            expect(at('Publish distinct host ports')).to.be.below(at('Boot the regtest stack'))
        })

        for (const coin of ['litecoin', 'dogecoin']) {
            it(coin + ': inits a cross_chain-capable identity and exports the seed so the hub finalizes the gas lock', function () {
                const { calls, exported } = runValidatorStep(coin)
                expect(calls[0]).to.match(/^src\/index\.js validator init --network regtest --oracle-epoch-start \d+ --capabilities [a-z_,]+$/)
                expect(calls[0].split('--capabilities ')[1].split(',')).to.include('cross_chain')
                expect(calls[calls.length - 1]).to.equal('src/index.js validator status')
                // The indexer URLs ride the same export: the hub's cross-chain
                // engines resolve them once at start, before either stack exists
                // on this runner, so the configs table cannot supply them in time.
                const code = { litecoin: 'LTC', dogecoin: 'DOGE' }[coin]
                // The confirmation depths ride it too: at the hub's default six
                // BTC blocks nothing on the runner mines behind the lock, so the
                // engine held the leg "below depth 6" for the whole credit wait
                // (run 35124072478). The hub clamps these up off regtest.
                expect(exported).to.deep.equal({
                    HUB_NETWORK: 'regtest', ORACLE_MIN_SUBMISSIONS: '1', XDEX_SEED_LOCAL_VALIDATOR: '1',
                    BTC_INDEXER_API_URL: 'http://xchain-node-bitcoin-regtest-xchain-indexer:3004',
                    BTC_INDEXER_URL: 'http://xchain-node-bitcoin-regtest-xchain-indexer:3004',
                    [code + '_INDEXER_URL']: 'http://xchain-node-' + coin + '-regtest-xchain-indexer:3004',
                    XCHAIN_CONFIRMATIONS_BTC: '1', XCHAIN_CONFIRMATIONS_LTC: '1', XCHAIN_CONFIRMATIONS_DOGE: '1',
                })
            })
        }

        it('bitcoin (opt-in): keeps the identity but never seeds, so the input changes nothing beyond the price regime it documents', function () {
            const { calls, exported } = runValidatorStep('bitcoin')
            expect(calls[0]).to.match(/^src\/index\.js validator init --network regtest --oracle-epoch-start \d+ --capabilities [a-z_,]+$/)
            expect(calls[calls.length - 1]).to.equal('src/index.js validator status')
            expect(exported).to.deep.equal({ HUB_NETWORK: 'regtest', ORACLE_MIN_SUBMISSIONS: '1' })
        })
    })
}

function registerBitcoinLegChecks() {
    describe('bitcoin leg', function () {
        it('boots exactly one stack, unchanged from the single-stack shape', function () {
            const { calls } = runStep(steps.boot, {
                COIN: 'bitcoin', STACK_REF: 'develop',
                XCHAIN_NODE_DATA_DIR: path.join(os.tmpdir(), 'nightly-e2e-data-' + process.pid),
            })
            expect(calls).to.deep.equal(['src/index.js install develop all bitcoin regtest'])
        })
    })
}

describe('nightly-e2e.yml two-stack legs (litecoin and dogecoin gas in over the bitcoin rail)', function () {
    before(function () { steps = loadSteps() })

    registerSharedWorkflowChecks()
    for (const coin of ['litecoin', 'dogecoin']) registerCoinLegChecks(coin)
    registerValidatorModeChecks()
    registerBitcoinLegChecks()
})
