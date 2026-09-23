'use strict'

let XChainService, failureReason, sleep, db, execContainer, getDockerContainerImageName, logContainer, restartContainer, shellContainer, startContainer, startDockerMonitor, statusChanged, stopContainerByName, stopModuleContainer, getContainerStopSettings

function configure(dependencies) {
    ({ XChainService, failureReason, sleep, db, execContainer, getDockerContainerImageName, logContainer, restartContainer, shellContainer, startContainer, startDockerMonitor, statusChanged, stopContainerByName, stopModuleContainer, getContainerStopSettings } = dependencies)
}

async function logModules(servicesList, follow = true) {
    const moduleContainerIds = []
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                moduleContainerIds.push({
                    name: getDockerContainerImageName(nextModule, nextCoin, nextNetwork),
                    id: containerId
                })
            }
        }
    }

    if (moduleContainerIds.length > 0) {
        if (follow) {
            // A single interleaved TTY stream only makes sense for one
            // container; warn instead of silently dropping the rest so the
            // operator knows N-1 services are omitted from `tail all`.
            if (moduleContainerIds.length > 1) {
                const omitted = moduleContainerIds.slice(1).map(c => c["name"]).join(", ")
                console.log("Following only " + moduleContainerIds[0]["name"] + "; omitted: " + omitted)
            }
            const moduleName = moduleContainerIds[0]["name"]
            console.log("")
            console.log("")
            console.log("####" + moduleName + " LOGS####")
            console.log("")
            await logContainer(moduleContainerIds[0]["id"], follow)
        } else {
            // Non-follow dumps can safely iterate every selected service in
            // sequence (no shared TTY to interleave).
            for (const container of moduleContainerIds) {
                console.log("")
                console.log("")
                console.log("####" + container["name"] + " LOGS####")
                console.log("")
                await logContainer(container["id"], follow)
            }
        }
    } else {
        console.log("No service was selected")
    }
    return true
}

async function monitorModules(servicesList, follow = true) {
    const moduleContainerIds = []
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                moduleContainerIds.push({
                    name: getDockerContainerImageName(nextModule, nextCoin, nextNetwork),
                    id: containerId
                })
            }
        }
    }
    await startDockerMonitor(moduleContainerIds, follow)
    return true
}

async function restartModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    await restartContainer(containerId)
                    await statusChanged()
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function stopModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    // With the service's budget, not docker's ten seconds: a bare
                    // `docker stop` on a container created before the budget was
                    // stamped on it is a coin flip for a service mid-block.
                    await stopModuleContainer(stopContainerByName, nextModule, nextCoin, nextNetwork, containerId,
                        undefined, getContainerStopSettings)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function startModules(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    await startContainer(containerId)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

// Audited clear of a decoder's durable REORG_HALT marker, run inside the decoder
// container so it uses the service's own DB credentials and code
// (xchain-decoder/src/clear_reorg_halt.js checks the database is intact, then
// records the clear as an events row with the reason). One decoder per
// coin/network; `servicesList` is the filtered map the CLI builds. Returns true
// only when every targeted decoder answered exit 0.
async function clearDecoderReorgHalt(servicesList, { reason, force = false, dryRun = false } = {}) {
    // A dry run writes nothing, so it runs without a reason; a real clear records one.
    const reasonText = typeof reason === 'string' ? reason.trim() : ''
    if (!dryRun && reasonText.length < 8) {
        console.log('clear-reorg-halt: --reason must say, in at least 8 characters, why this database is known good; it is recorded with the clear.')
        return false
    }
    const args = ['node', 'src/clear_reorg_halt.js']
    if (reasonText) args.push('--reason', reasonText)
    if (force) args.push('--force')
    if (dryRun) args.push('--dry-run')
    let targeted = 0
    let ok = true
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            if (!servicesList[nextCoin][nextNetwork].includes(XChainService.XCHAIN_DECODER)) continue
            const containerId = await db.getModuleContainer(XChainService.XCHAIN_DECODER, nextCoin, nextNetwork)
            if (!containerId) {
                console.log('clear-reorg-halt: no xchain-decoder container is installed for ' + nextCoin + ' ' + nextNetwork)
                ok = false
                continue
            }
            targeted++
            try {
                const out = await execContainer(containerId, args)
                if (out) console.log(out)
            } catch (err) {
                // The script prints its refusal on stderr and exits non-zero; docker
                // exec surfaces that as an error whose stdout/stderr carry the text.
                const text = [err && err.stdout, err && err.stderr].filter(Boolean).join('\n').trim()
                console.log(text || ('clear-reorg-halt: failed for ' + nextCoin + ' ' + nextNetwork + ': ' + (err && err.message)))
                ok = false
            }
        }
    }
    if (targeted === 0 && ok) {
        console.log('clear-reorg-halt: no xchain-decoder matched the given chain and network')
        return false
    }
    return ok
}

