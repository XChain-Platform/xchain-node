'use strict'

let DB_MODULE_NAME, HUB_MODULE_NAME, NODE_MODULE_NAME, SEP, SYNC_MODULE_NAME, assertHubNotBehind, assertRequiredMigrationsApplied, db, getModuleBranch, installModule, installTargetService, releaseManifestService, stateModule, validatorService, versionService, withInstallTarget

function configure(dependencies) {
    ({ DB_MODULE_NAME, HUB_MODULE_NAME, NODE_MODULE_NAME, SEP, SYNC_MODULE_NAME, assertHubNotBehind, assertRequiredMigrationsApplied, db, getModuleBranch, installModule, installTargetService, releaseManifestService, stateModule, validatorService, versionService, withInstallTarget } = dependencies)
}

/**
 * Update the requested modules.
 *
 * The ref decides the mode, the same way it does for `install`:
 *   - a release ref (`vX.Y.Z`): pinned update to that train;
 *   - a branch name: tracking update, every module moved to that branch's tip;
 *   - no ref: whatever kind of node this is. A release node (the operator
 *     path, and the only kind a default `install` produces) moves to the
 *     LATEST published release, fully pinned; a branch node stays on its
 *     branch and takes newer commits.
 *
 * Until 2026-09 a no-ref update re-read each module's git branch. A pinned
 * checkout is detached, so that read answered `HEAD` and every release
 * node failed its own documented upgrade command. `update all` is the
 * command operators are told to run, so it has to mean "take me to the
 * newest release" on the node an operator has.
 *
 * `opts.all` marks a run that expanded from `all`: the shared services join
 * it (hub first, then sync) and a coin node whose pinned binary has not
 * changed is left running rather than rebuilt.
 */
async function updateModules(servicesList, ref = null, opts = {}) {
    const { isReleaseRef } = releaseManifestService
    const { recordInstallTarget, resolveUpdateTarget } = installTargetService

    const list = opts.all ? includeSharedServicesForUpdate(servicesList) : servicesList
    const runOpts = { skipCurrentNode: !!opts.all, quietNotInstalled: !!opts.all }

    await repairValidatorConfigBeforeHubUpdate(list)

    if (isReleaseRef(ref)) {
        return withInstallTarget(ref, async () => updateModulesOnBranch(list, null, runOpts))
    }

    if (ref) {
        // An explicitly named branch is a decision about what this node is.
        recordInstallTarget({ kind: 'branch', ref })
        return updateModulesOnBranch(list, ref, runOpts)
    }

    // No ref: the update target is remembered from the last install/update, or classified from the checkouts on a node an older CLI installed.
    const target = process.env.XCHAIN_NODE_UPDATE_TARGET
        ? { kind: 'release', ref: process.env.XCHAIN_NODE_UPDATE_TARGET, inferred: false }
        : await resolveUpdateTarget()

    if (target.kind === 'branch') {
        console.log(`This node tracks branch '${target.ref}'${target.inferred ? ' (classified from its checkouts)' : ''}; updating to its newest commits. Name a release (e.g. \`update all v0.15.2\`) to move it onto a release.`)
        recordInstallTarget({ kind: 'branch', ref: target.ref })
        return updateModulesOnBranch(list, target.ref, runOpts)
    }

    // A release node with no ref: the LATEST release (the recorded tag is where the node is, not where it is going), never a branch fallback. A lookup failure stops the run with nothing changed. The re-executed child of a CLI self-update already knows the tag its parent resolved.
    const releaseRef = process.env.XCHAIN_NODE_UPDATE_TARGET || null
    return withInstallTarget(releaseRef, async () => updateModulesOnBranch(list, null, runOpts), { fallbackToBranch: false })
}

/**
 * On a validator, an update that rebuilds the hub first re-runs the validator
 * repair path (`validator init` over an initialized node): additive only, it
 * fills in what a newer version added (a recorded network, wallets, the
 * publisher config) and never touches the signing key, the stake or an
 * existing hub API key. The hub mounts that config, so this runs BEFORE the
 * rebuild. This replaces the manual `validator init` re-run the docs asked
 * for after every upgrade.
 *
 * A repair failure is reported and does not stop the update: the hub still
 * boots on the config it has, which is what it ran on before.
 */
async function repairValidatorConfigBeforeHubUpdate(servicesList) {
    const shared = (servicesList[""] && servicesList[""][""]) || []
    if (!shared.includes(HUB_MODULE_NAME)) return false
    const { isInitialized, initValidator } = validatorService
    let initialized = false
    try { initialized = isInitialized() } catch { return false }
    if (!initialized) return false
    try {
        console.log('This node is a validator; checking its config for anything a newer version added...')
        await initValidator({})
        return true
    } catch (err) {
        console.warn(`Could not repair the validator config (${err && err.message ? err.message : err}); the hub is updated on its existing config.`)
        return false
    }
}

