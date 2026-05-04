/*********************************************************************
 * XChain Node - Discovery Service
 *
 * Auto-discovers existing xchain-node Docker containers and registers
 * them in the modules table. Source of truth for the module → container_id
 * mapping is rebuildable from `docker ps -a` because container names
 * encode (module, coin, network) deterministically.
 *
 * Used in precheck when the modules table is empty (fresh install or
 * upgrade from LevelDB) and exposed via `xchain-node sync` for manual
 * reconciliation.
 ********************************************************************/

const { execFile } = require('child_process')

const {
    NODE_PREFIX, SEP,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME,
    XChainService, Coin, Network
} = require('../config/constants')
const { db } = require('../state')
const { stringToXChainService } = require('../utils/helpers')

const SHARED_MODULES = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME]

function logIfNotSilent(silent, message) {
    if (!silent) console.log(message)
}

async function scanAndRegisterModules({ silent = false } = {}) {
    const validCoins    = Object.values(Coin)
    const validNetworks = Object.values(Network)

    const containers = await new Promise((resolve, reject) => {
        execFile('docker', ['ps', '-a', '--no-trunc', '--format', 'json'], (error, stdout) => {
            if (error) return reject(error)
            const list = stdout.trim()
                .split('\n').filter(line => line.trim().length > 0)
                .map(line => JSON.parse(line))
            resolve(list)
        })
    })

    let added = 0

    for (const nextContainer of containers) {
        const imageName = nextContainer.Image
        if (!imageName.startsWith(NODE_PREFIX + SEP)) continue

        const rest = imageName.substr(NODE_PREFIX.length + SEP.length)

        if (SHARED_MODULES.includes(rest)) {
            const existing = await db.getModuleContainer(rest, "", "")
            if (existing == null) {
                await db.insertModuleContainer(rest, "", "", nextContainer.ID)
                logIfNotSilent(silent, "Added " + rest + " (" + nextContainer.ID + ")")
                added++
            }
            continue
        }

        const parts = rest.split(SEP)
        if (parts.length < 3) continue

        const coinStr    = parts[0]
        const networkStr = parts[1]
        const moduleStr  = parts.slice(2).join(SEP)

        if (!validCoins.includes(coinStr) || !validNetworks.includes(networkStr)) continue

        let module = stringToXChainService(moduleStr)
        if (module != null) {
            module = XChainService[module]
        } else if (moduleStr === NODE_MODULE_NAME) {
            module = NODE_MODULE_NAME
        }

        if (module != null) {
            const existing = await db.getModuleContainer(module, coinStr, networkStr)
            if (existing == null) {
                await db.insertModuleContainer(module, coinStr, networkStr, nextContainer.ID)
                logIfNotSilent(silent, "Added " + coinStr + SEP + networkStr + SEP + module + " (" + nextContainer.ID + ")")
                added++
            }
        }
    }

    return added
}

module.exports = {
    scanAndRegisterModules
}
