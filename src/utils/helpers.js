/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Utility helpers
 ********************************************************************/

const { execFile } = require('child_process')
const path         = require('path')
const { Coin, Network, XChainService } = require('../config/constants')

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function stringToCoin(coinString) {
    for (let key in Coin) {
        if (Coin[key] === coinString) return key
    }
    return null
}

function stringToXChainService(serviceString) {
    for (let key in XChainService) {
        if (XChainService[key] === serviceString) return key
    }
    return null
}

function stringToNetwork(networkString) {
    const [coin, network] = networkString.split("-")

    let coinKey = null
    let networkKey = null

    for (let key in Network) {
        if (Network[key] === network) { networkKey = key; break }
    }
    for (let key in Coin) {
        if (Coin[key] === coin) { coinKey = key; break }
    }

    return { coin: coinKey, network: networkKey }
}

async function decompressTarGz(file) {
    return new Promise((resolve, reject) => {
        execFile('tar', ['-xvzf', file], { cwd: path.dirname(file) }, (error) => {
            if (error) {
                reject(`Error decompressing a file: ${error.message}`)
            } else {
                resolve(true)
            }
        })
    })
}

module.exports = {
    sleep,
    stringToCoin,
    stringToXChainService,
    stringToNetwork,
    decompressTarGz
}
