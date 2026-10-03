#!/usr/bin/env node
'use strict'

// Write the host-side xchain-e2e-test .env a bridge rail drive reads, from the
// stack this runner just booted.
//
// WHY THIS EXISTS. The nightly runs its suites INSIDE the e2e container on the
// stack's docker network, where xchain-node hands it the environment. A bridge rail
// drive cannot run there: it spawns in-process hubs and indexers from source trees
// and reaches the standing services through their host-published ports, exactly as
// established host-driven rails do from a hand-kept .env. This script
// derives that same file from the running containers (the credentials each service
// actually booted with) plus xchain-node's sidecars, with every host rewritten to
// the loopback and every port to its published host port.
//
// Usage: node scripts/rail_leg_env.js <out .env path> [coin]
//        node scripts/rail_leg_env.js --resolve-anchor-arms <out env path>
//        node scripts/rail_leg_env.js --resolve-r2-arms <out env path>
//        node scripts/rail_leg_env.js --resolve-leg-expect <out env path>
// Prints key names only; values never reach the log.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const CONFIG_DIR = path.resolve(__dirname, '..', 'config')
const ANCHOR_ARM_ENVS = Object.freeze([
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION',
])
const R2_ARM_ENVS = Object.freeze([
    'XC_AMOUNTS_PRICE_REGTEST_ACTIVATION',
    'XC_AMOUNTS_PRICE_REGTEST_TIME',
    'XC_CONTRACTS_REGTEST_ACTIVATION',
])
const LEG_EXPECT_ENVS = Object.freeze([
    'XC_E2E_PRICE_FEE_BATCH_LANDED',
    'XC_VOTE_CALLBACK_BINDING_EXPECT',
    'XC_JSON_STRINGIFY_HOOK_EXPECT',
])

function anchorArmHeight (env = process.env) {
    const configured = ANCHOR_ARM_ENVS
        .map((name) => [name, env[name]])
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
        .map(([name, value]) => [name, String(value).trim()])
    if (!configured.length) return null
    for (const [name, value] of configured) {
        if (!/^\d+$/.test(value)) throw new Error(name + ' must be a non-negative integer')
    }
    for (const [name, value] of configured) {
        if (BigInt(value) < 1n) throw new Error(name + ' must be an integer at least 1')
    }
    const heights = new Set(configured.map(([, value]) => BigInt(value).toString()))
    if (heights.size !== 1) throw new Error('anchor arm activations must resolve to one height')
    return heights.values().next().value
}

function writeAnchorArmEnv (out) {
    if (!out) throw new Error('usage: rail_leg_env.js --resolve-anchor-arms <out env path>')
    const height = anchorArmHeight()
    const lines = height === null ? [] : ANCHOR_ARM_ENVS.map((name) => name + '=' + height)
    fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 })
    console.log('rail_leg_env: resolved anchor arm keys: ' + (height === null ? 'none' : ANCHOR_ARM_ENVS.join(' ')))
}

function writeR2ArmEnv (out, env = process.env) {
    if (!out) throw new Error('usage: rail_leg_env.js --resolve-r2-arms <out env path>')
    const configured = R2_ARM_ENVS
        .map((name) => [name, env[name]])
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
        .map(([name, value]) => [name, String(value).trim()])
    for (const [name, value] of configured) {
        if (!/^\d+$/.test(value)) throw new Error(name + ' must be a non-negative integer')
    }
    const lines = configured.map(([name, value]) => name + '=' + value)
    fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 })
    console.log('rail_leg_env: resolved R2 arm keys: ' + (lines.length ? configured.map(([name]) => name).join(' ') : 'none'))
}

function writeLegExpectEnv (out, input = process.env.LEG_EXPECT_JSON) {
    if (!out) throw new Error('usage: rail_leg_env.js --resolve-leg-expect <out env path>')
    let values
    try {
        values = JSON.parse(input)
    } catch (e) {
        throw new Error('LEG_EXPECT_JSON must be a JSON object')
    }
    if (values === null) values = {}
    if (typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('LEG_EXPECT_JSON must be a JSON object')
    }
    for (const name of Object.keys(values)) {
        if (!LEG_EXPECT_ENVS.includes(name)) throw new Error('unknown leg expect key: ' + name)
        const allowed = name === 'XC_E2E_PRICE_FEE_BATCH_LANDED'
            ? ['armed', 'off']
            : ['armed', 'inert']
        if (!allowed.includes(values[name])) throw new Error(name + ' must be one of: ' + allowed.join(', '))
    }
    const lines = LEG_EXPECT_ENVS
        .filter((name) => Object.prototype.hasOwnProperty.call(values, name))
        .map((name) => name + '=' + values[name])
    fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 })
    console.log('rail_leg_env: resolved leg expect keys: ' + (lines.length ? lines.map((line) => line.split('=')[0]).join(' ') : 'none'))
}

function containerEnv (name) {
    try {
        const out = execFileSync('docker', ['inspect', name, '--format', '{{json .Config.Env}}'], { encoding: 'utf8' })
        const env = {}
        for (const line of JSON.parse(out) || []) {
            const i = line.indexOf('=')
            if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
        }
        return env
    } catch (e) {
        return {}
    }
}

function hostPort (name, containerPort) {
    try {
        const out = execFileSync('docker', ['port', name, String(containerPort) + '/tcp'], { encoding: 'utf8' })
        const m = out.match(/:(\d+)\s*$/m)
        return m ? m[1] : null
    } catch (e) {
        return null
    }
}

function sidecar (file) {
    const p = path.join(CONFIG_DIR, file)
    const values = {}
    if (!fs.existsSync(p)) return values
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
        if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return values
}

