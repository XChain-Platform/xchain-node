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

// Shared fake SDK and runner for the stakeValidator() test files.

const sinon = require('sinon')

const { stakeValidator } = require('../../src/services/validator_stake_service')

const PUBKEY  = 'ab'.repeat(32)
const ADDRESS = 'mStakeAddress'

function makeExplorer(chain) {
    return {
        getAddress: sinon.stub().resolves({ balances: { confirmed: chain.coin ?? '0.001', pending: '0' } }),
        getToken:   chain.tokenMissing
            ? sinon.stub().rejects(Object.assign(
                new Error('Explorer returned HTTP 404 for /RBTC/api/token/XCHAIN'),
                { code: 'EXPLORER_HTTP_404', details: { status: 404 } }))
            : sinon.stub().resolves({ mints: { max: chain.mintMax ?? 10000, address_max: chain.addressMax ?? 50000 } }),
        // The whole validator set, which is the method the SDK actually has.
        // Carries an unrelated validator too, so the pubkey filter is exercised
        // rather than "the only row wins".
        getValidators: chain.validatorsThrow
            ? sinon.stub().rejects(new Error(chain.validatorsThrow))
            : sinon.stub().resolves({ data: [
                { status: 'valid', signing_pubkey: 'ff'.repeat(32), amount: '25000', action_index: '1', activation_block: '1' },
                ...(chain.existing ? [chain.existing] : []),
                ...(chain.stakeRows || [])
            ] }),
        // The delegations holding a pubkey, as the explorer's pubkey lane answers them.
        getDelegations: chain.delegationsThrow
            ? sinon.stub().rejects(new Error(chain.delegationsThrow))
            : sinon.stub().resolves(chain.delegationsBody || {
                total: (chain.delegations || []).length, data: chain.delegations || [] }),
        // The explorer's indexed tip, keyed by route code (BTC/TBTC/RBTC) as the real /status is.
        getStatus: sinon.stub().resolves({ last_block: {
            BTC: chain.tip ?? 200000, TBTC: chain.tip ?? 200000, RBTC: chain.tip ?? 200000 } }),
        // The SLEEP rows the explorer's address lane holds for the stake address; none by default.
        getSleeps: chain.sleepsThrow
            ? sinon.stub().rejects(new Error(chain.sleepsThrow))
            : sinon.stub().resolves({ total: (chain.sleeps || []).length, data: chain.sleeps || [] })
    }
}

function trackPreviousOutput(session, prevTxidRef) {
    return () => {
        const s = session()
        const inner = s.submit
        s.submit = async (a, e, o) => { const r = await inner(a, e, o); prevTxidRef.value = r.txid; return r }
        return s
    }
}

// A fake SDK shaped like the parts the command touches: explorer reads,
// balances, and a session whose mint/stake record what they were asked.
function makeSdk(chain = {}) {
    const calls = { mint: [], stake: [] }
    const sdk = {
        explorer: makeExplorer(chain),
        // The mints credit once they index. Modelled by reporting the post-mint
        // balance after they have been sent, so the fallback path can finish.
        getBalances: async () => {
            const base = chain.xchain !== undefined ? chain.xchain : 0
            const credited = calls.mint.length && chain.mintsNeverIndex !== true
                ? base + calls.mint.reduce((s, c) => s + Number(c.params.AMOUNT), 0)
                : base
            return { data: [{ tick: 'XCHAIN', amount: String(credited) }] }
        },
        // Every action goes through session.submit; the convenience wrappers
        // (mint/stake) are sugar over it, and the service calls submit directly
        // so one code path handles the funding chain.
        session: () => ({
            address: ADDRESS,
            submit: async (actionData, enc, opts) => {
                const rec = { params: actionData.params, enc, opts }
                if (actionData.action === 'MINT') calls.mint.push(rec)
                if (actionData.action === 'STAKE') calls.stake.push(rec)
                const txid = actionData.action === 'STAKE' ? 'staketx' : 'mint' + calls.mint.length
                // Report the inputs the encoder was told to use, so the chain
                // assertion in the service sees a real answer.
                const spentInputs = (enc.utxos || []).map(u => ({ txid: u.txid, vout: u.vout }))
                return { txid, spentInputs }
            }
        }),
        // The chain link: each broadcast leaves a change output the next action
        // is funded from. Keyed by txid so the service's filter is exercised.
        // noChange breaks every hop; noChangeFor breaks only the hop after the named txids.
        requireEncoder: () => ({
            getUTXOs: async () => ({ utxos: chain.noChange || (chain.noChangeFor || []).includes(prevTxidRef.value) ? [] : [
                { txid: prevTxidRef.value || 'seed', fullTxid: prevTxidRef.value || 'seed', vout: 1, value: '150000', confirmations: 0 }
            ] })
        })
    }
    // The fake encoder answers with an output of whatever was broadcast last.
    const prevTxidRef = { value: null }
    sdk.session = trackPreviousOutput(sdk.session, prevTxidRef)
    return { sdk, calls }
}

function run(opts, chain, settingsExtra = {}) {
    const { sdk, calls } = makeSdk(chain)
    const logged = []
    const network = settingsExtra.network || 'testnet'
    const deps = {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002, ...settingsExtra },
        wallets:  { NETWORK: network, STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk:  () => sdk,
        sdk:      { XChainSDK: function () { throw new Error('makeSdk should be used') } },
        log:      m => logged.push(String(m))
    }
    return stakeValidator(opts, deps).then(result => ({ result, calls, logged }))
}

module.exports = { PUBKEY, ADDRESS, makeSdk, run }
