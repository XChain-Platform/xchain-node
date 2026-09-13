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

    // Stale reclamation, the half exclusive creation does not serialize on its
    // own: two invocations can read the same dead holder, and the second then
    // deletes the LIVE lock the first just made and acquires too (uuid:b5127aa1).
    describe('stale reclamation is serialized', () => {

        function findDeadPid() {
            let deadPid = 999999
            while (isPidAlive(deadPid)) deadPid--
            return deadPid
        }

        it('a contender acting on a stale observation cannot delete a successor lock', () => {
            const lockFile = getLockFilePath()
            const deadPid  = findDeadPid()
            fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, command: 'install' }) + '\n')

            // Pin the interleaving at the exact point it happens in the wild: the
            // liveness probe sits between our read of the stale holder and our
            // unlink, so a contender that wins the reclaim there leaves us holding
            // an observation of a file that no longer exists at that path.
            const realKill = process.kill
            let swapped = false
            process.kill = function (targetPid, signal) {
                if (!swapped && targetPid === deadPid && signal === 0) {
                    swapped = true
                    fs.unlinkSync(lockFile)
                    fs.writeFileSync(lockFile, JSON.stringify({
                        pid: process.pid, nonce: 'the-successor', command: 'update'
                    }) + '\n')
                }
                return realKill.call(process, targetPid, signal)
            }
            try {
                assert.throws(() => acquireCommandLock({ command: 'reset' }), /command lock/)
            } finally {
                process.kill = realKill
            }

            const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
            assert.strictEqual(holder.nonce, 'the-successor', "the successor's lock must survive")
            assert.ok(swapped, 'the interleaving must actually have been driven')
        })

        it('leaves no reclaim marker behind after a successful steal', () => {
            fs.writeFileSync(getLockFilePath(), JSON.stringify({ pid: findDeadPid(), command: 'install' }) + '\n')
            const release = acquireCommandLock({ command: 'update' })
            assert.deepStrictEqual(fs.readdirSync(tmpDir), ['command.lock'])
            release()
        })

        it('a reclaim marker held by a LIVE pid stops the steal instead of racing it', () => {
            const lockFile = getLockFilePath()
            fs.writeFileSync(lockFile, JSON.stringify({ pid: findDeadPid(), command: 'install' }) + '\n')
            const before = fs.statSync(lockFile).ino
            fs.writeFileSync(lockFile + '.reclaim', JSON.stringify({ pid: process.pid, nonce: 'other' }) + '\n')

            assert.throws(() => acquireCommandLock({ command: 'reset' }), /lost the race/)
            // The stale lock is untouched: only the marker's owner may remove it.
            assert.strictEqual(fs.statSync(lockFile).ino, before)
            fs.unlinkSync(lockFile + '.reclaim')
        })

        it('a reclaim marker abandoned by a dead pid does not deadlock acquisition', () => {
            const lockFile = getLockFilePath()
            fs.writeFileSync(lockFile, JSON.stringify({ pid: findDeadPid(), command: 'install' }) + '\n')
            fs.writeFileSync(lockFile + '.reclaim', JSON.stringify({ pid: findDeadPid(), nonce: 'crashed' }) + '\n')

            const release = acquireCommandLock({ command: 'update' })
            assert.strictEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid)
            assert.ok(!fs.existsSync(lockFile + '.reclaim'))
            release()
        })

        it('release keeps a successor lock that reuses our pid under a different nonce', () => {
            const lockFile = getLockFilePath()
            const release  = acquireCommandLock({ command: 'install' })
            const ours     = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
            assert.ok(ours.nonce, 'the payload must carry a nonce')
            // Same pid, different acquisition: a recycled pid looks exactly like this.
            fs.writeFileSync(lockFile, JSON.stringify({
                pid: process.pid, nonce: ours.nonce + '-other', command: 'update'
            }) + '\n')
            release()
            assert.strictEqual(
                JSON.parse(fs.readFileSync(lockFile, 'utf8')).command, 'update',
                'a successor under a recycled pid must survive our release'
            )
        })
    })

    it('release is idempotent', () => {
        const release = acquireCommandLock({ command: 'install' })
        release()
        assert.doesNotThrow(() => release())
    })

    // waitMs makes a non-mutating command block-and-poll for a live
    // holder up to the bound, then error, instead of failing immediately.
    it('waitMs blocks for roughly waitMs against a live holder, then throws', () => {
        const release = acquireCommandLock({ command: 'update' })
        const start = Date.now()
        assert.throws(
            () => acquireCommandLock({ command: 'ps', waitMs: 300, pollMs: 50 }),
            /Another xchain-node instance.*update/s
        )
        const elapsed = Date.now() - start
        assert.ok(elapsed >= 250, 'should have waited close to waitMs (got ' + elapsed + 'ms)')
        // The winner's lock must survive the loser's give-up.
        assert.ok(fs.existsSync(getLockFilePath()))
        release()
    })

    it('waitMs still steals a stale lock immediately (no needless wait)', () => {
        fs.writeFileSync(getLockFilePath(), JSON.stringify({ pid: 999999, command: 'update' }) + '\n')
        const start = Date.now()
        const release = acquireCommandLock({ command: 'ps', waitMs: 5000, pollMs: 100 })
        assert.ok(Date.now() - start < 1000, 'a stale lock is stolen at once, not waited on')
        release()
    })

    it('isPidAlive: our own pid is alive, pid 0/negative/junk are not', () => {
        assert.strictEqual(isPidAlive(process.pid), true)
        assert.strictEqual(isPidAlive(0), false)
        assert.strictEqual(isPidAlive(-1), false)
        assert.strictEqual(isPidAlive('x'), false)
        assert.strictEqual(isPidAlive(null), false)
    })
})
