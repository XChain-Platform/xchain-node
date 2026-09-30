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

const meta = require('../../src/services/bootstrap_archive_meta')
let dir

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

function setupWorkDir() {
    dir = makeWorkDir()
}

function cleanupWorkDir() {
    fs.rmSync(dir, { recursive: true, force: true })
}

describe('BootstrapArchiveMeta', function () {
    beforeEach(setupWorkDir)
    afterEach(cleanupWorkDir)

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
})

describe('BootstrapArchiveMeta', function () {
    beforeEach(setupWorkDir)
    afterEach(cleanupWorkDir)

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
    })
})

describe('BootstrapArchiveMeta', function () {
    beforeEach(setupWorkDir)
    afterEach(cleanupWorkDir)

    describe('writeBootstrapMeta() + readBootstrapArchiveMeta()', function () {
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
})

describe('BootstrapArchiveMeta', function () {
    beforeEach(setupWorkDir)
    afterEach(cleanupWorkDir)

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

// One raw 512-byte tar header block: only the fields parseTarHeader reads.
function tarHeaderBlock(name, size, typeflag) {
    const block = Buffer.alloc(512)
    block.write(name, 0)
    block.write(size.toString(8).padStart(11, '0') + ' ', 124)
    block[156] = typeflag.charCodeAt(0)
    return block
}

function padTo512(body) {
    return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}

describe('BootstrapArchiveMeta', function () {
    beforeEach(setupWorkDir)
    afterEach(cleanupWorkDir)

    describe('readLeadingArchiveMember(): extension header size cap', function () {
        it('gives up at once on an extension header declaring more than the ceiling, without buffering the stream', async function () {
            // The reader runs before the signature check, so a crafted pax header must not make it buffer the whole gunzip output.
            const raw = Buffer.concat([tarHeaderBlock('PaxHeader', 1024 * 1024 * 1024, 'x'), Buffer.alloc(48 * 1024 * 1024, 0x41)])
            const archive = path.join(dir, 'crafted.tar.gz')
            fs.writeFileSync(archive, require('zlib').gzipSync(raw, { level: 1 }))
            const timedOut = Symbol('timed out')
            const result = await Promise.race([
                meta.readLeadingArchiveMember(archive, 'bootstrap.json'),
                new Promise(resolve => setTimeout(() => resolve(timedOut), 1000))
            ])
            expect(result).to.equal(null)
        })

        it('still skips a small pax header ahead of bootstrap.json', async function () {
            const body = Buffer.from(JSON.stringify(meta.buildBootstrapMeta({ module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', height: 42 })))
            const pax  = Buffer.from('30 mtime=1759000000.000000000\n')
            const raw  = Buffer.concat([
                tarHeaderBlock('PaxHeader', pax.length, 'x'), padTo512(pax),
                tarHeaderBlock('bootstrap.json', body.length, '0'), padTo512(body),
                Buffer.alloc(1024)
            ])
            const archive = path.join(dir, 'pax.tar.gz')
            fs.writeFileSync(archive, require('zlib').gzipSync(raw))
            expect((await meta.readBootstrapArchiveMeta(archive)).height).to.equal(42)
        })
    })

    describe('compareArchiveIdentity()', function () {
        const target = { module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet' }
        const full = { format: 1, module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', height: 1, created: null }

        it('matches an archive that declares the target identity', function () {
            expect(meta.compareArchiveIdentity(full, target)).to.deep.equal({ status: 'match', mismatches: [], unchecked: [] })
        })

        it('reports a legacy archive with no metadata as unchecked, not as a mismatch', function () {
            expect(meta.compareArchiveIdentity(null, target).status).to.equal('unchecked')
        })

        it('reports null coin/network (the classic-level converter shape) as unchecked while still checking the module', function () {
            const converted = { ...full, coin: null, network: null }
            expect(meta.compareArchiveIdentity(converted, target)).to.deep.equal({ status: 'unchecked', mismatches: [], unchecked: ['coin', 'network'] })
            expect(meta.compareArchiveIdentity({ ...converted, module: 'xchain-utxo-tracker' }, target).status).to.equal('mismatch')
        })

        it('names each field that differs', function () {
            for (const [field, value] of [['module', 'xchain-indexer'], ['coin', 'dogecoin'], ['network', 'testnet']]) {
                const result = meta.compareArchiveIdentity({ ...full, [field]: value }, target)
                expect(result.status).to.equal('mismatch')
                expect(result.mismatches).to.deep.equal([{ field, archive: value, target: target[field] }])
            }
        })
    })
})
