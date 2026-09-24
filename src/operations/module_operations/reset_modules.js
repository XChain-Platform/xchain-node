'use strict'

let confirmDestructiveReset, failureReason, isNoSuchContainerError, isNoSuchVolumeError, resolveNodeDataPath, restartResetModules, restartStoppedModules, Coin, CoinTickerSymbol, EXTERNAL_DB, HUB_MODULE_NAME, Network, NODE_MODULE_NAME, XChainService, clearHubPriceIngestWatermark, config, dataDir, db, execFileAsync, fs, getContainerBindMounts, getDatabaseContainerId, getDockerContainerImageName, getUtxoTrackerVolumeName, manualHubCrossChainPurgeStatements, nodeService, path, pingExternalDatabase, purgeHubCrossChainRows, readline, recordReindex, reindexAffectedModules, resetDatabases, restartContainer, sleep, startContainer, statusChanged, stopContainer
let RESETTABLE_SERVICES

function configure(dependencies) {
    ({ confirmDestructiveReset, failureReason, isNoSuchContainerError, isNoSuchVolumeError, resolveNodeDataPath, restartResetModules, restartStoppedModules, Coin, CoinTickerSymbol, EXTERNAL_DB, HUB_MODULE_NAME, Network, NODE_MODULE_NAME, XChainService, clearHubPriceIngestWatermark, config, dataDir, db, execFileAsync, fs, getContainerBindMounts, getDatabaseContainerId, getDockerContainerImageName, getUtxoTrackerVolumeName, manualHubCrossChainPurgeStatements, nodeService, path, pingExternalDatabase, purgeHubCrossChainRows, readline, recordReindex, reindexAffectedModules, resetDatabases, restartContainer, sleep, startContainer, statusChanged, stopContainer } = dependencies)
    RESETTABLE_SERVICES = [
        'all',
        NODE_MODULE_NAME,
        XChainService.XCHAIN_UTXO_TRACKER,
        XChainService.XCHAIN_DECODER,
        XChainService.XCHAIN_INDEXER
    ]
}

// The service names `reset` can act on. `reset` is the only destructive CLI path and the only one that bypasses resolveArgs/filterCommandParameters, so it must validate its own raw args: without this
// an unrecognised service (a typo, or a non-resettable module like xchain-encoder) leaves every reset flag false, so `targets` is empty, no branch fires, and resetModules returns true - the CLI exits
// 0 reporting success after resetting nothing. Fail loud instead, matching resolveArgs/rollback and the "fail fast BEFORE any destructive wipe" convention this file already follows.

async function resetModules(service, coin, network, force = false, withIndexer = false) {
    if (!RESETTABLE_SERVICES.includes(service)) {
        throw new Error("reset: unknown service '" + service + "'; expected one of "
            + RESETTABLE_SERVICES.join(', '))
    }
    if (!Object.values(Coin).includes(coin)) {
        throw new Error("reset: unknown coin '" + coin + "'; expected one of "
            + Object.values(Coin).join(', '))
    }
    if (!Object.values(Network).includes(network)) {
        throw new Error("reset: unknown network '" + network + "'; expected one of "
            + Object.values(Network).join(', '))
    }
    const resetAll         = service === 'all'
    const resetNode        = resetAll || service === NODE_MODULE_NAME
    const resetUtxoTracker = resetAll || service === XChainService.XCHAIN_UTXO_TRACKER
    const resetDecoder     = resetAll || service === XChainService.XCHAIN_DECODER
    const resetIndexer     = resetAll || service === XChainService.XCHAIN_INDEXER || (withIndexer && resetDecoder)
    return validateDecoderPair({ service, coin, network, force, resetAll, resetNode, resetUtxoTracker, resetDecoder, resetIndexer })
}

