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

// Throws if any archive member name could escape the extraction directory
// (absolute path or a '..' segment). GNU tar ≥1.30 refuses '..' members and
// strips a leading '/' on its own, but that protection is implementation- and
// version-specific (bsdtar/busybox differ), so the member list is checked
// explicitly before any extraction instead of relying on tar defaults.
function assertSafeArchiveMemberNames(listing, archivePath) {
    const members = String(listing || '').split('\n').filter(Boolean)
    for (const name of members) {
        if (name.startsWith('/') || name.split('/').includes('..')) {
            throw new Error(`Refusing to extract ${archivePath}: unsafe member path "${name}"`)
        }
    }
}

async function assertSafeTarGzMembers(file) {
    const listing = await new Promise((resolve, reject) => {
        execFile('tar', ['-tzf', file], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(new Error(`Error listing archive members: ${error.message}`))
            } else {
                resolve(stdout)
            }
        })
    })
    assertSafeArchiveMemberNames(listing, file)
}

async function decompressTarGz(file) {
    await assertSafeTarGzMembers(file)
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

// Mask secret-shaped substrings before an error/string is logged. Defense in
// depth for diagnostic logs (e.g. precheck's `console.log(err)`): the actual
// credential-leak sources are fixed at the DB-command layer, but a future code
// path could surface a secret in a recognizable shape. Accepts a string or an
// Error (uses its stack) and returns a redacted string.
function redactSecrets(input) {
    let s
    if (input == null) s = ''
    else if (typeof input === 'string') s = input
    else s = String(input.stack || input.message || input)
    return s
        // SQL: PASSWORD('<secret>')
        .replace(/PASSWORD\(\s*'(?:[^'\\]|\\.)*'\s*\)/gi, "PASSWORD('<redacted>')")
        // SQL: IDENTIFIED BY '<secret>'  /  IDENTIFIED BY PASSWORD '<secret>'
        .replace(/IDENTIFIED BY\s+(?:PASSWORD\s+)?'(?:[^'\\]|\\.)*'/gi, "IDENTIFIED BY '<redacted>'")
        // Credentials embedded in a URL (git remote / connection string):
        // scheme://user:pass@host → scheme://<redacted>@host. Catches a
        // credentialed clone URL surfaced in a git error.message or a logged
        // XCHAIN_NODE_MODULES_URLS_OVERRIDE value.
        .replace(/([a-z][a-z0-9+.\-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
        // Secret-shaped env assignments surfaced in a docker command's err.cmd or
        // any argv-bearing error string: KEY=value where KEY names a credential
        // (covers -e KEY=value / --env KEY=value and MYSQL_PWD/MYSQL_ROOT_PASSWORD).
        .replace(/\b([A-Za-z0-9_]*?(?:PASSWORD|_PASS|_PWD|_API_KEY|_KEY|_SECRET|_TOKEN))=\S+/gi, '$1=<redacted>')
}

module.exports = {
    sleep,
    stringToCoin,
    stringToXChainService,
    stringToNetwork,
    decompressTarGz,
    assertSafeArchiveMemberNames,
    assertSafeTarGzMembers,
    redactSecrets
}
