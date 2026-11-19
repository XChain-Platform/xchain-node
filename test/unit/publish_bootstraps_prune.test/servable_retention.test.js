'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const publishScript = fs.readFileSync(path.join(repoRoot, 'scripts/publish-bootstraps.sh'), 'utf8')
const pruneMatch = /PRUNE_SCRIPT=\$\(cat <<'PRUNE_EOF'\n([\s\S]*?)\nPRUNE_EOF/.exec(publishScript)
assert.ok(pruneMatch, 'PRUNE_SCRIPT body must be extractable')
const pruneBody = pruneMatch[1]

function archive(dir, stamp, { signed = true } = {}) {
    const name = `xcp_mainnet_${stamp}.tar.gz`
    fs.writeFileSync(path.join(dir, name), '')
    if (signed) fs.writeFileSync(path.join(dir, `${name}.sig`), '')
    fs.writeFileSync(path.join(dir, `${name}.sha256`), '')
    return name
}

function runPrune(dir, keep) {
    const result = spawnSync('sh', ['-s', '--', dir, String(keep)], {
        input: pruneBody,
        encoding: 'utf8'
    })
    assert.strictEqual(result.status, 0, result.stderr)
    return result.stdout
}

function utcStamp(date) {
    const digits = (n) => String(n).padStart(2, '0')
    return `${date.getUTCFullYear()}${digits(date.getUTCMonth() + 1)}${digits(date.getUTCDate())}_` +
        `${digits(date.getUTCHours())}${digits(date.getUTCMinutes())}${digits(date.getUTCSeconds())}`
}

describe('publish bootstrap servable retention', function () {
    it('keeps the only current signed archive when future signed names fill the by-name slots', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-prune-current-'))
        const current = archive(dir, '20260101_000000')
        const futureOne = archive(dir, '20990101_000000')
        const futureTwo = archive(dir, '20990102_000000')

        const output = runPrune(dir, 2)

        for (const name of [current, futureOne, futureTwo]) {
            assert.strictEqual(fs.existsSync(path.join(dir, name)), true, name)
        }
        assert.match(output, /1 servable archive\(s\) retained/)
        assert.doesNotMatch(output, /PRUNE WARNING/)
    })

    it('warns when retained signed archives are all too far in the future to serve', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-prune-warning-'))
        archive(dir, '20990101_000000')
        archive(dir, '20990102_000000')

        const output = runPrune(dir, 2)

        assert.match(output, /PRUNE WARNING: no servable archive remains/)
    })

    it('matches the resolver treatment of near-future and invalid timestamps', function () {
        const nearDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-prune-near-'))
        const near = archive(nearDir, utcStamp(new Date(Date.now() + 60 * 60 * 1000)))
        assert.doesNotMatch(runPrune(nearDir, 1), /PRUNE WARNING/)
        assert.strictEqual(fs.existsSync(path.join(nearDir, near)), true)

        const invalidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-prune-invalid-'))
        const invalid = archive(invalidDir, '20991301_000000')
        assert.doesNotMatch(runPrune(invalidDir, 1), /PRUNE WARNING/)
        assert.strictEqual(fs.existsSync(path.join(invalidDir, invalid)), true)
    })

    it('pins the one-day future tolerance used by the resolver', function () {
        assert.match(pruneBody, /FUTURE_STAMP_TOLERANCE_S=86400/)
        const resolver = fs.readFileSync(
            path.join(repoRoot, '../xchain-websites/sync.xchain.io/bootstraps-app/latest.php'), 'utf8'
        )
        assert.match(resolver, /> \$now \+ 86400/)
    })
})