async function validateDecoderPair(context) {
    const { coin, network, resetDecoder, resetIndexer } = context
    // The indexer's rollback cursor IS a decoder `events` id, and the decoder never deletes those rows, so wiping the decoder alone restarts the ids under a cursor that now points past them: the
    // indexer fails RE-1 and stops committing. The pair only has a coherent state when both move together. Asymmetric on purpose - resetting the indexer alone re-derives it from an intact decoder,
    // which is an ordinary reindex and stays allowed.
    if (resetDecoder && !resetIndexer) {
        let indexerInstalled = null
        try {
            // Strict read: getModuleContainer answers null on a SQL error and on an unopened pool as well as on a genuine miss, so a registry blip read as "no indexer installed" and waved through the
            // one wipe this guard exists to stop (uuid:7cbafa08). A lookup that FAILS is not evidence of absence. Only an empty result set still means "not installed", which stays allowed.
            indexerInstalled = await db.getModuleContainerStrict(XChainService.XCHAIN_INDEXER, coin, network)
        } catch (err) {
            // abortBeforeAnyWipe is declared further down this function and nothing has been stopped yet, so the plain refusal is the correct shape here.
            console.log(`Aborted: cannot read the ${XChainService.XCHAIN_INDEXER} registry row `
                + `(${failureReason(err)}), so it is not known whether resetting `
                + `${XChainService.XCHAIN_DECODER} alone would strand it. No data was touched.`)
            return false
        }
        if (indexerInstalled) {
            console.log(`Aborted: resetting ${XChainService.XCHAIN_DECODER} alone would leave `
                + `${XChainService.XCHAIN_INDEXER} incoherent. No data was touched.`)
            console.log("  The indexer tracks reorgs by a decoder event id. Wiping the decoder restarts")
            console.log("  those ids, so the indexer would abort with a reorg-cursor error (RE-1) and stop")
            console.log("  committing blocks until both are rebuilt together.")
            console.log(`  Reset the pair:   xchain-node reset ${XChainService.XCHAIN_DECODER} ${coin} ${network} --with-indexer`)
            console.log(`  Or the whole stack (also re-syncs the chain):   xchain-node reset all ${coin} ${network}`)
            return false
        }
    }
    return resolveResetPaths(context)
}

async function resolveResetPaths(context) {
    const { coin, network, resetNode } = context
    // Relocated blocks/txindex host paths (XCHAIN_NODE_BLOCKS_DIR mode): these live OUTSIDE the in-datadir path the node wipe clears, so they must be wiped explicitly and named in the confirmation,
    // else a reset restarts the daemon over a stale blocks dir + stale txindex (uuid:90630038). Env-first with config/node.local fallback: a reset from a profile-less shell must still see the
    // relocated stores, or it restarts the daemon over stale out-of-datadir chain data.
    const { resolveBlocksDir } = nodeService
    const blocksDir     = await resolveBlocksDir()
    const blocksHostPath  = blocksDir ? `${blocksDir}/${coin}/${network}` : null
    const txindexHostPath = blocksDir ? `${blocksDir}/${coin}/${network}-txindex` : null

    // Resolve the node datadir BEFORE anything is stopped or confirmed, and refuse the whole reset by name when it cannot be resolved. The old code re-derived the path from XCHAIN_NODE_DATA_DIR at
    // the wipe site and skipped the wipe whenever that path was absent, so a reset run from a profile-less shell wiped the decoder/indexer DBs, left the chain in place, and exited 0; the missing
    // "Clearing node data" line was the only tell. "Not installed" stays a legitimate skip, and is stated out loud.
    let nodeDataPath = null
    if (resetNode) {
        let nodeInstalled    = null
        let registryReadable = true
        try {
            nodeInstalled = await db.getModuleContainer(NODE_MODULE_NAME, coin, network)
        } catch { registryReadable = false }

        const resolved = await resolveNodeDataPath(coin, network)
        if (resolved.path) {
            nodeDataPath = resolved.path
            if (path.resolve(nodeDataPath) !== path.resolve(resolved.configuredPath)) {
                console.log(`Node datadir resolved from ${resolved.resolvedFrom}: ${nodeDataPath}`)
                console.log(`  (XCHAIN_NODE_DATA_DIR in this shell would have pointed at ${resolved.configuredPath})`)
            }
        } else if (registryReadable && !nodeInstalled) {
            console.log(`No ${NODE_MODULE_NAME} container is installed for ${coin} ${network}; there is no node data to clear.`)
        } else {
            const envState = config.XCHAIN_NODE_DATA_DIR && config.XCHAIN_NODE_DATA_DIR.trim() !== ''
                ? `set to ${config.XCHAIN_NODE_DATA_DIR}`
                : 'UNSET in this shell (non-interactive shells do not source the profile)'
            console.log(`Aborted: cannot resolve the ${coin} ${network} node datadir. No data was touched.`)
            console.log(`  Container ${resolved.containerName} reported no /root/.${coin} bind mount `
                + '(it is absent, or docker is unreachable from here).')
            console.log(`  The configured path ${resolved.configuredPath} does not exist either.`)
            console.log(`  XCHAIN_NODE_DATA_DIR is ${envState}.`)
            console.log('  Set XCHAIN_NODE_DATA_DIR to this stack\'s data root (or make docker reachable so the')
            console.log('  node container can be inspected) and re-run. Refusing rather than resetting the')
            console.log('  databases around a chain that would stay untouched.')
            return false
        }
    }

    return confirmReset({ ...context, blocksDir, blocksHostPath, txindexHostPath, nodeDataPath })
}

