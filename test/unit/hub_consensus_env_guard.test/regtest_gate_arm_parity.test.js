'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout')
const {
    SHARED_REGTEST_GATE_ARMS, HUB_ONLY_REGTEST_GATE_ARMS
} = require('../../../src/config/regtest_gate_arms')

const HUB_SHARED = '../../../../xchain-hub/src/consensus/gate_registry/shared_rows.js'
const HUB_ONLY = '../../../../xchain-hub/src/consensus/gate_registry.js'
const INDEXER_SHARED = '../../../../xchain-indexer/src/protocol_changes/shared_rows.js'
const HUB_SHARED_VERDICT = siblingCheckout(__dirname, HUB_SHARED)
const HUB_ONLY_VERDICT = siblingCheckout(__dirname, HUB_ONLY)
const INDEXER_VERDICT = siblingCheckout(__dirname, INDEXER_SHARED)

function sharedArmNames(source) {
    const arming = source.split('const REGTEST_ARMING = {')[1].split('const ENV_READERS = {')[0]
    const readers = source.split('const ENV_READERS = {')[1].split('};')[0]
    const names = [...arming.matchAll(/env:\s*['"](XC_[A-Z0-9_]+)['"]/g)].map(m => m[1])
    for (const match of readers.matchAll(/^\s*(XC_[A-Z0-9_]+):/gm)) names.push(match[1])
    return [...new Set(names)]
}

function hubOnlyArmNames(source) {
    return [...new Set([...source.matchAll(/env\.(XC_[A-Z0-9_]+)/g)].map(m => m[1]))]
}

function gateSetDiff(actual, expected) {
    const actualSet = new Set(actual)
    const expectedSet = new Set(expected)
    return {
        missing: expected.filter(name => !actualSet.has(name)),
        stale: actual.filter(name => !expectedSet.has(name))
    }
}

function expectExact(actual, expected) {
    const diff = gateSetDiff(actual, expected)
    expect(diff.missing, 'missing gate arms').to.deep.equal([])
    expect(diff.stale, 'stale gate arms').to.deep.equal([])
}

describe('regtest gate arm inventory parity', function () {
    before(function () {
        for (const [verdict, what] of [
            [HUB_SHARED_VERDICT, 'the hub shared gate arm guard'],
            [HUB_ONLY_VERDICT, 'the hub-only gate arm guard'],
            [INDEXER_VERDICT, 'the indexer shared gate arm guard']
        ]) if (!verdict.usable) return skipOrFail(this, verdict, what)
    })

    it('matches the hub shared and hub-only registries exactly', function () {
        const shared = sharedArmNames(fs.readFileSync(path.resolve(__dirname, HUB_SHARED), 'utf8'))
        const hubOnly = hubOnlyArmNames(fs.readFileSync(path.resolve(__dirname, HUB_ONLY), 'utf8'))
        expectExact(shared, SHARED_REGTEST_GATE_ARMS)
        expectExact(hubOnly, HUB_ONLY_REGTEST_GATE_ARMS)
    })

    it('matches the indexer shared registry exactly', function () {
        const source = fs.readFileSync(path.resolve(__dirname, INDEXER_SHARED), 'utf8')
        expectExact(sharedArmNames(source), SHARED_REGTEST_GATE_ARMS)
    })

    it('detects both missing and stale inventory names', function () {
        const expected = ['XC_ALPHA_REGTEST_ACTIVATION', 'XC_BETA_REGTEST_TIME']
        expect(gateSetDiff(['XC_ALPHA_REGTEST_ACTIVATION'], expected).missing)
            .to.deep.equal(['XC_BETA_REGTEST_TIME'])
        expect(gateSetDiff([...expected, 'XC_STALE_REGTEST_ACTIVATION'], expected).stale)
            .to.deep.equal(['XC_STALE_REGTEST_ACTIVATION'])
    })
})
