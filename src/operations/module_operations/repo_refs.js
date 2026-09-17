'use strict'

let NODE_MODULE_NAME, db, fs, getContainerBindMounts, getDockerContainerImageName, readline, startContainer, DEFAULT_MODULE_BRANCH, XChainService, dataDir, installModule, installTargetService, path, releaseManifestService, removeContainer, saveContainerLogs, waitContainer

function configure(dependencies) {
    ({ NODE_MODULE_NAME, db, fs, getContainerBindMounts, getDockerContainerImageName, readline, startContainer, DEFAULT_MODULE_BRANCH, XChainService, dataDir, installModule, installTargetService, path, releaseManifestService, removeContainer, saveContainerLogs, waitContainer } = dependencies)
}

// Resolve the operator's single ref slot into an install target and publish it
// for the duration of the run, so every module clone and every bundled-library
// staging inside it resolves against ONE decision (release-management spec
// section 11). Cleared in a finally, or a later branch install in the same
// process would inherit a stale pin.
async function withInstallTarget(ref, run, { fallbackToBranch = true } = {}) {
    const {
        resolveInstallTarget, setActiveTarget, clearActiveTarget
    } = releaseManifestService
    const { recordInstallTarget } = installTargetService

    const target = await resolveInstallTarget(ref, { defaultBranch: DEFAULT_MODULE_BRANCH, fallbackToBranch })

    if (target.kind === 'release') {
        console.log(`Installing XChain ${target.tag} (${target.resolvedFrom}); every component is manifest-pinned.`)
    } else {
        console.log(`Installing from branch '${target.ref}' (UNRELEASED: tracking install, no version pinning).`)
    }

    // What this node is on, for the next no-ref `update` to converge on.
    recordInstallTarget(target)
    setActiveTarget(target)
    try {
        return await run(target)
    } finally {
        clearActiveTarget()
    }
}
// `ref` is the ref to clone the e2e-test suite at, normally the same one the
// stack under test was installed at. Null keeps the default-branch behaviour
// every caller had before the option existed.
async function runE2ETest(coin, network, testName = null, grep = null, script = null, ref = null) {
    let dockerCmdArgs = null
    if (script) {
        // Run an arbitrary e2e npm script (e.g. test:security, test:perf:budget) so CI
        // can drive the stack-dependent suites beyond the default action suite. Takes
        // precedence over testName; the e2e-test image carries these scripts.
        dockerCmdArgs = ['npm', 'run', script]
    } else if (testName) {
        dockerCmdArgs = ['npx', 'mocha', '--timeout', '0', '--exit',
            '--require', './test/initialCheck.test.js',
            `test/actions/${testName}.test.js`]
        if (grep) dockerCmdArgs.push('--grep', grep)
    }
    const containerId = await installModule(XChainService.XCHAIN_E2E_TEST, coin, network, true, null, true, ref, dockerCmdArgs)

    console.log("Running e2e tests, please wait...")
    const exitCode = await waitContainer(containerId)

    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const logFile = path.join(dataDir, 'e2e-logs', `${coin}-${network}-${timestamp}.log`)

    await saveContainerLogs(containerId, logFile)
    await removeContainer(containerId)

    return { logFile, exitCode }
}

// Prompts the operator to type "yes" before a destructive reset proceeds. Reused instead of duplicated so every call site aborts the exact same way on a non-affirmative answer. Not called at all when
// the caller passes force=true (CI/scripted resets).
async function confirmDestructiveReset(coin, network, targets) {
    if (!process.stdin.isTTY) {
        throw new Error(
            'reset: refusing to run a destructive reset on a non-interactive terminal without --yes. ' +
            'Re-run with --yes to confirm.'
        )
    }
    console.warn(`\nWARNING: this will IRREVERSIBLY destroy ${coin} ${network} data.`)
    console.warn(`  Affected stores: ${targets.join(', ')}`)
    console.warn('  This forces a full resync afterward. There is no undo.\n')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise((resolve) => {
        rl.question('Type "yes" to confirm: ', resolve)
    })
    rl.close()
    return answer.trim().toLowerCase() === 'yes'
}