async function confirmReset(context) {
    const { blocksDir, blocksHostPath, coin, force, network, nodeDataPath, resetDecoder, resetIndexer, resetNode, resetUtxoTracker, txindexHostPath } = context
    if (!force) {
        const targets = []
        if (resetNode) {
            if (nodeDataPath) targets.push(`node datadir (${nodeDataPath})`)
            if (blocksDir) {
                targets.push(`relocated blocks dir (${blocksHostPath})`)
                targets.push(`relocated txindex dir (${txindexHostPath})`)
            }
        }
        if (resetUtxoTracker) targets.push(`xchain-utxo-tracker Docker volume (${getUtxoTrackerVolumeName(coin, network)})`)
        if (resetDecoder)     targets.push('xchain-decoder database')
        if (resetIndexer) {
            targets.push('xchain-indexer database')
            // Named in the confirmation because it is a change to the HUB's state, not this chain's: the operator should see that the reset reaches across.
            targets.push('hub price ingest fence row for this chain (price_ingest_watermarks)')
        }
        // A regtest chain reset is a RE-GENESIS (the datadir goes, the chain comes back from block 0), which invalidates every hub row anchored on the dead chain's blocks. Named for the same reason
        // the price fence is: it is a change to the HUB's state, not just this chain's, and the operator should see that the reset reaches across.
        if (resetNode && network === Network.REGTEST) {
            targets.push('hub cross-chain relic rows for this network '
                + '(cross_chain_matches, cross_chain_calls, capability_snapshots)')
        }
        const confirmed = await confirmDestructiveReset(coin, network, targets)
        if (!confirmed) {
            console.log('Aborted: reset was not confirmed. No data was touched.')
            return false
        }
    }
    return checkResetDatabase(context)
}

async function checkResetDatabase(context) {
    const { coin, network, resetAll, resetDecoder, resetIndexer, resetNode, resetUtxoTracker } = context
    // Fail fast BEFORE any destructive wipe: a DB reset needs a working MariaDB, and resetDatabases is not reached until AFTER the stop loop and every wipe below, so discovering the problem there
    // half-destroys the stack. In docker mode the failure is `docker exec null` with the container gone (uuid:6f6584dc); in EXTERNAL_DB mode it is an unreachable host, or a getExternalDbConfig throw
    // on a partial env, and NOTHING probed for it (uuid:41887889). Both modes are probed here. It sits ahead of the stop loop, not after it: this abort returns before the restart pass, so probing
    // later left every already-stopped service DOWN while still reporting that no data was touched (uuid:bb190060).
    const dbResetNeeded = resetDecoder || resetIndexer
    if (dbResetNeeded) {
        if (EXTERNAL_DB) {
            const probe = await pingExternalDatabase()
            if (!probe.ok) {
                console.log(`Aborted: cannot reach the external MariaDB at ${probe.host}:${probe.port}`
                    + ` (${probe.error}). No data was touched.`)
                return false
            }
        } else {
            const dbContainerId = await getDatabaseContainerId()
            if (!dbContainerId) {
                console.log('Aborted: MariaDB container not found; install the database first. No data was touched.')
                return false
            }
        }
    }

    const modulesToStop = []
    if (resetNode)        modulesToStop.push(NODE_MODULE_NAME)
    if (resetUtxoTracker) modulesToStop.push(XChainService.XCHAIN_UTXO_TRACKER)
    if (resetDecoder)     modulesToStop.push(XChainService.XCHAIN_DECODER)
    if (resetIndexer)     modulesToStop.push(XChainService.XCHAIN_INDEXER)
    if (resetAll)         modulesToStop.push(XChainService.XCHAIN_REGTEST_MINER)
    return stopResetModules({ ...context, modulesToStop })
}

