/*********************************************************************
 * XChain Node - Telemetry Service
 *
 * Anonymous usage telemetry for node operators. Default-on with a real,
 * documented off-switch. Collects only: an anonymous install id, version
 * numbers, which services are running, and basic OS/Docker info. The IP
 * is never sent here; the hub derives only a coarse country/region from the
 * connection and discards the IP (it is never stored).
 * No secrets, wallet data, addresses, or config values are ever included.
 *
 * Opt-out precedence (highest first):
 *   1. --no-telemetry CLI flag
 *   2. XCHAIN_NODE_NO_TELEMETRY=1 environment variable
 *   3. persisted optOut in ~/.xchain-node/telemetry.json
 *   4. default: enabled
 *
 * See the telemetry/privacy page in xchain-documentation for the full list.
 ********************************************************************/

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')

const { version: nodeVersion } = require('../../package.json')
const TelemetryConnector = require('../TelemetryConnector')

const PREF_DIR_NAME  = '.xchain-node'
const PREF_FILE_NAME = 'telemetry.json'
// Routine commands (start/heartbeat) only ping once per this window so day-to-day
// CLI use doesn't spam the collector; install/update always ping.
const HEARTBEAT_WINDOW_MS = 24 * 60 * 60 * 1000

function getPrefDir()  { return path.join(os.homedir(), PREF_DIR_NAME) }
function getPrefPath() { return path.join(getPrefDir(), PREF_FILE_NAME) }

function loadPref() {
    try {
        return JSON.parse(fs.readFileSync(getPrefPath(), 'utf8'))
    } catch {
        return null
    }
}

function savePref(pref) {
    const dir = getPrefDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const filePath = getPrefPath()
    fs.writeFileSync(filePath, JSON.stringify(pref, null, 2), { mode: 0o600 })
    try { fs.chmodSync(filePath, 0o600) } catch { /* Windows: protected by HOME ACL */ }
}

// Resolve the opt-out decision across flag > env > persisted preference > default.
function isOptedOut(cliOptOut, pref) {
    if (cliOptOut === true) return true
    const env = (process.env.XCHAIN_NODE_NO_TELEMETRY || '').toLowerCase()
    if (env === '1' || env === 'true' || env === 'yes') return true
    if (pref && pref.optOut === true) return true
    return false
}

// Best-effort docker engine version, e.g. "27.3.1". Null on any failure.
function getDockerVersion() {
    return new Promise((resolve) => {
        try {
            execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 3000 }, (err, stdout) => {
                if (err || !stdout) return resolve(null)
                resolve(String(stdout).trim().slice(0, 32) || null)
            })
        } catch {
            resolve(null)
        }
    })
}

// Flatten the cached install status into the telemetry module list.
async function gatherModules() {
    // Lazy require avoids a circular dependency (StatusService → HubService → ...).
    const { getStatus } = require('./StatusService')
    let status = {}
    try {
        status = await getStatus(null, null, false) || {}
    } catch {
        return []
    }
    const modules = []
    for (const coin in status) {
        for (const network in status[coin]) {
            const mods = status[coin][network]
            for (const mod in mods) {
                const m = mods[mod] || {}
                const running = !!(m.status && m.status.State && m.status.State.Status === 'running')
                let version = m.container_version || m.local_version || null
                if (version === '-' || version === undefined) version = null
                modules.push({ module: mod, coin, network, version, running })
            }
        }
    }
    return modules
}

async function gatherPayload(event, installId) {
    return {
        install_id:     installId,
        node_version:   nodeVersion,
        os_platform:    os.platform(),
        os_release:     os.release(),
        arch:           os.arch(),
        docker_version: await getDockerVersion(),
        modules:        await gatherModules(),
        event:          event
    }
}

// Map a CLI command name to a telemetry event class.
function eventForCommand(commandName) {
    if (commandName === 'install') return 'install'
    if (commandName === 'update' || commandName === 'reinstall') return 'update'
    if (commandName === 'start') return 'start'
    return 'heartbeat'
}

// Main entry — call once per command (from the CLI preAction hook), after
// precheck has populated install status. Never throws; best-effort.
async function maybeReportTelemetry(commandName, cliOptOut) {
    let pref = loadPref()

    // Honour opt-out before doing anything. Make the choice sticky so a user who
    // opts out once stays opted out on later runs without re-passing the flag.
    if (isOptedOut(cliOptOut, pref)) {
        if (!pref || pref.optOut !== true) {
            try { savePref(Object.assign({}, pref, { optOut: true })) } catch { /* ignore */ }
        }
        return
    }

    const event = eventForCommand(commandName)

    // First run: initialise the pref store. Opt-out is documented (flag / env /
    // telemetry.json); telemetry itself reports silently by default.
    const firstRun = !pref
    if (firstRun) pref = {}

    // Debounce routine commands; install/update always report.
    const now = Date.now()
    const debounced = (event === 'start' || event === 'heartbeat')
    if (debounced && pref.lastPingAt) {
        const last = Date.parse(pref.lastPingAt)
        if (!isNaN(last) && (now - last) < HEARTBEAT_WINDOW_MS) {
            // Still persist the first-run id/notice state even when we skip the ping.
            if (firstRun) {
                pref.installId = pref.installId || crypto.randomUUID()
                try { savePref(pref) } catch { /* ignore */ }
            }
            return
        }
    }

    // Anonymous, generated once and reused.
    if (!pref.installId) pref.installId = crypto.randomUUID()

    const payload = await gatherPayload(event, pref.installId)
    await new TelemetryConnector().report(payload)

    // Bound attempts to the debounce window regardless of send success.
    pref.lastPingAt = new Date(now).toISOString()
    try { savePref(pref) } catch { /* ignore */ }
}

module.exports = {
    maybeReportTelemetry,
    isOptedOut,
    eventForCommand,
    gatherPayload,
    getPrefPath,
    loadPref,
    savePref
}
