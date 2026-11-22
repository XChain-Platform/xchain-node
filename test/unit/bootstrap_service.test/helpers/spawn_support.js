'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon')
const { PassThrough, EventEmitter } = require('stream')

/** Build a fake EventEmitter that looks like a child_process spawn() result */
function makeSpawnProc() {
    const proc    = new EventEmitter()
    proc.stdout   = new PassThrough()
    proc.stderr   = new PassThrough()
    proc.stdin    = new PassThrough()
    return proc
}

/** Drain a PassThrough immediately so it doesn't block the event loop */
function drainPassThrough(pt) {
    pt.resume()
}

/**
 * The utxo-tracker create path spawns twice (the docker `tar cf -` that feeds
 * the inner gzip, then the outer `tar cf -` that the store-only gzip wraps), so
 * a single shared fake proc deadlocks the second call. Hand each spawn its own
 * proc, drive it to a clean EOF + exit 0, and record what was spawned.
 *
 * createWriteStream is swapped for a real PassThrough per call so the pipe
 * chain ends it naturally and 'finish' fires the way it does in production.
 */
function makeAutoSpawn(stubs, { exitCodes = {} } = {}) {
    const calls = []
    const execFile = stubs.execFile
    stubs.execFile = sinon.stub().callsFake(async (cmd, args) => {
        const result = await execFile(cmd, args)
        const stdout = String(result && result.stdout || '').trim()
        if (cmd === 'docker' && args[0] === 'inspect' && !stdout) {
            return { ...(result || {}), stdout: 'sha256:tracker-image\n' }
        }
        if (cmd === 'docker' && args.some(arg => String(arg).includes('LAST_BLOCK_HEIGHT'))
            && !/"haltMarker"/.test(stdout)) {
            const height = /^\d+$/.test(stdout) ? Number(stdout) : 0
            return { ...(result || {}), stdout: JSON.stringify({ height, haltMarker: null }) + '\n' }
        }
        return result
    })
    stubs.spawn = sinon.stub().callsFake((cmd, args) => {
        const proc = makeSpawnProc()
        const idx  = calls.length
        calls.push({ cmd, args, proc })
        const code = Object.prototype.hasOwnProperty.call(exitCodes, idx) ? exitCodes[idx] : 0
        setImmediate(() => {
            proc.stdout.end(Buffer.from('tar-bytes'))
            setImmediate(() => proc.emit('close', code))
        })
        return proc
    })
    stubs.fs.createWriteStream.callsFake(() => {
        const ws = new PassThrough()
        drainPassThrough(ws)
        return ws
    })
    return calls
}

/** The argv of the docker `run` that snapshots the tracker volume, or undefined */
function findSnapshotCall(execFileStub) {
    return execFileStub.getCalls()
        .map(c => c.args)
        .find(([cmd, args]) => cmd === 'docker' && Array.isArray(args) &&
            args.includes('sh') && String(args[args.length - 1]).includes('cp -al'))
}

module.exports = {
    makeSpawnProc,
    drainPassThrough,
    makeAutoSpawn,
    findSnapshotCall
}