function first (...values) {
    return values.find((v) => v !== undefined && v !== null && v !== '')
}

function hostServiceUrl (name, containerPort) {
    const port = hostPort(name, containerPort)
    return port ? 'http://127.0.0.1:' + port : null
}

function main () {
    if (process.argv[2] === '--resolve-anchor-arms') {
        writeAnchorArmEnv(process.argv[3])
        return
    }
    if (process.argv[2] === '--resolve-r2-arms') {
        writeR2ArmEnv(process.argv[3])
        return
    }
    if (process.argv[2] === '--resolve-leg-expect') {
        writeLegExpectEnv(process.argv[3])
        return
    }
    const out = process.argv[2]
    const coin = process.argv[3] || 'bitcoin'
    if (!out) throw new Error('usage: rail_leg_env.js <out .env path> [coin]')
    const stack = 'xchain-node-' + coin + '-regtest-'
    const hubName = 'xchain-node-xchain-hub'
    const node = containerEnv(stack + 'node')
    const tracker = containerEnv(stack + 'xchain-utxo-tracker')
    const decoder = containerEnv(stack + 'xchain-decoder')
    const indexer = containerEnv(stack + 'xchain-indexer')
    const hub = containerEnv(hubName)
    const coinSidecar = sidecar(coin + '-regtest.local')
    const hubSidecar = sidecar('hub.local')
    const dbPort = process.env.XCHAIN_NODE_EXTERNAL_DB_PORT || '3306'

    const env = {
        COIN: coin,
        NETWORK: 'regtest',
        NODE_URL: 'localhost',
        NODE_PORT: hostPort(stack + 'node', first(tracker.NODE_PORT, '18444')) || '3020',
        NODE_USER: first(tracker.NODE_USER, indexer.NODE_USER, coinSidecar.NODE_USER),
        NODE_PASSWORD: first(tracker.NODE_PASSWORD, tracker.NODE_SECRET, indexer.NODE_PASSWORD,
            coinSidecar.NODE_PASSWORD, coinSidecar.NODE_SECRET),
        DATABASE_URL: '127.0.0.1',
        DATABASE_PORT: dbPort,
        UTXO_TRACKER_URL: 'localhost',
        UTXO_TRACKER_API_PORT: hostPort(stack + 'xchain-utxo-tracker', 3001),
        ENCODER_URL: 'localhost',
        ENCODER_API_PORT: hostPort(stack + 'xchain-encoder', 3003),
        DECODER_URL: 'localhost',
        DECODER_API_PORT: hostPort(stack + 'xchain-decoder', 3002),
        EXPLORER_URL: 'localhost',
        EXPLORER_API_PORT: hostPort('xchain-node-xchain-explorer', 8080) || '18080',
        INDEXER_URL: 'localhost',
        INDEXER_API_PORT: hostPort(stack + 'xchain-indexer', 3004),
        BTC_INDEXER_API_URL: hostServiceUrl('xchain-node-bitcoin-regtest-xchain-indexer', 3004),
        DOGE_INDEXER_API_URL: hostServiceUrl('xchain-node-dogecoin-regtest-xchain-indexer', 3004),
        DOGE_ENCODER_URL: hostServiceUrl('xchain-node-dogecoin-regtest-xchain-encoder', 3003),
        INDEXER_DB_NAME: indexer.INDEXER_DB_NAME,
        INDEXER_DB_USER: indexer.INDEXER_DB_USER,
        INDEXER_DB_PASS: indexer.INDEXER_DB_PASS,
        REGTEST_MINER_URL: 'localhost',
        REGTEST_MINER_API_PORT: hostPort(stack + 'xchain-regtest-miner', 3005),
        HUB_URL: 'localhost',
        HUB_PORT: hostPort(hubName, 10000) || '10000',
        HUB_API_KEY: first(process.env.HUB_API_KEY, hubSidecar.HUB_API_KEY, hub.HUB_API_KEY),
        HUB_DB_HOST: '127.0.0.1',
        HUB_DB_PORT: dbPort,
        HUB_DB_USER: hub.HUB_DB_USER,
        HUB_DB_PASS: hub.HUB_DB_PASS,
        HUB_SOURCE_DB_NAME: hub.HUB_DB_NAME,
        HUB_DB_NAME: indexer.INDEXER_DB_NAME,
        DECODER_DB_HOST: '127.0.0.1',
        DECODER_DB_PORT: dbPort,
        DECODER_DB_NAME: decoder.DECODER_DB_NAME,
        DECODER_DB_USER: decoder.DECODER_DB_USER,
        DECODER_DB_PASS: decoder.DECODER_DB_PASS,
        XCHAIN_NODE_CONFIG_DIR: CONFIG_DIR,
    }
    for (const name of [...ANCHOR_ARM_ENVS, ...R2_ARM_ENVS]) {
        if (process.env[name]) env[name] = process.env[name]
    }
    const lines = []
    const missing = []
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined || v === null || v === '') { missing.push(k); continue }
        lines.push(k + '=' + v)
    }
    fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 })
    console.log('rail_leg_env: wrote ' + out + ' keys: ' + Object.keys(env).filter((k) => !missing.includes(k)).join(' '))
    if (missing.length) console.log('::warning::rail_leg_env: no value for ' + missing.join(' '))
    // Mask every secret-shaped value in the job log for the rest of the run.
    for (const [k, v] of Object.entries(env)) {
        if (v && /PASS|KEY|SECRET|USER/.test(k)) console.log('::add-mask::' + v)
    }
}

if (require.main === module) main()

module.exports = { writeLegExpectEnv }
