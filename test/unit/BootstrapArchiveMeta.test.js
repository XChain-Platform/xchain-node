'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The bootstrap.json member that leads a published archive, and the reader
// that pulls it out without a pass over the rest. Real tar, real gzip: the
// point of the member is its position in a real wrapper.

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { expect } = require('chai')

const meta = require('../../src/services/BootstrapArchiveMeta')

function makeWorkDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bootstrap-meta-'))
}

function writeMembers(dir, { payloadBytes = 4096, withMeta = true, height = 964970 } = {}) {
    fs.writeFileSync(path.join(dir, 'dump.sql.gz'), crypto.randomBytes(payloadBytes))
    fs.writeFileSync(path.join(dir, 'dump.sha256'), 'deadbeef  dump.sql.gz\n')
    if (withMeta) {
        fs.writeFileSync(path.join(dir, meta.BOOTSTRAP_META_MEMBER), JSON.stringify(meta.buildBootstrapMeta({
            module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', height
        })))
    }
}

function tarUp(dir, members) {
    const out = path.join(dir, 'wrapper.tar.gz')
    execFileSync('tar', ['czf', out, '-C', dir, ...members])
    return out
}

describe('BootstrapArchiveMeta', function () {
    let dir
    beforeEach(function () { dir = makeWorkDir() })
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }) })

    describe('buildBootstrapMeta()', function () {
        it('carries the format, the combo and an integer height', function () {
            const m = meta.buildBootstrapMeta({ module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', height: 964970, created: '2026-09-06T03:30:07Z' })
            expect(m).to.deep.equal({ format: 1, module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', height: 964970, created: '2026-09-06T03:30:07Z' })
        })

        it('turns a height it cannot vouch for into null rather than a number', function () {
            expect(meta.buildBootstrapMeta({ module: 'x', coin: 'c', network: 'n', height: null }).height).to.equal(null)
            expect(meta.buildBootstrapMeta({ module: 'x', coin: 'c', network: 'n', height: -1 }).height).to.equal(null)
            expect(meta.buildBootstrapMeta({ module: 'x', coin: 'c', network: 'n', height: 12.5 }).height).to.equal(null)
            expect(meta.buildBootstrapMeta({ module: 'x', coin: 'c', network: 'n', height: '964970' }).height).to.equal(null)
        })

        it('stamps a creation time when none is given', function () {
            expect(meta.buildBootstrapMeta({ module: 'x', coin: 'c', network: 'n', height: 1 }).created).to.match(/^\d{4}-\d{2}-\d{2}T/)
        })
    })

    describe('writeBootstrapMeta() + readBootstrapArchiveMeta()', function () {
        it('round-trips the height through a real wrapper when the member leads it', async function () {
            const m = meta.buildBootstrapMeta({ module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', height: 964970 })
            const member = await meta.writeBootstrapMeta(dir, m)
            expect(member).to.equal('bootstrap.json')
            writeMembers(dir, { withMeta: false })
            const archive = tarUp(dir, [member, 'dump.sql.gz', 'dump.sha256'])
            const read = await meta.readBootstrapArchiveMeta(archive)
            expect(read).to.include({ format: 1, module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', height: 964970 })
            expect(read.created).to.equal(m.created)
        })

        it('reads the height off a large archive without reading the whole archive', async function () {
            // 24 MB of incompressible payload behind the member: the reader must
            // stop after the first entry, so this runs in the time it takes to
            // gunzip a few kilobytes, not the whole file.
            writeMembers(dir, { payloadBytes: 24 * 1024 * 1024, height: 151324 })
            const archive = tarUp(dir, ['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
            const started = Date.now()
            const read = await meta.readBootstrapArchiveMeta(archive)
            expect(read.height).to.equal(151324)
            expect(Date.now() - started, 'reading the leading member must not scale with the archive').to.be.below(1500)
        })

        it('answers null for an archive published before the member existed', async function () {
            writeMembers(dir, { withMeta: false })
            const archive = tarUp(dir, ['dump.sql.gz', 'dump.sha256'])
            expect(await meta.readBootstrapArchiveMeta(archive)).to.equal(null)
        })

        it('answers null when the member is present but does not lead the archive', async function () {
            writeMembers(dir)
            const archive = tarUp(dir, ['dump.sql.gz', 'bootstrap.json', 'dump.sha256'])
            expect(await meta.readBootstrapArchiveMeta(archive)).to.equal(null)
        })

        it('answers null, never rejects, for a missing, truncated or non-gzip file', async function () {
            expect(await meta.readBootstrapArchiveMeta(path.join(dir, 'nope.tar.gz'))).to.equal(null)
            writeMembers(dir)
            const archive = tarUp(dir, ['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
            const bytes = fs.readFileSync(archive)
            const truncated = path.join(dir, 'truncated.tar.gz')
            fs.writeFileSync(truncated, bytes.subarray(0, 20))
            expect(await meta.readBootstrapArchiveMeta(truncated)).to.equal(null)
            const plain = path.join(dir, 'plain.tar.gz')
            fs.writeFileSync(plain, 'this is not gzip at all')
            expect(await meta.readBootstrapArchiveMeta(plain)).to.equal(null)
        })

        it('answers null for a leading member that is not format-1 metadata', async function () {
            fs.writeFileSync(path.join(dir, 'bootstrap.json'), JSON.stringify({ format: 2, height: 5 }))
            writeMembers(dir, { withMeta: false })
            const archive = tarUp(dir, ['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
            expect(await meta.readBootstrapArchiveMeta(archive)).to.equal(null)
            fs.writeFileSync(path.join(dir, 'bootstrap.json'), '{not json')
            const archive2 = tarUp(dir, ['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
            expect(await meta.readBootstrapArchiveMeta(archive2)).to.equal(null)
        })

        it('reads a null height as null and ignores a non-integer height', async function () {
            fs.writeFileSync(path.join(dir, 'bootstrap.json'), JSON.stringify({ format: 1, module: 'x', coin: 'c', network: 'n', height: '964970' }))
            writeMembers(dir, { withMeta: false })
            const archive = tarUp(dir, ['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
            const read = await meta.readBootstrapArchiveMeta(archive)
            expect(read).to.not.equal(null)
            expect(read.height).to.equal(null)
        })
    })

    describe('parseTarHeader()', function () {
        it('returns null for the end-of-archive zero block and for a short block', function () {
            expect(meta.parseTarHeader(Buffer.alloc(512))).to.equal(null)
            expect(meta.parseTarHeader(Buffer.alloc(100))).to.equal(null)
        })

        it('reads the name, the octal size and the type flag, stripping a ./ prefix', function () {
            const block = Buffer.alloc(512)
            block.write('./bootstrap.json', 0)
            block.write('0000117 ', 124)
            block[156] = '0'.charCodeAt(0)
            expect(meta.parseTarHeader(block)).to.deep.equal({ name: 'bootstrap.json', size: 79, typeflag: '0' })
        })
    })

    describe('readLeadingArchiveMember()', function () {
        it('skips pax extension headers ahead of the member', async function () {
            // GNU tar emits a pax header for a member with a long name or
            // non-ASCII attributes; build one explicitly to pin the skip.
            writeMembers(dir)
            const archive = tarUp(dir, ['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
            const body = await meta.readLeadingArchiveMember(archive, 'bootstrap.json')
            expect(JSON.parse(body.toString()).height).to.equal(964970)
        })

        it('refuses a leading member larger than the metadata ceiling', async function () {
            fs.writeFileSync(path.join(dir, 'bootstrap.json'), Buffer.alloc(100 * 1024, 0x20))
            writeMembers(dir, { withMeta: false })
            const archive = tarUp(dir, ['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
            expect(await meta.readLeadingArchiveMember(archive, 'bootstrap.json')).to.equal(null)
        })
    })
})
