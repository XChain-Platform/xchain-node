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
// A failed in-container command, or a selection that matched no installed
// container, used to print the raw Error object and still report success, so
// `exec ... && next` carried on after a command that failed or never ran.

const { sinon, expect, makeStubs, loadOperations } = require('./helpers/harness')

// Runs execModules over stubbed docker and registry, capturing console output
// as argument arrays so a raw Error object passed to console is visible.
async function runExec(servicesList, command, configure) {
    const stubs = makeStubs()
    configure(stubs)
    const ops = loadOperations(stubs)
    const lines = { log: [], error: [] }
    sinon.stub(console, 'log').callsFake((...a) => { lines.log.push(a) })
    sinon.stub(console, 'error').callsFake((...a) => { lines.error.push(a) })
    let result
    try {
        result = await ops.execModules(servicesList, command)
    } finally {
        sinon.restore()
    }
    const stderr = lines.error.map(a => a.join(' ')).join('\n')
    return { stubs, lines, stderr, result }
}

// The shape execContainer rejects with: execFile's error plus the child's output.
function commandFailure(code, stderr, stdout = '') {
    const err = new Error('Command failed: docker exec -i container-id-123 ls /no-such-dir')
    err.code = code
    err.stderr = stderr
    err.stdout = stdout
    return err
}

const DECODER = { bitcoin: { regtest: ['xchain-decoder'] } }

describe('execModules(): failure is reported, never swallowed', function () {

    it('returns false when the in-container command exits non-zero, with its exit code and stderr as the reason', async function () {
        const { lines, stderr, result } = await runExec(DECODER, 'ls /no-such-dir', stubs =>
            stubs.execContainer.rejects(commandFailure(2, "ls: cannot access '/no-such-dir': No such file or directory\n")))
        expect(result).to.equal(false)
        const printed = [...lines.log, ...lines.error]
        expect(printed.some(args => args.some(a => a instanceof Error)), 'no raw Error object is printed').to.be.false
        expect(stderr).to.match(/exec failed in xchain-decoder \(bitcoin regtest\): exit code 2/)
        expect(stderr).to.contain("ls: cannot access '/no-such-dir'")
    })

    it('returns false when the command fails before it runs (no exit code)', async function () {
        const spawnError = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
        const { stderr, result } = await runExec(DECODER, 'ls', stubs => stubs.execContainer.rejects(spawnError))
        expect(result).to.equal(false)
        expect(stderr).to.match(/exec failed in xchain-decoder \(bitcoin regtest\): spawn docker ENOENT/)
    })

    it('returns false and names the selection when no installed container matched, running nothing', async function () {
        const { stubs, stderr, result } = await runExec({ bitcoin: { regtest: ['xchain-decodr'] } }, 'ls', stubs =>
            stubs.db.getModuleContainer.resolves(null))
        expect(result).to.equal(false)
        expect(stubs.execContainer.called).to.be.false
        expect(stderr).to.match(/exec matched no installed service: xchain-decodr \(bitcoin regtest\)/)
    })

    it('returns false when one of several matched containers fails, after running every one', async function () {
        const { stubs, result } = await runExec({ bitcoin: { regtest: ['xchain-decoder', 'xchain-encoder'] } }, 'false', stubs => {
            stubs.execContainer.onFirstCall().rejects(commandFailure(1, ''))
            stubs.execContainer.onSecondCall().resolves('ok')
        })
        expect(result).to.equal(false)
        expect(stubs.execContainer.callCount, 'the second container still runs').to.equal(2)
    })

    it('returns true and prints the output when the command succeeds', async function () {
        const { lines, result } = await runExec(DECODER, 'ls /app', stubs => stubs.execContainer.resolves('bin\nsrc'))
        expect(result).to.equal(true)
        expect(lines.log.some(args => args[0] === 'bin\nsrc')).to.be.true
        expect(lines.error).to.have.lengthOf(0)
    })
})
