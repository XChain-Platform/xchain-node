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
 * XChain Node - Recreate Container Environment
 ********************************************************************/

'use strict'

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

/**
 * Read a container's frozen environment as a plain object.
 *
 * @param {string} container Container id or name.
 * @param {{execFileAsync?: Function}} [deps]
 * @returns {Promise<Object<string,string>|null>}
 */
async function readContainerEnv(container, deps = {}) {
    if (!container) return null
    const runDocker = deps.execFileAsync || execFileAsync
    let stdout
    try {
        const result = await runDocker(
            'docker',
            ['inspect', '--type', 'container', '--format', '{{json .Config.Env}}', container]
        )
        stdout = result && typeof result === 'object' && 'stdout' in result ? result.stdout : result
    } catch {
        return null
    }
    let parsed
    try {
        parsed = JSON.parse(String(stdout).trim())
    } catch {
        return null
    }
    if (!Array.isArray(parsed)) return null
    const env = {}
    for (const entry of parsed) {
        const eqIndex = String(entry).indexOf('=')
        if (eqIndex <= 0) continue
        env[String(entry).substring(0, eqIndex)] = String(entry).substring(eqIndex + 1)
    }
    return env
}

/**
 * Merge a reused container's environment under the current configuration.
 *
 * @param {Object<string,*>} configuredEnv Current getDefaultConfig output.
 * @param {{reuseImage?: boolean, overwriteContainerId?: string|null, containerName?: string}} options
 * @param {{execFileAsync?: Function}} [deps]
 * @returns {Promise<Object<string,*>>}
 */
async function carryContainerEnv(configuredEnv, options = {}, deps = {}) {
    if (options.reuseImage !== true) return configuredEnv
    const sources = [...new Set([options.overwriteContainerId, options.containerName].filter(Boolean))]
    for (const source of sources) {
        const carriedEnv = await readContainerEnv(source, deps)
        if (carriedEnv) return { ...carriedEnv, ...configuredEnv }
    }
    return configuredEnv
}

module.exports = { readContainerEnv, carryContainerEnv }
