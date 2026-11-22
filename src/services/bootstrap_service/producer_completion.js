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
 **********************************************************************/

'use strict'

// A pipe is complete only after its producer exits cleanly and its destination
// finishes. A producer failure can still end stdout cleanly, so finish alone
// cannot distinguish complete output from a truncated stream.
function waitForProducerOutput({ producer, writeStream, streams = [], failureName, discardPartial = () => {} }) {
    return new Promise((resolve, reject) => {
        let exited = false
        let exitCode = null
        let written = false
        let settled = false

        const fail = err => {
            if (settled) return
            settled = true
            try { writeStream.destroy() } catch { /* already closed */ }
            try { discardPartial() } catch { /* the producer error is primary */ }
            reject(err)
        }
        const settle = () => {
            if (settled || !exited || !written || exitCode !== 0) return
            settled = true
            resolve()
        }

        for (const stream of [producer, writeStream, ...streams]) stream.on('error', fail)
        writeStream.on('finish', () => { written = true; settle() })
        producer.on('close', (code, signal) => {
            exited = true
            exitCode = code
            if (code !== 0) {
                const suffix = signal ? ` (signal ${signal})` : ''
                fail(new Error(`${failureName} exited with code ${code}${suffix}`))
                return
            }
            settle()
        })
    })
}

module.exports = { waitForProducerOutput }