/**
 * `all` for an UPDATE includes the shared services, hub first.
 *
 * filterCommandParameters leaves the hub and sync out of `all` because the
 * same expansion serves install/start/stop, where "all" has never meant the
 * hub. For update it must: the hub is the first thing a release moves, and
 * the docs' promise that "the hub is updated first, automatically" was only
 * ever true of a hub that was missing (preCheck installs one) and never of
 * a hub that was running. Rebuilt with the shared bucket first so iteration
 * order IS the deploy order: hub, sync, explorer, then the coin stacks.
 */
function includeSharedServicesForUpdate(servicesList) {
    const shared  = (servicesList[""] && servicesList[""][""]) || []
    const ordered = [HUB_MODULE_NAME, SYNC_MODULE_NAME, ...shared.filter(m => m !== HUB_MODULE_NAME && m !== SYNC_MODULE_NAME)]
    const rest = {}
    for (const coin of Object.keys(servicesList)) {
        if (coin !== "") rest[coin] = servicesList[coin]
    }
    return { "": { "": ordered }, ...rest }
}

/**
 * Record ONE installModule call in an update outcome.
 *
 * installModule returns false when it declined to touch the module (its
 * early-return paths) and a container id / true when it built one. Counting
 * every call as "updated" regardless of that return value is how a run that
 * rebuilt nothing still reports a landed deploy and exits 0.
 */
function recordInstallOutcome(outcome, result, module, coin, network) {
    if (result === false) {
        console.warn(`update: ${module} (${coin} ${network}) was not rebuilt; nothing changed for it.`)
        outcome.skipped.push({ module, coin, network, reason: 'no-op' })
    } else {
        outcome.updated.push({ module, coin, network })
    }
}

/**
 * Runs the update over every requested module and REPORTS what it did.
 *
 * The report exists because the old `return true` made "updated three
 * containers" and "matched nothing at all" indistinguishable to the caller, so
 * a run that changed nothing still exited 0 and read as a landed deploy. The
 * caller (cli `update`) turns an empty `updated` list into a non-zero exit.
 *
 * @returns {Promise<{updated: Array, skipped: Array}>}
 */
async function updateModulesOnBranch(servicesList, branch = null, { skipCurrentNode = false, quietNotInstalled = false } = {}) {
    const outcome = { updated: [], skipped: [] }
    try {
        await updateModulesInto(outcome, servicesList, branch, { skipCurrentNode, quietNotInstalled })
    } finally {
        // Under `all`, a service that is not installed is the ordinary case (a validator has a hub and nothing else), so the per-service warnings collapse into one line; the outcome still lists every one of them.
        const absent = outcome.skipped.filter(s => s.reason === 'not-installed')
        if (quietNotInstalled && absent.length > 0) {
            console.log(`update: skipped ${absent.length} service${absent.length === 1 ? '' : 's'} not installed on this node.`)
        }
    }
    return outcome
}

