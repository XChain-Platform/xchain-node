'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const { acquireCommandLock, getLockFilePath } = require('../../src/utils/command_lock')
const { selfUpdateAndReexec } = require('../../src/services/self_update_service')

function reexecProgram(lockModule) {
    return `
        const { acquireCommandLock } = require(${JSON.stringify(lockModule)})
        try {
            const release = acquireCommandLock({ command: 'update' })
            release()
            process.exit(22)
        } catch (err) {
            process.exit(err && err.code === 'ELOCKHELD' ? 23 : 24)
        }
    `
}

function handoffDeps(parentRelease, childProgram, winGap, recordExit) {
    return {
        env: { ...process.env },
        logger: { log() {}, warn() {}, error() {} },
        currentVersion: () => '1.0.0',
        describeCarrier: async () => ({ isRepo: true, commit: 'c'.repeat(40), dirty: [] }),
        execFile: async () => ({ stdout: '' }),
        verifyGitTagSignature: () => ({ fingerprint: 'F'.repeat(40) }),
        signatureCheckDisabled: () => false,
        spawn: (bin, argv, opts) => {
            winGap()
            return spawn(process.execPath, ['-e', childProgram], opts)
        },
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

    it('refuses the re-exec update when a mutator wins the unlocked gap', async function () {
        const lockModule = require.resolve('../../src/utils/command_lock')
        const childProgram = reexecProgram(lockModule)

        const parentRelease = acquireCommandLock({ command: 'update (self-update)' })
        let contenderRelease = null
        let exitCode = null
        try {
            await selfUpdateAndReexec({
                tag: 'v9.9.9',
                childArgs: ['update'],
                deps: handoffDeps(
                    parentRelease,
                    childProgram,
                    () => { contenderRelease = acquireCommandLock({ command: 'reset' }) },
                    code => { exitCode = code }
                )
            })
            assert.strictEqual(exitCode, 23, 'the re-exec child must refuse while reset owns the lock')
            assert.strictEqual(JSON.parse(fs.readFileSync(getLockFilePath(), 'utf8')).command, 'reset')
            parentRelease()
            assert.strictEqual(fs.existsSync(getLockFilePath()), true, 'the old release must preserve the contender lock')
            contenderRelease()
            contenderRelease = null
            assert.strictEqual(fs.existsSync(getLockFilePath()), false, 'the contender release removes its lock')
        } finally {
            parentRelease()
            if (contenderRelease) contenderRelease()
        }
    })
})