async function execModules(servicesList, command) {
    const commandArgs = command.split(/\s+/)
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    const execStdOut = await execContainer(containerId, commandArgs)
                    console.log(execStdOut)
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function shellModule(servicesList) {
    for (const nextCoin in servicesList) {
        for (const nextNetwork in servicesList[nextCoin]) {
            for (const nextModule of servicesList[nextCoin][nextNetwork]) {
                const containerId = await db.getModuleContainer(nextModule, nextCoin, nextNetwork)
                if (!containerId) continue
                try {
                    await shellContainer(containerId)
                    return true
                } catch (err) {
                    console.log(err)
                }
            }
        }
    }
    return true
}

async function restartResetModules(context) {
    const { coin, modulesToStop, network } = context
    console.log(`Restarting ${coin} ${network} services...`)
    // Track restart failures instead of swallowing them: a silent skip here left a wiped stack DOWN (node never restarted, every dependent service crash-looped) while `reset` still reported success.
    // "Not installed" (registry miss) stays a legitimate skip; a failed docker start gets one retry, then is reported loudly at the end.
    const startFailures = []
    for (const module of modulesToStop) {
        let containerId = null
        try {
            containerId = await db.getModuleContainerStrict(module, coin, network)
        } catch (err) {
            // Strict, like the stop loop: the swallowing read answered null on a SQL error too, so a registry blip here left a just-wiped service DOWN and still reported a clean reset
            // (uuid:846cc40d). Nothing can be undone at this point, so report it with the other start failures rather than aborting.
            startFailures.push({ module, error: `registry lookup failed (${failureReason(err)})` })
            continue
        }
        // A SUCCESSFUL read with no row is "not installed" and stays a skip. Without this check startContainer(null) fails on every branch, and every `reset all` on mainnet/testnet (where the
        // regtest-only miner has no registry row) reports a false failure after the reset actually succeeded (uuid:fd7cc224).
        if (!containerId) continue /* not installed, skip */
        try {
            await startContainer(containerId)
        } catch (firstErr) {
            console.warn(`Failed to start ${module} (${firstErr && firstErr.message}); retrying in 3s...`)
            await sleep(3000)
            try {
                await startContainer(containerId)
            } catch (retryErr) {
                startFailures.push({ module, error: (retryErr && retryErr.message) || String(retryErr) })
            }
        }
    }
    return bounceResetModules({ ...context, startFailures })
}

async function bounceResetModules(context) {
    const { coin, modulesToStop, network, startFailures } = context
    // Workaround for a known race: the decoder + indexer's initial pool connections sometimes lose the connection mid-startup right after a DROP DATABASE / CREATE DATABASE cycle (their inner
    // retry-on-connect helps but doesn't fully cover the case where Node throws before the retry loop is reached). A simple "settle then bounce" of decoder + indexer after the first start pass is
    // empirically deterministic and costs ~5s on the happy path.
    const bounceCandidates = [XChainService.XCHAIN_DECODER, XChainService.XCHAIN_INDEXER]
        .filter((m) => modulesToStop.includes(m))
    if (bounceCandidates.length > 0) {
        await sleep(5000)
        for (const module of bounceCandidates) {
            try {
                const containerId = await db.getModuleContainer(module, coin, network)
                // Latent today only because the catch below hides a null-arg failure; guard explicitly so a future narrower catch stays correct (uuid:fd7cc224 sibling site).
                if (!containerId) continue
                // restartContainer = docker stop + docker start; sufficient to re-enter Node's bootstrap with the freshly-created DB ready.
                await restartContainer(containerId)
            } catch { /* not installed, skip */ }
        }
    }

    await statusChanged()

    if (startFailures.length > 0) {
        const detail = startFailures.map((f) => `${f.module}: ${f.error}`).join('; ')
        throw new Error(`reset completed but ${startFailures.length} service(s) failed to restart: ${detail}. Start them manually (docker start) or re-run reset.`)
    }
    return true
}

module.exports = { configure, logModules, monitorModules, restartModules, stopModules, startModules, clearDecoderReorgHalt, execModules, shellModule, restartResetModules }