async function stopResetModules(context) {
    const { coin, network, modulesToStop } = context
    console.log(`Stopping ${coin} ${network} services...`)
    // Abort before any wipe when a target will not stop, and put back whatever was already stopped. The bare catch this replaced swallowed EVERY stopContainer rejection as "not installed", so a
    // daemon that failed to stop kept reading and writing the store while the wipes below deleted it (uuid:9c88cfe6). Only a "no such container" miss is still a legitimate skip; the registry miss is
    // already handled by the null check.
    const stoppedModules = []
    // Refuse the whole reset, put back whatever this run stopped, and report it. Only reachable while nothing has been wiped yet, which is why it may still promise that no data was touched.
    const abortBeforeAnyWipe = async (reason) => {
        const restartFailures = await restartStoppedModules(stoppedModules, coin, network)
        console.log(`Aborted: ${reason}. No data was touched.`)
        if (stoppedModules.length > 0) {
            console.log(`  Restarted ${stoppedModules.length - restartFailures.length} of `
                + `${stoppedModules.length} already-stopped service(s).`)
        }
        if (restartFailures.length > 0) {
            console.log(`  STILL DOWN, start by hand: ${restartFailures.join(', ')}`)
        }
        return false
    }
    for (const module of modulesToStop) {
        let containerId = null
        try {
            containerId = await db.getModuleContainerStrict(module, coin, network)
        } catch (err) {
            // A registry read that FAILED is not evidence the module is absent. The swallowing read this replaced answered null on any SQL error, so a blip after the reachability precheck made a live
            // indexer look uninstalled: the loop skipped stopping it and the wipes below, resetDatabases included, ran underneath it (uuid:846cc40d).
            return await abortBeforeAnyWipe(
                `cannot read the ${module} registry row (${failureReason(err)}), so it is not known `
                + 'whether that service is running')
        }
        // A SUCCESSFUL read with no row is still a legitimate "not installed" skip; without this check stopContainer(null) fails and ABORTS the reset (uuid:fd7cc224 sibling site).
        if (!containerId) continue
        try {
            await stopContainer(containerId)
            stoppedModules.push(module)
        } catch (err) {
            if (isNoSuchContainerError(err)) continue
            return await abortBeforeAnyWipe(`${module} failed to stop (${failureReason(err)})`)
        }
    }
    return classifyResetVolume({ ...context, stoppedModules, abortBeforeAnyWipe })
}

