#!/usr/bin/env node
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

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const wallets = require('../src/services/validator_service/wallets')

const ARM_ENV_NAMES = [
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION',
]
const DEFAULT_AMOUNT = 100
const DOGE_REGTEST_CONFIG = path.join(__dirname, '../config/dogecoin-regtest')

function hasAnchorArm (env) {
    return ARM_ENV_NAMES.some((name) => env[name] !== undefined && env[name] !== null && env[name] !== '')
}

function publisherFundingPlan ({ env, wallet, minerPort, amount }) {
    if (!hasAnchorArm(env)) return null
    if (!wallet || wallet.network !== 'regtest') {
        const network = wallet && wallet.network
        throw new Error('wallet.network must be regtest, received ' + String(network))
    }
    if (!wallet.dogeAddress) throw new Error('wallet.dogeAddress is required')

    return {
        address: wallet.dogeAddress,
        amount,
        minerUrl: 'http://127.0.0.1:' + minerPort,
    }
}

function rpcError (response) {
    const data = response && response.data
    if (data && data.error) return data.error.message || String(data.error)
    if (data && data.result && data.result.error) return String(data.result.error)
    return null
}

async function callMiner (plan, post, method, params, id) {
    try {
        const response = await post(plan.minerUrl, {
            jsonrpc: '2.0',
            id,
            method,
            params,
        })
        const error = rpcError(response)
        if (error) throw new Error(error)
        return response
    } catch (error) {
        throw new Error(method + ' failed: ' + error.message)
    }
}

async function fundPublisher (plan, { post }) {
    await callMiner(plan, post, 'send_funds', {
        address: plan.address,
        amount: plan.amount,
    }, 1)
    await callMiner(plan, post, 'generate_blocks', { count: 1 }, 2)
}

function readMinerPort (readFileSync, configPath) {
    const text = readFileSync(configPath, 'utf8')
    const match = /^REGTEST_MINER_PORT=(.+)$/m.exec(text)
    if (!match || !/^\d+$/.test(match[1]) || Number(match[1]) < 1) {
        throw new Error('REGTEST_MINER_PORT is missing or invalid in ' + configPath)
    }
    return Number(match[1])
}

async function main (dependencies = {}) {
    const env = dependencies.env || process.env
    if (!hasAnchorArm(env)) return null

    const readWallets = dependencies.readWallets || wallets.readWallets
    const publicWalletInfo = dependencies.publicWalletInfo || wallets.publicWalletInfo
    const readFileSync = dependencies.readFileSync || fs.readFileSync
    const post = dependencies.post || axios.post
    const configPath = dependencies.configPath || DOGE_REGTEST_CONFIG
    const amount = dependencies.amount === undefined ? DEFAULT_AMOUNT : dependencies.amount
    const wallet = publicWalletInfo(readWallets())
    const minerPort = readMinerPort(readFileSync, configPath)
    const plan = publisherFundingPlan({ env, wallet, minerPort, amount })
    await fundPublisher(plan, { post })
    return plan
}

module.exports = {
    ARM_ENV_NAMES,
    publisherFundingPlan,
    fundPublisher,
    main,
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(error.message + '\n')
        process.exitCode = 1
    })
}
