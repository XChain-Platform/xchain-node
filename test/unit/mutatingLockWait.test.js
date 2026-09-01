/*********************************************************************
 * Unit tests for the mutating-command lock wait
 * (XCHAIN_NODE_MUTATING_LOCK_WAIT_MS). The default must stay "refuse a held
 * lock at once", so both halves are asserted. These drive the real CLI in a
 * child process: the behaviour lives in the preAction hook, not an export.
 ********************************************************************/

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { spawnSync } = require('child_process')

const CLI = path.join(__dirname, '..', '..', 'src', 'index.js')

describe('mutating command lock wait', () => {
    let tmpDir, holder

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-mutwait-'))
        // A live pid, so the lock reads as held rather than stale-and-reapable.
        holder = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'])
        fs.writeFileSync(
            path.join(tmpDir, 'command.lock'),
            JSON.stringify({ pid: holder.pid, command: 'update', startedAt: new Date().toISOString() })
        )
    })

    afterEach(() => {
        if (holder) holder.kill()
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    function runAutoheal(extraEnv) {
        const started = Date.now()
        const res = spawnSync(process.execPath, [CLI, 'autoheal'], {
            env: {
                ...process.env,
                XCHAIN_NODE_LOCK_DIR: tmpDir,
                // The third case proceeds past the lock into a MUTATING action,
                // so pin Docker out of reach: no machine may act on real
                // containers from a unit test.
                DOCKER_HOST: 'unix:///nonexistent/xchain-node-test-docker.sock',
                ...extraEnv
            },
            encoding: 'utf8',
            timeout: 60000
        })
        return { elapsed: Date.now() - started, output: `${res.stdout || ''}${res.stderr || ''}` }
    }

    it('refuses a held lock immediately when the env var is unset (interactive default)', function () {
        this.timeout(40000)
        const { elapsed, output } = runAutoheal({ XCHAIN_NODE_MUTATING_LOCK_WAIT_MS: '' })
        assert.match(output, /holds the command lock/)
        // Generous bound: the point is that it does not sit through a wait, not
        // that process startup hits any particular millisecond.
        assert.ok(elapsed < 10000, `expected an immediate refusal, took ${elapsed}ms`)
    })

    it('waits for the holder when XCHAIN_NODE_MUTATING_LOCK_WAIT_MS is set', function () {
        this.timeout(40000)
        const { elapsed, output } = runAutoheal({ XCHAIN_NODE_MUTATING_LOCK_WAIT_MS: '3000' })
        assert.match(output, /holds the command lock/)
        // Lower bound only. A loaded runner can be slower but never faster, so
        // this cannot flake the way an upper bound would.
        assert.ok(elapsed >= 2500, `expected to block for the wait, took only ${elapsed}ms`)
    })

    it('takes the lock once the holder releases mid-wait', function () {
        this.timeout(40000)
        // The release MUST come from a separate process: spawnSync below blocks
        // this one's event loop, so an in-process timer would not fire until the
        // child had already given up.
        const lockPath = path.join(tmpDir, 'command.lock')
        require('child_process').spawn(
            process.execPath,
            ['-e', `setTimeout(()=>require('fs').rmSync(${JSON.stringify(lockPath)},{force:true}),2000)`],
            { detached: true, stdio: 'ignore' }
        ).unref()
        const { output } = runAutoheal({ XCHAIN_NODE_MUTATING_LOCK_WAIT_MS: '30000' })
        // It proceeds past the lock and on into preCheck (which fails here with
        // no Docker). Absence of the lock error is the assertion: it acquired
        // rather than timing out.
        assert.doesNotMatch(output, /holds the command lock/)
    })
})