// True when a docker error means the container is already gone. Matched the same way DockerService.removeContainer matches it; execFile puts docker's stderr into the error message, and stopContainer
// can also reject a plain string, which is a real failure and must not be read as a miss here.
function isNoSuchContainerError(err) {
    if (!err || typeof err === 'string') return false
    return /no such container/i.test(String(err.message || err.stderr || ''))
}

// True when a docker error means the named volume is already gone. Same rule isNoSuchContainerError uses, and the one DockerService.probeContainerPresenceByName states: docker SAYING "no such volume"
// is the only thing that means absent; every other failure is unknown and must be treated as possibly-present.
function isNoSuchVolumeError(err) {
    if (!err || typeof err === 'string') return false
    return /no such volume/i.test(String(err.message || err.stderr || ''))
}

// The operator-facing reason for a rejected docker or registry call. Handles the bare-string rejection stopContainer can produce as well as an Error.
function failureReason(err) {
    return (err && err.message) || String(err)
}

// Put back the services an aborted reset already stopped, so the abort leaves the stack as it found it rather than half torn down. Returns the modules that could not be restarted, for the operator
// message.
//
// Reads the registry strictly: getModuleContainer answers null on a SQL error as well as on a miss, so a rollback run during the very registry outage that caused the abort restarted nothing and still
// reported zero failures (uuid:846cc40d). A lookup that fails now lands in `failed` and is named in the STILL DOWN line.
async function restartStoppedModules(modules, coin, network) {
    const failed = []
    for (const module of modules) {
        try {
            const containerId = await db.getModuleContainerStrict(module, coin, network)
            if (!containerId) continue
            await startContainer(containerId)
        } catch {
            failed.push(module)
        }
    }
    return failed
}

/**
 * Resolve the HOST directory that holds this chain's node datadir, asking the
 * node container itself first.
 *
 * `dataDir` is env-derived (XCHAIN_NODE_DATA_DIR, else the in-repo data/), so a
 * shell that never sourced the operator's profile resolves a path the stack has
 * never used. The wipe was guarded on fs.existsSync of that path, so the guard
 * went silently false and `reset all` reported success with the chain untouched.
 * The container name is already resolved deterministically from the prefix and
 * coin/network, so use that same key to read the datadir off the container's own
 * bind mounts: whatever the daemon actually writes to is what a reset must wipe.
 *
 * Falls back to the env-derived path only when it really is on disk. Returns
 * path=null when neither answer exists, and the caller fails closed on that
 * rather than skipping the wipe.
 *
 * @returns {Promise<{path: (string|null), resolvedFrom: (string|null), configuredPath: string, containerName: string}>}
 */
async function resolveNodeDataPath(coin, network) {
    const containerName  = getDockerContainerImageName(NODE_MODULE_NAME, coin, network)
    const configuredPath = path.join(dataDir, NODE_MODULE_NAME, coin, network)

    let mounts = []
    try {
        mounts = await getContainerBindMounts(containerName)
    } catch { /* no container, or docker unreachable: fall through to the configured path */ }
    const dataMount = (Array.isArray(mounts) ? mounts : [])
        .find(m => m && m.destination === `/root/.${coin}` && m.source)
    if (dataMount) {
        return {
            path: dataMount.source,
            resolvedFrom: `the /root/.${coin} bind mount of container ${containerName}`,
            configuredPath,
            containerName
        }
    }

    if (fs.existsSync(configuredPath)) {
        return { path: configuredPath, resolvedFrom: 'the configured data dir', configuredPath, containerName }
    }

    return { path: null, resolvedFrom: null, configuredPath, containerName }
}

module.exports = { configure, withInstallTarget, runE2ETest, confirmDestructiveReset, isNoSuchContainerError, isNoSuchVolumeError, failureReason, restartStoppedModules, resolveNodeDataPath }
