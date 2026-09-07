/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - bootstrap republish ledger (reindex -> forced republish)
 *
 * The published bootstrap for a combo is only useful while it belongs to the
 * SAME lineage as the chain the fleet is running. A reindex (a `reset` that
 * wipes the node datadir, the tracker volume, or a decoder/indexer database and
 * rebuilds it) starts a new lineage on this box, and from that moment the
 * newest published archive describes the OLD one: a fresh install that takes it
 * restores pre-reindex state and then halts or diverges the first time it meets
 * a block the old lineage disagreed about.
 *
 * A timer alone cannot force that republish. The publisher runs nightly for
 * decoder/indexer and weekly for trackers (trackers opt-in besides, because
 * their create takes the container down), so a stale-lineage archive can stand
 * as newest for up to a week, and no age check catches it: the file itself is
 * hours old, perfectly fresh, and completely wrong.
 *
 * So the reindex itself is the trigger. `reset` records the combos it wiped
 * here; `bootstrap create` records what it published; a combo whose reindex is
 * NEWER than its last publish is DUE, and the publisher pulls due combos into
 * its plan even when the schedule or the tracker opt-in would have skipped them.
 *
 * The ledger lives in the per-user ~/.xchain-node dir (with credentials.json and
 * command.lock), NOT under XCHAIN_NODE_DATA_DIR:
 *
 *   - a `reset` wipes paths under the data dir, so a marker there is erased by
 *     the very event it exists to record, and
 *   - the publisher runs `bootstrap create` with XCHAIN_NODE_DATA_DIR pointed at
 *     its own staging volume, so a data-dir marker written by a reset would not
 *     even be on the path the publisher reads.
 *
 * Every write is best-effort and non-fatal: a reset that already wiped a store
 * must not abort because a bookkeeping file could not be written. Every read is
 * fail-soft on I/O but STRICT on content - a combo key is re-validated against
 * the known service/coin/network sets before it is returned, because the
 * publisher feeds these strings into its shell plan.
 ********************************************************************/

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const { XChainService, Coin, Network } = require('../config/constants')

const LEDGER_DIR_NAME  = '.xchain-node'
const LEDGER_FILE_NAME = 'bootstrap-reindex.json'
const LEDGER_VERSION   = 1

// The combos that have a published bootstrap at all. xchain-hub archives are
// created by a different path and are not part of the served fan-out.
const BOOTSTRAPPED_SERVICES = [
    XChainService.XCHAIN_UTXO_TRACKER,
    XChainService.XCHAIN_DECODER,
    XChainService.XCHAIN_INDEXER
]

function getReindexLedgerPath() {
    // XCHAIN_NODE_REINDEX_LEDGER_DIR is a test/ops override; the default matches
    // the CredentialsService per-user directory.
    const dir = process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR || path.join(os.homedir(), LEDGER_DIR_NAME)
    return path.join(dir, LEDGER_FILE_NAME)
}

function comboKey(module, coin, network) {
    return `${module}:${coin}:${network}`
}

// Split and re-validate a key read back from disk. Returns null for anything
// that is not a combo this node could actually publish, so a corrupt or
// tampered ledger cannot smuggle a token into the publisher's plan.
function parseComboKey(key) {
    if (typeof key !== 'string') return null
    const parts = key.split(':')
    if (parts.length !== 3) return null
    const [module, coin, network] = parts
    if (!BOOTSTRAPPED_SERVICES.includes(module)) return null
    if (!Object.values(Coin).includes(coin)) return null
    if (!Object.values(Network).includes(network)) return null
    return { combo: key, module, coin, network }
}

// An ISO-8601 instant, or null. Anything unparseable is treated as absent
// rather than as "epoch": a garbled publish timestamp must not make a due combo
// look published, and a garbled reindex timestamp must not force an endless
// republish loop.
function parseInstant(value) {
    if (typeof value !== 'string' || value === '') return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
}

function emptyLedger() {
    return { version: LEDGER_VERSION, combos: {} }
}

function readReindexLedger() {
    let raw
    try {
        raw = fs.readFileSync(getReindexLedgerPath(), 'utf8')
    } catch {
        return emptyLedger()   // absent (the normal case on a box that never reindexed)
    }
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch {
        return emptyLedger()   // corrupt: start clean rather than throw inside a reset
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.combos || typeof parsed.combos !== 'object') {
        return emptyLedger()
    }
    const combos = {}
    for (const [key, entry] of Object.entries(parsed.combos)) {
        if (!parseComboKey(key)) continue
        if (!entry || typeof entry !== 'object') continue
        combos[key] = {
            reindexedAt: typeof entry.reindexedAt === 'string' ? entry.reindexedAt : null,
            publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : null,
            reason:      typeof entry.reason === 'string' ? entry.reason : null
        }
    }
    return { version: LEDGER_VERSION, combos }
}

