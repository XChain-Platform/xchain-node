/*********************************************************************
 * Unit tests for src/utils/commandLock.js: pidfile-style lock that
 * stops two concurrent xchain-node mutating commands from interleaving.
 ********************************************************************/

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const { acquireCommandLock, getLockFilePath, isPidAlive } = require('../../src/utils/commandLock')

describe('commandLock', () => {
    let tmpDir

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-lock-'))
        process.env.XCHAIN_NODE_LOCK_DIR = tmpDir
    })

    afterEach(() => {
        delete process.env.XCHAIN_NODE_LOCK_DIR
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('getLockFilePath honors XCHAIN_NODE_LOCK_DIR', () => {
        assert.strictEqual(getLockFilePath(), path.join(tmpDir, 'command.lock'))
    })

    it('getLockFilePath defaults to ~/.xchain-node/command.lock', () => {
        delete process.env.XCHAIN_NODE_LOCK_DIR
        assert.strictEqual(getLockFilePath(), path.join(os.homedir(), '.xchain-node', 'command.lock'))
    })

    it('acquires the lock and writes pid + command to the lock file', () => {
        const release = acquireCommandLock({ command: 'install' })
        const lockFile = getLockFilePath()
        const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
        assert.strictEqual(holder.pid, process.pid)
        assert.strictEqual(holder.command, 'install')
        assert.ok(holder.startedAt)
        release()
        assert.ok(!fs.existsSync(lockFile), 'release must remove the lock file')
    })

    it('creates the lock directory when missing', () => {
        const nested = path.join(tmpDir, 'a', 'b')
        process.env.XCHAIN_NODE_LOCK_DIR = nested
        const release = acquireCommandLock({ command: 'update' })
        assert.ok(fs.existsSync(path.join(nested, 'command.lock')))
        release()
    })

    it('refuses a second acquire while the first (live pid) holds the lock', () => {
        const release = acquireCommandLock({ command: 'install' })
        assert.throws(
            () => acquireCommandLock({ command: 'update' }),
            /Another xchain-node instance.*install.*pid \d+/s
        )
        // Losing the race must not delete the winner's lock file.
        assert.ok(fs.existsSync(getLockFilePath()))
        release()
    })

    it('steals a stale lock left by a dead pid', () => {
        // Find a pid that is certainly not alive.
        let deadPid = 999999
        while (isPidAlive(deadPid)) deadPid--
        fs.writeFileSync(getLockFilePath(), JSON.stringify({ pid: deadPid, command: 'install' }))
        const release = acquireCommandLock({ command: 'update' })
        const holder = JSON.parse(fs.readFileSync(getLockFilePath(), 'utf8'))
        assert.strictEqual(holder.pid, process.pid)
        release()
    })

    it('steals a lock file with unparseable contents', () => {
        fs.writeFileSync(getLockFilePath(), 'not json at all')
        const release = acquireCommandLock({ command: 'reset' })
        const holder = JSON.parse(fs.readFileSync(getLockFilePath(), 'utf8'))
        assert.strictEqual(holder.pid, process.pid)
        release()
    })

    it('release does not clobber a successor lock owned by another pid', () => {
        const release = acquireCommandLock({ command: 'install' })
        // Simulate a stale-lock takeover: another process replaced the file.
        fs.writeFileSync(getLockFilePath(), JSON.stringify({ pid: process.pid + 1, command: 'update' }))
        release()
        const holder = JSON.parse(fs.readFileSync(getLockFilePath(), 'utf8'))
        assert.strictEqual(holder.pid, process.pid + 1, 'successor lock must survive our release')
    })

    it('release is idempotent', () => {
        const release = acquireCommandLock({ command: 'install' })
        release()
        assert.doesNotThrow(() => release())
    })

    it('isPidAlive: our own pid is alive, pid 0/negative/junk are not', () => {
        assert.strictEqual(isPidAlive(process.pid), true)
        assert.strictEqual(isPidAlive(0), false)
        assert.strictEqual(isPidAlive(-1), false)
        assert.strictEqual(isPidAlive('x'), false)
        assert.strictEqual(isPidAlive(null), false)
    })
})
