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
 * XChain Node - Reset against a stack's own DB server (--db-container)
 * Which resets may take the override, and how its services are found
 ********************************************************************/

'use strict'

// Say why a reset may not take --db-container, or null when it may. A stack run by hand outside this CLI keeps
// set-aside chain dirs beside its live datadir, so only the database resets are allowed: no node wipe (`all`,
// `node`), and no tracker volume, which is not a database step.
function dbOverrideRefusal(service, { externalDb, nodeModuleName, XChainService }) {
    if (externalDb) return '--db-container cannot be combined with the external-DB mode'
    if (service === 'all' || service === nodeModuleName) {
        return `--db-container never wipes a node datadir, so it does not take '${service}'`
    }
    if (service !== XChainService.XCHAIN_DECODER && service !== XChainService.XCHAIN_INDEXER) {
        return `--db-container applies only to ${XChainService.XCHAIN_DECODER} and ${XChainService.XCHAIN_INDEXER}`
    }
    return null
}

// Find a service container by the name the stack gives it, not through this CLI's registry: a stack this CLI did
// not install is not in it, and a recreated container leaves a stale id there. Only docker saying "no such
// container" is absence; any other failure throws, so the reset refuses instead of wiping under a live service.
function containerByNameLookup(execFileAsync, getDockerContainerImageName) {
    return async (module, coin, network) => {
        const name = getDockerContainerImageName(module, coin, network)
        let stdout
        try {
            ({ stdout } = await execFileAsync('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', name]))
        } catch (err) {
            const text = String((err && (err.stderr || '')) + ' ' + ((err && err.message) || err))
            if (/no such (object|container)/i.test(text)) return null
            throw new Error(`docker inspect ${name} failed (${(err && err.message) || err})`)
        }
        const id = String(stdout).trim()
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`docker inspect ${name} returned no container id`)
        return id
    }
}

// Read --db-container off a reset's options: why it is refused (or null), and how this reset finds its containers.
// `deps` carries the reset's own config constants, registry and docker exec.
function dbOverrideFor(service, options, deps) {
    const dbContainer = (options && options.dbContainer) || null
    const refusal = dbContainer
        ? dbOverrideRefusal(service, { externalDb: deps.EXTERNAL_DB, nodeModuleName: deps.NODE_MODULE_NAME, XChainService: deps.XChainService })
        : null
    const findContainer = dbContainer
        ? containerByNameLookup(deps.execFileAsync, deps.getDockerContainerImageName)
        : (module, coin, network) => deps.db.getModuleContainerStrict(module, coin, network)
    return { refusal, dbContainer, findContainer, check: !!(dbContainer && options.check) }
}

// The databases a reset drops and recreates, decoder first.
function dbModulesFor({ resetDecoder, resetIndexer }, XChainService) {
    return [
        ...(resetDecoder ? [XChainService.XCHAIN_DECODER] : []),
        ...(resetIndexer ? [XChainService.XCHAIN_INDEXER] : []),
    ]
}

// The trailing argument a DB call takes for a --db-container reset; none otherwise, so the default calls are unchanged.
function namedTargetArgs(context) {
    return context.namedDbTarget ? [context.namedDbTarget] : []
}

// Resolve the named server while nothing is stopped: its id, a root or the stack's own database users that log in,
// and the target databases already on it. The stack's services are found by the same name lookup the stop loop
// uses, so their env can supply those users. Answers null after printing the refusal, so the caller returns early.
async function namedTargetBeforeStop(context, resolveNamedDatabaseTarget, failureReason, XChainService) {
    const { coin, dbContainer, network } = context
    const findServiceContainer = (module) => context.findContainer(module, coin, network)
    let target
    try {
        target = await resolveNamedDatabaseTarget(dbContainer, coin, network, dbModulesFor(context, XChainService), findServiceContainer)
    } catch (err) {
        console.log(`Aborted: cannot use the MariaDB container ${dbContainer} (${failureReason(err)}). No data was touched.`)
        return null
    }
    console.log(`Database steps run on ${dbContainer} (${target.databases.join(', ')}); the hub and explorer config push is skipped.`)
    // Users and the grants that allowed them, never a password. A root run says so only under --check, so its output is unchanged.
    if (target.authReport) {
        for (const line of target.authReport) console.log(line)
    } else if (context.check) {
        console.log(`Logs in to ${dbContainer} as root.`)
    }
    return target
}

// Where a --db-container reset ends while nothing is stopped: a refused server (null, already reported) fails, and a
// --check run (which skips the confirmation, since it changes nothing) passes here instead of reaching the stop loop.
function endBeforeStop(target) {
    if (!target) return false
    console.log('Check passed: the reset would run as above. Nothing was stopped or changed.')
    return true
}

module.exports = { dbOverrideRefusal, containerByNameLookup, dbOverrideFor, dbModulesFor, endBeforeStop, namedTargetArgs, namedTargetBeforeStop }