async function classifyResetVolume(context) {
    const { abortBeforeAnyWipe, coin, network, resetUtxoTracker } = context
    // Classify the tracker volume's presence BEFORE the first wipe. The wipe below swallowed every failure as "the volume may not exist", so a permission error, an unreachable daemon or a failed
    // alpine pull left stale tracker data behind while the decoder/indexer databases were dropped and the run reported success (uuid:e24c98d4). Only docker SAYING "no such volume" is absence;
    // anything else refuses here, while the stack is whole.
    let utxoVolumeName    = null
    let utxoVolumePresent = false
    if (resetUtxoTracker) {
        // Name the volume through the shared helper so it carries NODE_PREFIX (uuid:7523dd94): an unprefixed name resolves to the DEFAULT_NODE_PREFIX stack's volume and wipes that one instead of the
        // intended target.
        utxoVolumeName = getUtxoTrackerVolumeName(coin, network)
        try {
            await execFileAsync('docker', ['volume', 'inspect', utxoVolumeName])
            utxoVolumePresent = true
        } catch (err) {
            if (!isNoSuchVolumeError(err)) {
                return await abortBeforeAnyWipe(
                    `cannot determine whether the Docker volume ${utxoVolumeName} exists `
                    + `(${failureReason(err)})`)
            }
            console.log(`No Docker volume ${utxoVolumeName} to clear.`)
        }
    }
    return wipeResetStores({ ...context, utxoVolumeName, utxoVolumePresent })
}

