'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Pins the send-phase command lock on `validator stake|unstake --broadcast`: a
// second broadcast is refused while a send is in flight, and the indexer wait
// that follows holds nothing. Drives the real file lock in a scratch directory.

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const sinon = require('sinon')
const { expect } = require('chai')

const { stakeValidator, unstakeValidator } = require('../../../src/services/validator_stake_service')
const { acquireCommandLock } = require('../../../src/utils/command_lock')
const { validatorSendLock } = require('../../../src/cli/dispatch')
const { COIN_NETWORKS } = require('../../../src/services/validator_service')

const PUBKEY  = 'ab'.repeat(32)
const ADDRESS = 'mStakeAddress'
const STAKED  = { status: 'valid', signing_pubkey: PUBKEY, source: ADDRESS, amount: '25000', action_index: '44',
    activation_block: '150313' }

let lockDir

// Read who holds the lock file right now, or null when it is free.
function lockHolder() {
    const file = path.join(lockDir, 'command.lock')
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).command : null
}

// Try the lock as another command would; true when it was free and is handed straight back.
function otherCommandGetsLock(command = 'update') {
    try {
        acquireCommandLock({ command })()
        return true
    } catch (err) {
        if (err.code === 'ELOCKHELD') return false
        throw err
    }
}

function makeExplorer(chain) {
    return {
        getAddress:     sinon.stub().resolves({ balances: { confirmed: '0.001', pending: '0' } }),
        getToken:       sinon.stub().resolves({ mints: { max: 10000, address_max: 50000 } }),
        getValidators:  sinon.stub().resolves({ data: chain.existing ? [chain.existing] : [] }),
        getDelegations: sinon.stub().resolves({ total: 0, data: [] }),
        getStatus:      sinon.stub().resolves({ last_block: Object.fromEntries(
            Object.values(COIN_NETWORKS).map(c => [c.stakeCoin, 200000])) })
    }
}

// A fake SDK whose submit follows the real lifecycle order: broadcast, then the
// 'waiting' progress step, then the indexer wait. Hooks run inside each phase.
function makeSdk(chain, hooks = {}) {
    const sent = []
    let prevTxid = null
    const sdk = {
        explorer: makeExplorer(chain),
        getBalances: async () => ({ data: [{ tick: 'XCHAIN', amount: String(chain.xchain || 0) }] }),
        requireEncoder: () => ({ getUTXOs: async () => ({ utxos: [
            { txid: prevTxid || 'seed', fullTxid: prevTxid || 'seed', vout: 1, value: '150000', confirmations: 0 }] }) }),
        session: () => ({
            address: ADDRESS,
            submit: async (actionData, enc, opts) => {
                const txid = actionData.action.toLowerCase() + (sent.length + 1)
                const progress = opts.onProgress || (() => {})
                progress('broadcasting', { txid })
                if (hooks.duringSend) await hooks.duringSend(actionData.action)
                sent.push({ action: actionData.action, txid })
                prevTxid = txid
                if (opts.waitForIndexer) {
                    progress('waiting', { txid })
                    if (hooks.duringWait) await hooks.duringWait(actionData.action)
                }
                return { txid, spentInputs: (enc.utxos || []).map(u => ({ txid: u.txid, vout: u.vout })) }
            }
        })
    }
    return { sdk, sent }
}

function runDeps(sdk, command) {
    return {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002 },
        wallets:  { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk:  () => sdk,
        sdk:      {},
        log:      () => {},
        sendLock: validatorSendLock(command, { acquireCommandLock, config: {} })
    }
}

function stake(opts, chain, hooks) {
    const { sdk, sent } = makeSdk(chain, hooks)
    return stakeValidator(opts, runDeps(sdk, 'validator stake')).then(result => ({ result, sent }))
}

function unstake(opts, chain, hooks) {
    const { sdk, sent } = makeSdk(chain, hooks)
    return unstakeValidator(opts, runDeps(sdk, 'validator unstake')).then(result => ({ result, sent }))
}

// Run a second broadcast from inside the first and report how it ended and what it sent.
async function secondRun(run, command, chain) {
    const { sdk, sent } = makeSdk(chain)
    try {
        await run({ broadcast: true }, runDeps(sdk, command))
        return { refused: false, sent }
    } catch (err) {
        return { refused: err.code === 'ELOCKHELD', message: err.message, sent }
    }
}

function useScratchLockDir() {
    beforeEach(function () {
        lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-sendlock-'))
        process.env.XCHAIN_NODE_LOCK_DIR = lockDir
    })
    afterEach(function () {
        delete process.env.XCHAIN_NODE_LOCK_DIR
        fs.rmSync(lockDir, { recursive: true, force: true })
        sinon.restore()
    })
}

