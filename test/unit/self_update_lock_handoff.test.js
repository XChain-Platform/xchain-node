'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const { acquireCommandLock, getLockFilePath } = require('../../src/utils/command_lock')
const { selfUpdateAndReexec } = require('../../src/services/self_update_service')

function contenderProgram(lockModule) {
    return `
        const { acquireCommandLock } = require(${JSON.stringify(lockModule)})
        try {
            const release = acquireCommandLock({ command: 'reset' })
            release()
            process.exit(22)
        } catch (err) {
            process.exit(err && err.code === 'ELOCKHELD' ? 23 : 24)
        }
    `
}

function reexecProgram(lockModule, contender) {
    return `
        const { spawnSync } = require('child_process')
        const { acquireCommandLock } = require(${JSON.stringify(lockModule)})
        const release = acquireCommandLock({ command: 'update', waitMs: 5000, pollMs: 10 })
        const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(contender)}], {
            env: process.env,
            stdio: 'ignore'
        })
        release()
        process.exit(result.status === 23 ? 0 : 25)
    `
}

function handoffDeps(parentRelease, childProgram, recordExit) {
    return {
        env: { ...process.env },
        logger: { log() {}, warn() {}, error() {} },
        currentVersion: () => '1.0.0',
        describeCarrier: async () => ({ isRepo: true, commit: 'c'.repeat(40), dirty: [] }),
        execFile: async () => ({ stdout: '' }),
        verifyGitTagSignature: () => ({ fingerprint: 'F'.repeat(40) }),
        signatureCheckDisabled: () => false,
        spawn: (bin, argv, opts) => spawn(process.execPath, ['-e', childProgram], opts),
        exit: recordExit,
        commandLock: parentRelease
    }
}

describe('self-update command lock handoff', function () {
    this.timeout(10000)

    let lockDir

    beforeEach(function () {
        lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-lock-handoff-'))
        process.env.XCHAIN_NODE_LOCK_DIR = lockDir
    })

    afterEach(function () {
        delete process.env.XCHAIN_NODE_LOCK_DIR
        fs.rmSync(lockDir, { recursive: true, force: true })
    })

    it('keeps a competing mutator out while ownership moves to the re-exec child', async function () {
        const lockModule = require.resolve('../../src/utils/command_lock')
        const contender = contenderProgram(lockModule)
        const childProgram = reexecProgram(lockModule, contender)

        const parentRelease = acquireCommandLock({ command: 'update (self-update)' })
        let exitCode = null
        try {
            await selfUpdateAndReexec({
                tag: 'v9.9.9',
                childArgs: ['update'],
                deps: handoffDeps(parentRelease, childProgram, code => { exitCode = code })
            })
        } finally {
            parentRelease()
        }

        assert.strictEqual(exitCode, 0, 'the child must retain the lock against the contender')
        assert.strictEqual(fs.existsSync(getLockFilePath()), false, 'the child release removes the adopted lock')
    })
})
