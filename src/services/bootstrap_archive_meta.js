/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Bootstrap archive metadata
 *
 * A published bootstrap is a gzipped tar wrapping the payload (dump.sql.gz or
 * data.tar.gz) and its checksum. Until 2026-09 that was all it carried, so a
 * restore had no idea what height the snapshot ended at, and nothing could
 * compare that height with the coin node the service is about to follow. An
 * operator's fresh BTC mainnet install restored a decoder ending at 964970 next
 * to a node still in initial block download; the decoder read the node's lower
 * tip as a reorg and halted.
 *
 * The publisher now writes `bootstrap.json` as the FIRST member of the wrapper:
 *
 *   { format: 1, module, coin, network, height, created }
 *
 * First, because the tracker wrapper is well over 100 GB and every extra pass
 * over it costs a Pi-class host a quarter of an hour. Reading the leading
 * member means gunzipping a few kilobytes and stopping, whatever the archive
 * size, so the restore learns the height before it touches the store.
 *
 * The member sits inside the signed wrapper, so its provenance is the
 * archive's. An archive published before this member existed reads as
 * "height unknown", never as an error: the restore still works, it just cannot
 * compare.
 ********************************************************************/

const fs   = require('fs')
const path = require('path')
const zlib = require('zlib')

const BOOTSTRAP_META_MEMBER = 'bootstrap.json'
const BOOTSTRAP_META_FORMAT = 1

// The most bytes a metadata member may claim. A wrapper whose leading member
// is bigger is not carrying metadata, whatever its name says.
const META_MAX_BYTES = 64 * 1024

// tar header types that precede the entry they describe (pax extended,
// pax global, GNU long name / long link). Skipped, never returned.
const TAR_EXTENSION_TYPES = new Set(['x', 'g', 'L', 'K'])

function buildBootstrapMeta({ module, coin, network, height, created }) {
    return {
        format:  BOOTSTRAP_META_FORMAT,
        module,
        coin,
        network,
        height:  Number.isInteger(height) && height >= 0 ? height : null,
        created: created || new Date().toISOString()
    }
}

// Writes the member into the staging dir and returns its member name, for the
// caller to list FIRST in the wrapper's member order.
async function writeBootstrapMeta(workDir, meta) {
    await fs.promises.writeFile(path.join(workDir, BOOTSTRAP_META_MEMBER), JSON.stringify(meta, null, 2) + '\n')
    return BOOTSTRAP_META_MEMBER
}

function readCString(block, offset, length) {
    const raw = block.subarray(offset, offset + length)
    const nul = raw.indexOf(0)
    return (nul === -1 ? raw : raw.subarray(0, nul)).toString('utf8')
}

// One 512-byte ustar header block, or null for an end-of-archive block or
// anything that does not parse as a header.
function parseTarHeader(block) {
    if (!block || block.length < 512) return null
    let allZero = true
    for (let i = 0; i < 512; i++) { if (block[i] !== 0) { allZero = false; break } }
    if (allZero) return null
    const name      = readCString(block, 0, 100).replace(/^\.\//, '')
    const sizeField = readCString(block, 124, 12).trim()
    const size      = sizeField === '' ? 0 : parseInt(sizeField, 8)
    if (!Number.isFinite(size) || size < 0) return null
    const typeflag  = block[156] === 0 ? '0' : String.fromCharCode(block[156])
    return { name, size, typeflag }
}

// The content of the member named `memberName` when it leads the archive
// (optionally behind pax/GNU extension headers), else null. Reads only as far
// as it needs and then drops the stream, so the cost does not scale with the
// archive. Never rejects: an unreadable archive is "no metadata" here, and the
// integrity checks that follow in the restore are what refuse a bad archive.
function readLeadingArchiveMember(archivePath, memberName, { maxBytes = META_MAX_BYTES, maxSkippedEntries = 3 } = {}) {
    return new Promise((resolve) => {
        let settled = false
        let buffered = Buffer.alloc(0)
        let offset = 0
        let skipped = 0
        let read = null
        let gunzip = null
        const finish = (value) => {
            if (settled) return
            settled = true
            try { if (read) read.destroy() } catch { /* already closed */ }
            try { if (gunzip) gunzip.destroy() } catch { /* already closed */ }
            resolve(value)
        }
        try {
            read   = fs.createReadStream(archivePath)
            gunzip = zlib.createGunzip()
        } catch {
            return finish(null)
        }
        read.on('error', () => finish(null))
        gunzip.on('error', () => finish(null))
        gunzip.on('end', () => finish(null))
        gunzip.on('data', (chunk) => {
            if (settled) return
            buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
            // Walk headers as far as the buffered bytes allow; stop on the first
            // decision.
            for (;;) {
                if (buffered.length < offset + 512) return
                const header = parseTarHeader(buffered.subarray(offset, offset + 512))
                if (!header) return finish(null)
                if (TAR_EXTENSION_TYPES.has(header.typeflag)) {
                    if (++skipped > maxSkippedEntries) return finish(null)
                    offset += 512 + Math.ceil(header.size / 512) * 512
                    continue
                }
                if (header.name !== memberName || header.size > maxBytes) return finish(null)
                if (buffered.length < offset + 512 + header.size) return
                return finish(Buffer.from(buffered.subarray(offset + 512, offset + 512 + header.size)))
            }
        })
        read.pipe(gunzip)
    })
}

// The parsed metadata of a published bootstrap archive, or null when the
// archive predates the member or the member does not parse. `height` is an
// integer or null.
async function readBootstrapArchiveMeta(archivePath) {
    const body = await readLeadingArchiveMember(archivePath, BOOTSTRAP_META_MEMBER)
    if (!body) return null
    let parsed
    try {
        parsed = JSON.parse(body.toString('utf8'))
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object' || parsed.format !== BOOTSTRAP_META_FORMAT) return null
    return {
        format:  BOOTSTRAP_META_FORMAT,
        module:  typeof parsed.module === 'string' ? parsed.module : null,
        coin:    typeof parsed.coin === 'string' ? parsed.coin : null,
        network: typeof parsed.network === 'string' ? parsed.network : null,
        height:  Number.isInteger(parsed.height) && parsed.height >= 0 ? parsed.height : null,
        created: typeof parsed.created === 'string' ? parsed.created : null
    }
}

module.exports = {
    BOOTSTRAP_META_MEMBER,
    BOOTSTRAP_META_FORMAT,
    buildBootstrapMeta,
    writeBootstrapMeta,
    readBootstrapArchiveMeta,
    // Exported for tests
    parseTarHeader,
    readLeadingArchiveMember
}
