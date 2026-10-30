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
// `exec` must exit non-zero with a reason when the in-container command fails,
// or when the selection matched no installed container. It used to print the
// raw Error object and exit 0, so `exec ... && next-step` carried on after a
// command that failed or never ran.

const { Command } = require('commander')
const { sinon, expect, makeStubs, loadOperations } = require('../module_operations.test/helpers/harness')
const { registerToolCommands } = require('../../../src/cli/commands')

class ExitCalled extends Error {
    constructor(code) { super('exit ' + code); this.code = code }
}

// Builds `exec` over the real module controls, with only the registry and
// docker stubbed, so the exit status is the CLI's own.
function buildProgram(configure) {
    const stubs = makeStubs()
    configure(stubs)
    const ops = loadOperations(stubs)
    const program = new Command()
    program.exitOverride()
    registerToolCommands(program, {
        filterCommandParameters: (_m, service, chain, network) => ({ [chain]: { [network]: [service] } }),
        execModules: ops.execModules
    })
    return { stubs, program }
}

async function runExec(args, configure = () => {}) {
    const { stubs, program } = buildProgram(configure)
    const errors = []
    sinon.stub(console, 'error').callsFake((...a) => { errors.push(a.join(' ')) })
    sinon.stub(console, 'log')
    sinon.stub(process, 'exit').callsFake((code) => { throw new ExitCalled(code) })
    let exitCode = null
    try {
        await program.parseAsync(['exec', ...args], { from: 'user' })
    } catch (e) {
        if (!(e instanceof ExitCalled)) throw e
        exitCode = e.code
    } finally {
        sinon.restore()
    }
    return { stubs, stderr: errors.join('\n'), exitCode }
}

function commandFailure(code, stderr) {
    const err = new Error('Command failed: docker exec -i container-id-123 ' + code)
    err.code = code
    err.stderr = stderr
    err.stdout = ''
    return err
}

describe('CLI `exec` exit code', function () {

    it('exits 1 with the exit code as the reason when the in-container command fails (`false`)', async function () {
        const { stderr, exitCode } = await runExec(['xchain-decoder', 'bitcoin', 'regtest', 'false'],
            stubs => stubs.execContainer.rejects(commandFailure(1, '')))
        expect(exitCode).to.equal(1)
        expect(stderr).to.match(/exec failed in xchain-decoder \(bitcoin regtest\): exit code 1/)
    })

    it('exits 1 and passes the command stderr through when it fails (`ls /no-such-dir`)', async function () {
        const { stderr, exitCode } = await runExec(['xchain-decoder', 'bitcoin', 'regtest', 'ls /no-such-dir'],
            stubs => stubs.execContainer.rejects(commandFailure(2, "ls: cannot access '/no-such-dir': No such file or directory")))
        expect(exitCode).to.equal(1)
        expect(stderr).to.match(/exit code 2/)
        expect(stderr).to.contain("ls: cannot access '/no-such-dir'")
    })

    it('exits 1 naming the selection when no installed container matched (typo service)', async function () {
        const { stubs, stderr, exitCode } = await runExec(['xchain-decodr', 'bitcoin', 'regtest', 'ls'],
            stubs => stubs.db.getModuleContainer.resolves(null))
        expect(exitCode).to.equal(1)
        expect(stubs.execContainer.called).to.be.false
        expect(stderr).to.match(/exec matched no installed service: xchain-decodr \(bitcoin regtest\)/)
    })

    it('exits 0 when the command ran and succeeded', async function () {
        const { stubs, exitCode } = await runExec(['xchain-decoder', 'bitcoin', 'regtest', 'ls /app'],
            stubs => stubs.execContainer.resolves('bin\nsrc'))
        expect(exitCode).to.equal(0)
        expect(stubs.execContainer.calledWith('container-id-123', ['ls', '/app'])).to.be.true
    })
})
