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
    const steps = doc.jobs.e2e.steps
    const find = (prefix) => {
        const step = steps.find(s => typeof s.name === 'string' && s.name.startsWith(prefix))
        if (!step) throw new Error('workflow step not found: ' + prefix)
        return step
    }
    return { ports: find('Publish distinct host ports'), boot: find('Boot the regtest stack') }
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

describe('nightly-e2e.yml two-stack legs (litecoin and dogecoin gas in over the bitcoin rail)', function () {
    let steps
    before(function () { steps = loadSteps() })

    it('gates the ports step off the bitcoin leg, whose single-stack shape stays as it was', function () {
        expect(steps.ports.if).to.equal("env.COIN != 'bitcoin'")
    })

    for (const coin of ['litecoin', 'dogecoin']) {
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

    describe('bitcoin leg', function () {
        it('boots exactly one stack, unchanged from the single-stack shape', function () {
            const { calls } = runStep(steps.boot, {
                COIN: 'bitcoin', STACK_REF: 'develop',
                XCHAIN_NODE_DATA_DIR: path.join(os.tmpdir(), 'nightly-e2e-data-' + process.pid),
            })
            expect(calls).to.deep.equal(['src/index.js install develop all bitcoin regtest'])
        })
    })
})