// Atomic replace (write a sibling temp file, then rename) so a crash or a
// concurrent reader never sees a half-written ledger. Returns false instead of
// throwing: every caller is doing bookkeeping alongside work that already
// happened.
function writeReindexLedger(ledger) {
    const target = getReindexLedgerPath()
    const tmp    = `${target}.${process.pid}.tmp`
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 })
        fs.renameSync(tmp, target)
        return true
    } catch {
        try { fs.unlinkSync(tmp) } catch { /* nothing staged */ }
        return false
    }
}

/**
 * Which published combos a reset puts in doubt: exactly the stores it wiped.
 *
 * A wiped store is re-derived, and after a genesis or protocol change it is
 * re-derived DIFFERENTLY, so its published archive can no longer be assumed to
 * match. That is a question for a human, which is what a due marker asks.
 *
 * A wiped NODE datadir deliberately marks nothing on its own. It resyncs the
 * same chain from peers and leaves every derived store untouched and still
 * valid, so fanning out from it would warn about three combos on every ordinary
 * node resync. The case that really does stale the derived archives is a
 * re-genesis, and that is run as `reset all`, which wipes those stores directly
 * and marks them through their own flags. Even a re-genesis leaves the
 * utxo-tracker archives valid, because the tracker follows the raw chain UTXO
 * set and consumes no firstBlock.
 */
// `node` is accepted and deliberately unused, so the caller can pass the reset
// flags whole and the decision above stays readable at this one site.
function reindexAffectedModules({ node = false, utxoTracker = false, decoder = false, indexer = false } = {}) {
    const affected = []
    if (utxoTracker) affected.push(XChainService.XCHAIN_UTXO_TRACKER)
    if (decoder)     affected.push(XChainService.XCHAIN_DECODER)
    if (indexer)     affected.push(XChainService.XCHAIN_INDEXER)
    return affected
}

/**
 * Record that these modules were reindexed for coin/network. Returns the combo
 * keys marked (empty when there was nothing to mark or the write failed).
 */
function recordReindex(modules, coin, network, { at = new Date(), reason = null } = {}) {
    const when   = at instanceof Date ? at.toISOString() : String(at)
    const ledger = readReindexLedger()
    const marked = []
    for (const module of modules || []) {
        const key = comboKey(module, coin, network)
        if (!parseComboKey(key)) continue
        const prev = ledger.combos[key] || {}
        ledger.combos[key] = {
            reindexedAt: when,
            publishedAt: prev.publishedAt || null,
            reason:      reason || prev.reason || null
        }
        marked.push(key)
    }
    if (marked.length === 0) return []
    return writeReindexLedger(ledger) ? marked : []
}

/**
 * Record that a bootstrap was created (and so is about to be published) for a
 * combo. This is what clears a due marker: the new archive belongs to the
 * post-reindex lineage.
 */
function recordBootstrapPublished(module, coin, network, { at = new Date() } = {}) {
    const key = comboKey(module, coin, network)
    if (!parseComboKey(key)) return false
    const ledger = readReindexLedger()
    const prev   = ledger.combos[key]
    if (!prev) return true   // never reindexed: nothing to clear, and no reason to grow the file
    ledger.combos[key] = {
        reindexedAt: prev.reindexedAt || null,
        publishedAt: at instanceof Date ? at.toISOString() : String(at),
        reason:      prev.reason || null
    }
    return writeReindexLedger(ledger)
}

// A combo is due when it has been reindexed and no publish has happened since.
// A missing publish timestamp is due by construction; equal timestamps are NOT
// due, so a publish that lands in the same millisecond as its own marker does
// not re-trigger itself forever.
function isRepublishDue(entry) {
    if (!entry) return false
    const reindexedAt = parseInstant(entry.reindexedAt)
    if (reindexedAt === null) return false
    const publishedAt = parseInstant(entry.publishedAt)
    if (publishedAt === null) return true
    return publishedAt < reindexedAt
}

/**
 * Every combo whose published archive predates its last reindex, sorted so the
 * output is stable for scripts and diffs.
 */
function listRepublishDue(ledger = readReindexLedger()) {
    const due = []
    for (const [key, entry] of Object.entries(ledger.combos || {})) {
        const parsed = parseComboKey(key)
        if (!parsed) continue
        if (!isRepublishDue(entry)) continue
        due.push({ ...parsed, reindexedAt: entry.reindexedAt, publishedAt: entry.publishedAt, reason: entry.reason })
    }
    return due.sort((a, b) => a.combo.localeCompare(b.combo))
}

module.exports = {
    BOOTSTRAPPED_SERVICES,
    LEDGER_VERSION,
    getReindexLedgerPath,
    comboKey,
    parseComboKey,
    readReindexLedger,
    writeReindexLedger,
    reindexAffectedModules,
    recordReindex,
    recordBootstrapPublished,
    isRepublishDue,
    listRepublishDue
}