async function wipeResetStores(context) {
    const { abortBeforeAnyWipe, blocksHostPath, coin, network, nodeDataPath, resetDecoder, resetIndexer, resetNode, resetUtxoTracker, txindexHostPath, utxoVolumeName, utxoVolumePresent } = context
    // Tracks whether anything irreversible has happened yet, so a later abort reports the stack's real state instead of promising an untouched one.
    let nodeDataWiped = false

    if (resetNode) {
        // No existsSync guard here any more: the path was resolved (and the reset refused, or the "not installed" skip announced) up top, so an unresolvable datadir can no longer read as a silent
        // no-op.
        if (nodeDataPath) {
            console.log(`Clearing node data at ${nodeDataPath}...`)
            await execFileAsync('docker', ['run', '--rm', '-v', `${nodeDataPath}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])
            nodeDataWiped = true
        }
        // Relocated blocks/txindex (XCHAIN_NODE_BLOCKS_DIR) live outside the datadir, so wipe them here too or the daemon restarts over stale chain data (uuid:90630038).
        for (const relocated of [blocksHostPath, txindexHostPath]) {
            if (relocated && fs.existsSync(relocated)) {
                console.log(`Clearing relocated node data at ${relocated}...`)
                await execFileAsync('docker', ['run', '--rm', '-v', `${relocated}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])
                nodeDataWiped = true
            }
        }
    }

    if (resetUtxoTracker && utxoVolumePresent) {
        try {
            console.log(`Clearing Docker volume ${utxoVolumeName}...`)
            await execFileAsync('docker', ['run', '--rm', '-v', `${utxoVolumeName}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])
        } catch (err) {
            // The volume exists and the wipe failed, so the tracker still holds its old store. Falling through would drop the decoder/indexer databases around retained tracker data and still return
            // true.
            const reason = `clearing the Docker volume ${utxoVolumeName} failed (${failureReason(err)})`
            if (nodeDataWiped) {
                // Node data is already gone, so this reset is half done and cannot claim otherwise. Starting the services again would run a resynced chain under decoder and indexer stores that still
                // describe the old one, so they stay down until the operator re-runs the same reset.
                console.log(`Aborted: ${reason}.`)
                console.log('  The node data for this stack WAS already cleared; the decoder/indexer')
                console.log('  databases were NOT touched, and the stopped services are left down.')
                console.log('  Fix the volume problem and re-run the same reset command.')
                return false
            }
            return await abortBeforeAnyWipe(reason)
        }
    }

    const dbModulesToReset = [
        ...(resetDecoder ? [XChainService.XCHAIN_DECODER] : []),
        ...(resetIndexer ? [XChainService.XCHAIN_INDEXER] : []),
    ]
    if (dbModulesToReset.length > 0) {
        await resetDatabases(coin, network, dbModulesToReset)
    }

    return cleanResetMetadata(context)
}

async function cleanResetMetadata(context) {
    const { coin, network, resetIndexer, resetNode } = context
    // A wiped indexer DB restarts push_generations at 0, which the hub's price ingest fence reads as a stale replay and DROPS, killing this chain's price rail (and the native-fee / XCHAIN-USD path)
    // with no error. Clear the fence row here, while the indexer is still stopped, so the first push after the restart below lands. Never fatal: the wipe already happened, so a failure must not abort
    // the restart pass and leave the stack down. It is reported loudly instead, with the statement to run by hand.
    if (resetIndexer) {
        try {
            await clearHubPriceIngestWatermark(coin, network)
        } catch (err) {
            console.warn('WARNING: clearing the hub price ingest fence failed: ' + (err && err.message ? err.message : err))
            console.warn("  Run on the hub DB before the indexer catches up:")
            // Network-scoped, matching the statement DatabaseService prints on its own failure branches. The '' bucket is the legacy/unset scope that pre-migration rows sit in.
            console.warn("    DELETE " + "FROM price_ingest_watermarks WHERE source_chain = '"
                + (CoinTickerSymbol[coin] || coin) + "' AND network IN ('"
                + String(network || '').trim().toLowerCase() + "', '');")
            console.warn("  Keep the network clause: it is what leaves every OTHER network's fence for this chain in place.")
        }
    }

    // A re-genesised regtest chain leaves the hub's cross-chain rows behind: they are keyed by `network` and a BTC-anchored snapshot_block, and nothing in them names the chain INSTANCE, so the mirror
    // bootstrap hands every fresh indexer the dead chain's finalized matches and it refuses them at every block for as long as it runs. Purge them here, while the indexer is stopped, so the rebuilt
    // mirror never sees them. Regtest only: no other network has a re-genesis path, and there these rows are live federation history. Never fatal, like the price fence above: the wipe already
    // happened, so a failure must not abort the restart pass and leave the stack down. It is reported loudly instead, with the statements to run by hand.
    if (resetNode && network === Network.REGTEST) {
        try {
            await purgeHubCrossChainRows(coin, network)
        } catch (err) {
            console.warn('WARNING: purging the hub cross-chain relic rows failed: '
                + ((err && err.message) ? err.message : err))
            console.warn('  A fresh indexer will mirror the dead chain\'s matches back in. Run on the hub DB:')
            for (const statement of manualHubCrossChainPurgeStatements(CoinTickerSymbol[coin] || coin)) {
                console.warn('    ' + statement)
            }
            console.warn(`  Then restart the hub: xchain-node restart ${HUB_MODULE_NAME}`)
        }
    }

    return recordResetReindex(context)
}

function recordResetReindex(context) {
    const { coin, network, resetDecoder, resetIndexer, resetNode, resetUtxoTracker, service } = context
    // A reset is a REINDEX: from here the wiped stores rebuild on a new lineage, and every bootstrap archive already published for these combos describes the old one. Without a marker nothing forces
    // a republish, so the stale-lineage archive stays newest until the next scheduled run (up to a week for a tracker, which is opt-in besides) and no age check catches it, because the file is hours
    // old and simply wrong. Mark the combos DUE so the publisher pulls them into its next plan regardless of schedule or tracker opt-in.
    //
    // Best-effort by design: the wipes already happened, so a bookkeeping failure must never abort the restart pass and leave the stack down. It is reported loudly instead, with the command to
    // publish by hand.
    const reindexedModules = reindexAffectedModules({
        node: resetNode, utxoTracker: resetUtxoTracker, decoder: resetDecoder, indexer: resetIndexer
    })
    if (reindexedModules.length > 0) {
        try {
            const marked = recordReindex(reindexedModules, coin, network, { reason: `reset ${service}` })
            if (marked.length > 0) {
                console.log(`Marked ${marked.length} bootstrap combo(s) for republish after this reindex: ${marked.join(', ')}`)
            } else {
                throw new Error('the republish ledger could not be written')
            }
        } catch (err) {
            console.warn('WARNING: could not record this reindex in the bootstrap republish ledger: '
                + ((err && err.message) ? err.message : err))
            console.warn('  The published archives for these combos are now from the PRE-reset lineage and')
            console.warn('  nothing will force a republish. Republish by hand once the stack has caught up:')
            for (const module of reindexedModules) {
                console.warn(`    xchain-node bootstrap create ${module} ${coin} ${network}`)
            }
        }
    }
    return restartResetModules(context)
}


module.exports = { configure, resetModules }
