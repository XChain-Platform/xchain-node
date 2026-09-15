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
 * XChain Node - Interactive UI / Menu
 ********************************************************************/

const { Select } = require('enquirer')

const { restoreBootstrap, getBootstrapFilesList } = require('../../services/bootstrap_service')

async function restoreBootstrapInterface(coin, network, module, options = {}) {
    const bootstrapFiles = await getBootstrapFilesList(coin, network, module)

    // Skip the Select below for a named file, --latest or no TTY: an unanswerable
    // prompt blocks while holding the mutating-command pidfile lock, locking out
    // every other command. The archive list is newest first, so [0] is the latest.
    if (bootstrapFiles.length === 0)
        throw new Error(`No bootstrap archives found for ${coin}/${network} ${module}`)

    let preselected = null
    if (options.file) {
        if (!bootstrapFiles.includes(options.file))
            throw new Error(`Bootstrap '${options.file}' not found for ${coin}/${network} ${module}. Available: ${bootstrapFiles.join(', ')}`)
        preselected = options.file
    } else if (options.latest || !process.stdin.isTTY) {
        preselected = bootstrapFiles[0]
        if (!options.latest)
            console.log(`No TTY to prompt on; restoring the newest bootstrap (${preselected}). Pass --file to choose another.`)
    }

    if (preselected) {
        const restored = await restoreBootstrap(coin, network, module, preselected)
        if (restored) return true
        throw new Error(`Bootstrap restore failed for ${coin}/${network} ${module} (${preselected})`)
    }

    const moduleChoices = bootstrapFiles.map(f => ({ name: f, value: f }))
    moduleChoices.push({ name: "Return", value: "return" })

    const modulesSelect = new Select({
        name: 'action',
        message: 'Which bootstrap do you want to restore?',
        choices: moduleChoices
    })

    const answer = await modulesSelect.run().catch(() => "Return")
    if (answer === "Return") {
        return true
    } else {
        const bootstrapRestored = await restoreBootstrap(coin, network, module, answer)
        if (bootstrapRestored) {
            return true
        } else {
            throw false
        }
    }
}

module.exports = { restoreBootstrapInterface }
