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

const sinon      = require('sinon')
const { expect } = require('chai')

const { NO_LOCK, sendLockFor, releaseOnIndexWait, holdForSend } =
    require('../../../../src/services/validator_stake_service/send_lock')

describe('validator stake send lock selection and release', function () {
    afterEach(function () { sinon.restore() })

    it('provides a frozen no-op lock', function () {
        expect(Object.isFrozen(NO_LOCK)).to.be.true
        expect(NO_LOCK.hold()).to.equal(undefined)
        expect(NO_LOCK.release()).to.equal(undefined)
    })

    it('selects a supplied lock only for broadcasts', function () {
        const lock = { hold: sinon.stub(), release: sinon.stub() }
        expect(sendLockFor({ broadcast: true }, { sendLock: lock })).to.equal(lock)
        expect(sendLockFor({ broadcast: 'yes' }, { sendLock: lock })).to.equal(lock)
        expect(sendLockFor()).to.equal(NO_LOCK)
        expect(sendLockFor({ broadcast: true })).to.equal(NO_LOCK)
        expect(sendLockFor({ broadcast: false }, { sendLock: lock })).to.equal(NO_LOCK)
        expect(sendLockFor({ broadcast: true }, {})).to.equal(NO_LOCK)
    })

    it('releases only when a send reaches its index wait', function () {
        const lock = { release: sinon.stub() }
        const onStep = releaseOnIndexWait(lock)
        onStep('broadcasting')
        onStep('confirmed')
        expect(lock.release.called).to.be.false
        onStep('waiting')
        expect(lock.release.calledOnce).to.be.true
    })
})

describe('validator stake send lock hold', function () {
    afterEach(function () { sinon.restore() })

    it('holds the lock before a send', function () {
        const lock = { hold: sinon.stub() }
        holdForSend(lock, [], 'stake transaction')
        expect(lock.hold.calledOnce).to.be.true
    })

    it('rethrows the original error before anything was sent', function () {
        const original = Object.assign(new Error('lock held'), { code: 'ELOCKHELD' })
        const lock = { hold: sinon.stub().throws(original) }
        expect(() => holdForSend(lock, [], 'stake transaction')).to.throw(original)
    })

    it('describes every earlier broadcast when a later hold fails', function () {
        const original = Object.assign(new Error('lock held'), { code: 'ELOCKHELD' })
        const lock = { hold: sinon.stub().throws(original) }
        const sent = [
            { step: 'fund', txid: 'tx-123' },
            { step: 'register', txid: 'tx-456' }
        ]

        let stopped
        try {
            holdForSend(lock, sent, 'stake transaction')
        } catch (err) {
            stopped = err
        }
        expect(stopped).to.be.an('error').and.not.equal(original)
        expect(stopped.code).to.equal(original.code)
        expect(stopped.message).to.include('stake transaction')
        expect(stopped.message).to.include('fund tx-123')
        expect(stopped.message).to.include('register tx-456')
    })
})