describe('validator stake --broadcast: send-phase command lock', function () {
    useScratchLockDir()

    it('refuses a second stake --broadcast while the first is sending, and it sends nothing', async function () {
        let second = null
        let holder = null
        const { result } = await stake({ broadcast: true }, { xchain: 30000 }, {
            duringSend: async () => {
                holder = lockHolder()
                second = await secondRun(stakeValidator, 'validator stake', { xchain: 30000 })
            }
        })
        expect(result.staked).to.be.true
        expect(second.sent, 'the second run sent').to.deep.equal([])
        expect(second.refused, second.message).to.be.true
        expect(holder).to.equal('validator stake')
        expect(second.message).to.include('running "validator stake"')
        expect(lockHolder()).to.equal(null)
    })

    it('hands the lock back for the STAKE\'s index wait, so another command runs meanwhile', async function () {
        const seen = {}
        await stake({ broadcast: true }, { xchain: 30000 }, {
            duringSend: async () => { seen.send = otherCommandGetsLock() },
            duringWait: async () => { seen.wait = otherCommandGetsLock() }
        })
        expect(seen.send, 'another command during the send').to.be.false
        expect(seen.wait, 'another command during the index wait').to.be.true
    })

    it('holds the lock across every chained mint and the STAKE, which send without a wait between', async function () {
        const during = []
        const { sent } = await stake({ broadcast: true }, { xchain: 0 }, {
            duringSend: async (action) => { during.push(action + ':' + otherCommandGetsLock()) }
        })
        expect(sent.map(s => s.action)).to.deep.equal(['MINT', 'MINT', 'MINT', 'STAKE'])
        expect(during).to.deep.equal(['MINT:false', 'MINT:false', 'MINT:false', 'STAKE:false'])
    })
})

describe('validator stake --broadcast: send lock across waits, dry runs and early stops', function () {
    useScratchLockDir()

    it('--serialize retakes the lock after each mint\'s wait and stops, naming what went out, if it is taken', async function () {
        let taken = null
        let failure = null
        try {
            await stake({ broadcast: true, serialize: true }, { xchain: 0 }, {
                duringWait: async (action) => {
                    if (action === 'MINT' && !taken) taken = acquireCommandLock({ command: 'update' })
                }
            })
        } catch (err) {
            failure = err
        } finally {
            if (taken) taken()
        }
        expect(failure, 'the run must stop at the second mint').to.not.equal(null)
        expect(failure.code).to.equal('ELOCKHELD')
        expect(failure.message).to.include('Stopped before the MINT; already broadcast: MINT mint1')
    })

    it('a dry run takes no lock, so it plans while a deploy holds it', async function () {
        const release = acquireCommandLock({ command: 'update' })
        try {
            const { result } = await stake({}, { xchain: 30000 })
            expect(result.dryRun).to.be.true
        } finally {
            release()
        }
    })

    it('releases the lock and its exit handler when the run stops short of sending', async function () {
        const exitListeners = process.listeners('exit').length
        const { result } = await stake({ broadcast: true }, { xchain: 30000, existing: STAKED })
        expect(result.staked).to.be.false
        expect(lockHolder()).to.equal(null)
        expect(process.listeners('exit').length).to.equal(exitListeners)
    })
})

describe('validator unstake --broadcast: send-phase command lock', function () {
    useScratchLockDir()

    it('refuses a second unstake --broadcast while the first is sending, and it sends nothing', async function () {
        let second = null
        let holder = null
        const { result } = await unstake({ broadcast: true }, { existing: STAKED }, {
            duringSend: async () => {
                holder = lockHolder()
                second = await secondRun(unstakeValidator, 'validator unstake', { existing: STAKED })
            }
        })
        expect(result.unstaked).to.be.true
        expect(second.sent, 'the second run sent').to.deep.equal([])
        expect(second.refused, second.message).to.be.true
        expect(holder).to.equal('validator unstake')
        expect(lockHolder()).to.equal(null)
    })

    it('hands the lock back for the UNSTAKE\'s index wait, so another command runs meanwhile', async function () {
        const seen = {}
        await unstake({ broadcast: true }, { existing: STAKED }, {
            duringSend: async () => { seen.send = otherCommandGetsLock() },
            duringWait: async () => { seen.wait = otherCommandGetsLock() }
        })
        expect(seen.send, 'another command during the send').to.be.false
        expect(seen.wait, 'another command during the index wait').to.be.true
    })

    it('--no-wait keeps the lock to the broadcast and frees it when the run returns', async function () {
        const { result } = await unstake({ broadcast: true, wait: false }, { existing: STAKED }, {
            duringSend: async () => { expect(otherCommandGetsLock()).to.be.false }
        })
        expect(result.unstaked).to.be.true
        expect(lockHolder()).to.equal(null)
    })
})