async function updateModulesInto(outcome, servicesList, branch, { skipCurrentNode, quietNotInstalled }) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                if (nextModule === DB_MODULE_NAME) {
                    // `update` cannot rebuild the database. Its container is created by buildDatabaseModule from a pinned mariadb image, not from module source, and the existing-container branch there does nothing at all - yet the DB branch of installModule answered a hard `true`, which recordInstallOutcome counts as an updated module. So `update database` exited 0 reporting a landed upgrade over an untouched container. Refuse it here, where the update contract lives, and state the remediation uninstallModule already names.
                    console.warn(`update: ${nextModule} (${nextCoin} ${nextNetwork}) is not rebuilt by update; the database container must be removed manually and reinstalled.`)
                    outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-updatable' })
                    continue
                }
                const moduleContainerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (nextModule === NODE_MODULE_NAME) {
                    // The running node is deliberately left alone here. buildCryptoNode stops it gracefully (SIGTERM with a flush budget) and force-removes the stopped carcass right before its `docker run --name`, so the daemon keeps serving through the download and image build and its block index is flushed before it goes. An up-front `docker rm -f` at this point was SIGKILL: the killed daemon came back at its last flushed index (16 regtest blocks lost, 2026-09-03), and it also hid the old container from buildCryptoNode's bind-mount drift guard.  Recreate even when the container was missing from the registry: the old `if (!moduleContainerId) continue` made `update node` a silent no-op (exit 0, nothing created) once the node had crashed or been removed; only `install master node` could bring it back. installModule's remoteUpdate path rebuilds it from local source.  That recreate-when-missing rule is for a TARGETED `update node`. Under `all`, a coin/network with no node is simply not installed here, like any other absent service: measured on a hub-only sandbox 2026-09-08, `update all` otherwise set about installing a Bitcoin mainnet daemon and failed on its missing network.
                    if (!moduleContainerId && quietNotInstalled) {
                        outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-installed' })
                        continue
                    }
                    //  Under `update all` a coin node whose pinned binary has not changed is left running. Rebuilding it anyway restarts a daemon that was serving fine, and one such rebuild broke a relocated datadir's mounts and halted a tracker. A targeted `update node <coin> <network>` still rebuilds.
                    if (skipCurrentNode && moduleContainerId && await coinNodeIsCurrent(nextCoin, nextNetwork)) {
                        console.log(`update: ${nextModule} (${nextCoin} ${nextNetwork}) already runs the pinned daemon version; left running.`)
                        outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'current' })
                        continue
                    }
                    const built = await installModule(nextModule, nextCoin, nextNetwork, true, null)
                    recordInstallOutcome(outcome, built, nextModule, nextCoin, nextNetwork)
                } else {
                    if (!moduleContainerId) {
                        // Skipping is still right for `update all` on a partly installed stack, but skipping SILENTLY is what let a targeted `update <svc> <chain> <net>` print nothing, change nothing and exit 0. Say it, and record it so the caller can fail a run that updated nothing.
                        if (!quietNotInstalled) {
                            console.warn(`update: ${nextModule} (${nextCoin} ${nextNetwork}) has no registered container; nothing to update (install it first if you expected it here).`)
                        }
                        outcome.skipped.push({ module: nextModule, coin: nextCoin, network: nextNetwork, reason: 'not-installed' })
                        continue
                    }
                    let moduleBranch = branch
                    if (!moduleBranch) {
                        try { moduleBranch = await getModuleBranch(nextModule) } catch { /* use default */ }
                        // A pinned checkout is detached and answers `HEAD`, which is not a branch anything can clone. Under a release update the manifest pin decides the ref anyway; for a component the manifest does not carry, null means the default branch, the same thing `install` would do.
                        if (moduleBranch === 'HEAD') moduleBranch = null
                    }
                    // remoteUpdate=true so installModule actually rebuilds the container. Without it, the `if (!containerNodeVersion || remoteUpdate)` guard short-circuits for any already-installed service and `update` becomes a silent no-op.  Version-skew guard: a hub-dependent service whose new source declares `xchainRequiresHub` in its package.json is REFUSED when the installed hub is behind that version, before anything is torn down. Throws out of updateModules so the update fails closed with nothing modified for this module. Under a pinned update the guard must read the PINNED source's package.json, not the branch tip: it clones into a tmp tree to find `xchainRequiresHub`, and reading that from a different ref than the one about to be installed is how a skew guard blesses a version it never saw.
                    const { resolveComponentRef } = releaseManifestService
                    const pin = resolveComponentRef(nextModule, moduleBranch)
                    await assertHubNotBehind(nextModule, pin.ref)
                    // Migration-precondition guard: a service whose new source asserts a GATED (mode=manual) migration at startup is REFUSED when the database it will use has not applied that migration, before anything is torn down. Without it the only thing that discovers the requirement is the recreated container crash-looping - which is exactly how a routine indexer deploy took all three mainnet indexers down on 2026-08-09. Reads the same PINNED ref as the skew guard above, for the same reason: a precondition read from a different ref than the one being installed is a check that blessed a version it never saw.
                    await assertRequiredMigrationsApplied(nextModule, nextCoin, nextNetwork, pin.ref)
                    // moduleBranch MUST be threaded through: installModule re-clones the module on the remoteUpdate path (cloneGit with this `branch`), so a null branch here re-clones the default branch and clobbers the branch the operator asked for (the cause of `update <svc> <chain> <net> <branch>` silently deploying master). installModule does the clone, so no separate cloneGit is needed here.
                    const rebuilt = await installModule(nextModule, nextCoin, nextNetwork, true, moduleContainerId, false, moduleBranch)
                    recordInstallOutcome(outcome, rebuilt, nextModule, nextCoin, nextNetwork)
                }
            }
        }
    }
    return outcome
}

/**
 * Does the running coin node already carry the daemon version an update
 * would install? The container writes its version file at build time (a
 * bare `28.1`); the pinned release comes back tagged (`v28.1`). Any doubt
 * answers false, so the rebuild the operator could always get still happens.
 */
async function coinNodeIsCurrent(coin, network) {
    try {
        const { getLastStatus, getRemoteModuleVersions } = stateModule
        const { checkRemoteNodeVersion } = versionService
        const running = getLastStatus()?.[coin]?.[network]?.[NODE_MODULE_NAME]?.["container_version"]
        if (!running) return false
        if (!(NODE_MODULE_NAME + SEP + coin in getRemoteModuleVersions())) {
            await checkRemoteNodeVersion(coin)
        }
        const pinned = getRemoteModuleVersions()[NODE_MODULE_NAME + SEP + coin]?.["tag_name"]
        if (!pinned) return false
        const strip = v => String(v).trim().replace(/^v/, '')
        return strip(running) === strip(pinned)
    } catch {
        return false
    }
}

module.exports = { configure, updateModules }
