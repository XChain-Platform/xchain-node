'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A reset rebuilds a store on a NEW lineage, so from that moment every bootstrap
// already published for that combo describes the old one: a fresh install that
// takes it restores pre-reindex state and halts. No age check catches that,
// because the wrong archive is hours old. These suites pin the ledger that turns
// a reindex into a due republish.

const fs          = require('fs')
const os          = require('os')
const path        = require('path')
const { spawn, spawnSync } = require('child_process')
const { expect }  = require('chai')

const { XChainService } = require('../../src/config/constants')

const TRACKER = XChainService.XCHAIN_UTXO_TRACKER
const DECODER = XChainService.XCHAIN_DECODER
const INDEXER = XChainService.XCHAIN_INDEXER

describe('BootstrapRepublishLedger', function () {

    let ledgerDir
    let ledger
    let savedDir

    beforeEach(function () {
        ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-republish-'))
        savedDir  = process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
        process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = ledgerDir
        // The path is resolved per call, so a single require is enough; the
        // require cache is cleared anyway so each suite starts from module load.
        delete require.cache[require.resolve('../../src/services/BootstrapRepublishLedger')]
        ledger = require('../../src/services/BootstrapRepublishLedger')
    })

    afterEach(function () {
        if (savedDir === undefined) delete process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
        else process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = savedDir
        fs.rmSync(ledgerDir, { recursive: true, force: true })
    })

    function ledgerFile() {
        return path.join(ledgerDir, 'bootstrap-reindex.json')
    }

    function writeRaw(text) {
        fs.writeFileSync(ledgerFile(), text)
    }

    describe('reindexAffectedModules()', function () {

        it('marks exactly the wiped service', function () {
            expect(ledger.reindexAffectedModules({ decoder: true })).to.deep.equal([DECODER])
            expect(ledger.reindexAffectedModules({ utxoTracker: true })).to.deep.equal([TRACKER])
            expect(ledger.reindexAffectedModules({ decoder: true, indexer: true }))
                .to.deep.equal([DECODER, INDEXER])
        })

        // A node-only reset resyncs the same chain and leaves every derived
        // store untouched and still valid, so fanning out from it would warn
        // about three combos on every ordinary resync. The case that really does
        // stale them is a re-genesis, which runs as `reset all` and wipes those
        // stores directly.
        it('marks nothing extra for a node datadir wipe on its own', function () {
            expect(ledger.reindexAffectedModules({ node: true })).to.deep.equal([])
            expect(ledger.reindexAffectedModules({ node: true, decoder: true })).to.deep.equal([DECODER])
        })

        it('marks all three for a reset all, through their own wipes', function () {
            expect(ledger.reindexAffectedModules({ node: true, utxoTracker: true, decoder: true, indexer: true }))
                .to.deep.equal([TRACKER, DECODER, INDEXER])
        })

        it('marks nothing when nothing was wiped', function () {
            expect(ledger.reindexAffectedModules({})).to.deep.equal([])
            expect(ledger.reindexAffectedModules()).to.deep.equal([])
        })
    })

    describe('recordReindex() -> listRepublishDue()', function () {

        it('makes a reindexed combo due, with its reason', function () {
            const marked = ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { reason: 'reset xchain-decoder' })
            expect(marked).to.deep.equal(['xchain-decoder:bitcoin:testnet'])

            const due = ledger.listRepublishDue()
            expect(due).to.have.length(1)
            expect(due[0].combo).to.equal('xchain-decoder:bitcoin:testnet')
            expect(due[0].module).to.equal(DECODER)
            expect(due[0].coin).to.equal('bitcoin')
            expect(due[0].network).to.equal('testnet')
            expect(due[0].reason).to.equal('reset xchain-decoder')
            expect(due[0].publishedAt).to.equal(null)
        })

        it('returns a stable, sorted list across several combos', function () {
            ledger.recordReindex([TRACKER, DECODER, INDEXER], 'litecoin', 'testnet', {})
            const combos = ledger.listRepublishDue().map(d => d.combo)
            expect(combos).to.deep.equal([
                'xchain-decoder:litecoin:testnet',
                'xchain-indexer:litecoin:testnet',
                'xchain-utxo-tracker:litecoin:testnet'
            ])
        })

        it('is silent for a box that never reindexed', function () {
            expect(ledger.listRepublishDue()).to.deep.equal([])
            expect(fs.existsSync(ledgerFile())).to.be.false
        })

        it('refuses a combo that is not publishable', function () {
            expect(ledger.recordReindex(['xchain-encoder'], 'bitcoin', 'testnet', {})).to.deep.equal([])
            expect(ledger.recordReindex([DECODER], 'notacoin', 'testnet', {})).to.deep.equal([])
            expect(ledger.recordReindex([DECODER], 'bitcoin', 'notanetwork', {})).to.deep.equal([])
            expect(ledger.listRepublishDue()).to.deep.equal([])
        })

        it('keeps the newest reindex when a combo is wiped twice', function () {
            ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-08-01T00:00:00Z'), reason: 'first' })
            ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T00:00:00Z'), reason: 'second' })
            const due = ledger.listRepublishDue()
            expect(due).to.have.length(1)
            expect(due[0].reindexedAt).to.equal('2026-09-01T00:00:00.000Z')
            expect(due[0].reason).to.equal('second')
        })
    })

    describe('recordBootstrapPublished()', function () {

        it('clears a due combo once a newer archive exists', function () {
            ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T00:00:00Z') })
            expect(ledger.listRepublishDue()).to.have.length(1)

            expect(ledger.recordBootstrapPublished(DECODER, 'bitcoin', 'testnet', { at: new Date('2026-09-01T01:00:00Z') })).to.be.true
            expect(ledger.listRepublishDue()).to.deep.equal([])
        })

        // The whole point of the item: a publish that predates the reindex is
        // the STALE-lineage archive, so it must not count as satisfying it.
        it('does not clear a combo whose newest archive predates the reindex', function () {
            ledger.recordBootstrapPublished(DECODER, 'bitcoin', 'testnet', { at: new Date('2026-08-30T00:00:00Z') })
            ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T00:00:00Z') })

            const due = ledger.listRepublishDue()
            expect(due.map(d => d.combo)).to.deep.equal(['xchain-decoder:bitcoin:testnet'])
        })

        it('clears only the combo it names', function () {
            ledger.recordReindex([TRACKER, DECODER], 'bitcoin', 'testnet', { at: new Date('2026-09-01T00:00:00Z') })
            ledger.recordBootstrapPublished(DECODER, 'bitcoin', 'testnet', { at: new Date('2026-09-01T02:00:00Z') })
            expect(ledger.listRepublishDue().map(d => d.combo))
                .to.deep.equal(['xchain-utxo-tracker:bitcoin:testnet'])
        })

        it('does not grow the ledger for a combo that was never reindexed', function () {
            expect(ledger.recordBootstrapPublished(DECODER, 'bitcoin', 'testnet')).to.be.true
            expect(fs.existsSync(ledgerFile())).to.be.false
        })
    })

    describe('isRepublishDue()', function () {

        it('is due with a reindex and no publish', function () {
            expect(ledger.isRepublishDue({ reindexedAt: '2026-09-01T00:00:00Z', publishedAt: null })).to.be.true
        })

        // Guards against a create that stamps its publish in the same
        // millisecond as the marker it clears re-triggering itself forever.
        it('is not due when the publish is at or after the reindex', function () {
            expect(ledger.isRepublishDue({ reindexedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z' })).to.be.false
            expect(ledger.isRepublishDue({ reindexedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-02T00:00:00Z' })).to.be.false
        })

        it('is not due without a reindex at all', function () {
            expect(ledger.isRepublishDue({ reindexedAt: null, publishedAt: '2026-09-01T00:00:00Z' })).to.be.false
            expect(ledger.isRepublishDue(null)).to.be.false
        })

        // "We cannot tell when it was published" must not read as "it was
        // published after the reindex": that would silently cancel the forced
        // republish, which is the exact outcome the ledger exists to prevent.
        it('treats an unparseable publish timestamp as no publish', function () {
            expect(ledger.isRepublishDue({ reindexedAt: '2026-09-01T00:00:00Z', publishedAt: 'whenever' })).to.be.true
        })

        it('treats an unparseable reindex timestamp as no reindex', function () {
            expect(ledger.isRepublishDue({ reindexedAt: 'whenever', publishedAt: null })).to.be.false
        })
    })

    describe('reading a damaged ledger', function () {

        it('starts clean on unparseable JSON rather than throwing inside a reset', function () {
            writeRaw('{ not json')
            expect(ledger.readReindexLedger().combos).to.deep.equal({})
            expect(ledger.listRepublishDue()).to.deep.equal([])
            // and a fresh mark still lands
            expect(ledger.recordReindex([DECODER], 'bitcoin', 'testnet', {})).to.have.length(1)
            expect(ledger.listRepublishDue()).to.have.length(1)
        })

        it('starts clean on a well-formed file of the wrong shape', function () {
            writeRaw(JSON.stringify({ version: 1, combos: 'nope' }))
            expect(ledger.readReindexLedger().combos).to.deep.equal({})
            writeRaw(JSON.stringify([1, 2, 3]))
            expect(ledger.readReindexLedger().combos).to.deep.equal({})
        })

        // The publisher feeds these strings into its shell plan, so a key that
        // is not a combo this node could publish is dropped on read rather than
        // handed onward.
        it('drops keys that are not publishable combos', function () {
            writeRaw(JSON.stringify({
                version: 1,
                combos: {
                    'xchain-decoder:bitcoin:testnet':  { reindexedAt: '2026-09-01T00:00:00Z' },
                    'xchain-decoder:bitcoin':          { reindexedAt: '2026-09-01T00:00:00Z' },
                    'xchain-encoder:bitcoin:testnet':  { reindexedAt: '2026-09-01T00:00:00Z' },
                    'xchain-decoder:bitcoin:mainnet; rm -rf /': { reindexedAt: '2026-09-01T00:00:00Z' },
                    'xchain-decoder:evilcoin:testnet': { reindexedAt: '2026-09-01T00:00:00Z' }
                }
            }))
            expect(ledger.listRepublishDue().map(d => d.combo))
                .to.deep.equal(['xchain-decoder:bitcoin:testnet'])
        })

        it('drops entries that are not objects', function () {
            writeRaw(JSON.stringify({
                version: 1,
                combos: { 'xchain-decoder:bitcoin:testnet': 'reindexed' }
            }))
            expect(ledger.listRepublishDue()).to.deep.equal([])
        })
    })

    describe('writeReindexLedger()', function () {

        it('replaces the file atomically and leaves no temp file behind', function () {
            expect(ledger.writeReindexLedger({ version: 1, combos: {} })).to.be.true
            expect(fs.existsSync(ledgerFile())).to.be.true
            expect(fs.readdirSync(ledgerDir).filter(f => f.endsWith('.tmp'))).to.deep.equal([])
        })

        // A reset has already wiped a store by the time it records anything, so
        // an unwritable ledger dir must report failure, never throw.
        it('reports failure instead of throwing when the target is unwritable', function () {
            process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR = path.join(ledgerDir, 'a-file', 'nested')
            fs.writeFileSync(path.join(ledgerDir, 'a-file'), 'not a directory')
            expect(ledger.writeReindexLedger({ version: 1, combos: {} })).to.be.false
            expect(ledger.recordReindex([DECODER], 'bitcoin', 'testnet', {})).to.deep.equal([])
        })
    })

    describe('getReindexLedgerPath()', function () {

        it('defaults to the per-user ~/.xchain-node dir, not the data dir', function () {
            delete process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR
            // A reset wipes paths under the data dir, and the publisher runs
            // `bootstrap create` with XCHAIN_NODE_DATA_DIR pointed at its own
            // staging volume, so the marker cannot live there.
            expect(ledger.getReindexLedgerPath())
                .to.equal(path.join(os.homedir(), '.xchain-node', 'bootstrap-reindex.json'))
        })
    })

    // The publisher asks this on every run and treats a non-zero exit as "no
    // combo is due". Provisioning Docker/MariaDB or queuing behind the command
    // lock to read one local JSON file would therefore turn a busy box into a
    // silently cancelled republish. Driven as the real CLI in a child process,
    // because the behaviour lives in the preAction hook, not an export.
    describe('the bootstrap-republish-due command', function () {

        this.timeout(30000)

        const CLI = path.join(__dirname, '..', '..', 'src', 'index.js')
        let lockDir, holder

        beforeEach(function () {
            lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-due-lock-'))
            holder  = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'])
            fs.writeFileSync(
                path.join(lockDir, 'command.lock'),
                JSON.stringify({ pid: holder.pid, command: 'update', startedAt: new Date().toISOString() })
            )
        })

        afterEach(function () {
            if (holder) holder.kill()
            fs.rmSync(lockDir, { recursive: true, force: true })
        })

        function runDue(args = []) {
            const res = spawnSync(process.execPath, [CLI, 'bootstrap-republish-due', ...args], {
                env: {
                    ...process.env,
                    XCHAIN_NODE_REINDEX_LEDGER_DIR: ledgerDir,
                    XCHAIN_NODE_LOCK_DIR: lockDir,
                    // No unit test may reach a real Docker daemon.
                    DOCKER_HOST: 'unix:///nonexistent/xchain-node-test-docker.sock'
                },
                encoding: 'utf8',
                timeout: 25000
            })
            return { status: res.status, out: `${res.stdout || ''}`, err: `${res.stderr || ''}` }
        }

        it('answers while another command holds the lock and Docker is unreachable', function () {
            ledger.recordReindex([DECODER], 'bitcoin', 'testnet', { reason: 'reset xchain-decoder' })
            const { status, out, err } = runDue()
            expect(status, `stderr: ${err}`).to.equal(0)
            expect(out.trim()).to.equal('xchain-decoder:bitcoin:testnet')
            expect(err).to.not.match(/holds the command lock/)
            expect(err).to.not.match(/Docker is not installed/)
        })

        it('prints nothing and succeeds when no combo is due', function () {
            const { status, out } = runDue()
            expect(status).to.equal(0)
            expect(out.trim()).to.equal('')
        })

        it('--json carries the timestamps the operator needs to judge the gap', function () {
            ledger.recordReindex([TRACKER], 'litecoin', 'testnet', {
                at: new Date('2026-09-01T00:00:00Z'), reason: 'reset all'
            })
            const { status, out } = runDue(['--json'])
            expect(status).to.equal(0)
            const parsed = JSON.parse(out)
            expect(parsed).to.have.length(1)
            expect(parsed[0].combo).to.equal('xchain-utxo-tracker:litecoin:testnet')
            expect(parsed[0].reindexedAt).to.equal('2026-09-01T00:00:00.000Z')
            expect(parsed[0].publishedAt).to.equal(null)
            expect(parsed[0].reason).to.equal('reset all')
        })
    })
})
