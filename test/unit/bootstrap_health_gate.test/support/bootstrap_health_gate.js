'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon')
const { configStub } = require('../../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { XChainService } = require('../../../../src/config')

const COIN = 'litecoin'
const NETWORK = 'mainnet'
const SVC_CONTAINER = 'c'.repeat(64)
const DB_CONTAINER = 'd'.repeat(64)
const DECODER_DB = 'xchain_ltc_mainnet_decoder'
const INDEXER_DB = 'xchain_ltc_mainnet_indexer'

// A container that is up, stable, and passing its healthcheck.
function healthyInspect({ started = '2026-01-01T00:00:00.000Z' } = {}) {
    return `running|false|0|${started}|healthy\n`
}

// The external-DB helper answers per query by default (both marker tables
// present, no marker rows), the same clean-database shape the docker runner
// fakes. A test that wants the "helper answered with nothing" shape - a
// mis-parsed client option, a driver that returned no rows - passes
// nativeResolves: '' and gets that for every call.
function nativeHelperStub(nativeResolves) {
    if (nativeResolves !== null) return sinon.stub().resolves(nativeResolves)
    return sinon.stub().callsFake(async (cfg, sql) =>
        (/information_schema\.TABLES/.test(sql) ? '1\t1' : '0'))
}

function loadGate({ external = false, nativeResolves = null } = {}) {
    const config = configStub({
        XChainService,
        EXTERNAL_DB: external
    })
    const configService = {
        getDefaultConfig: sinon.stub().resolves({
            DECODER_API_PORT: 3002,
            INDEXER_API_PORT: 3004,
            UTXO_TRACKER_API_PORT: 3001
        }),
        // Module-aware, because gating an indexer must probe TWO databases and a
        // test cannot express "decoder dirty, indexer clean" while both share a name.
        getModuleDatabaseName: sinon.stub().callsFake(m =>
            (m === XChainService.XCHAIN_INDEXER ? INDEXER_DB : DECODER_DB))
    }
    // The marker probe lives in a part the entry requires, so the part is loaded
    // with the same config, config service and docker stubs and handed to the entry.
    const haltMarkers = proxyquire('../../../../src/services/bootstrap_health_gate/halt_markers.js', {
        '../../config': config,
        '../config_service': configService,
        '../../utils/docker_mariadb': {
            dockerMariadbArgs: (id, args) => ['exec', '-e', 'MYSQL_PWD', id, ...args],
            mariadbEnv:        () => ({})
        }
    })
    return proxyquire('../../../../src/services/bootstrap_health_gate', {
        '../config': config,
        '../state': { db: { getModuleContainer: sinon.stub().resolves(SVC_CONTAINER) } },
        './config_service': configService,
        './database_service': {
            getDatabaseContainerId:      sinon.stub().resolves(DB_CONTAINER),
            askMariadbRootPassword:      sinon.stub().resolves('rootpass'),
            getExternalDbConfig:         sinon.stub().resolves({ host: 'h', port: 3306, root_user: 'root', root_password: 'p' }),
            executeNativeMariaDbCommand: nativeHelperStub(nativeResolves)
        },
        './bootstrap_health_gate/halt_markers.js': haltMarkers
    })
}

// Build a `runner` (execFileAsync stand-in) driven by a small scenario object,
// so each test states only what it changes.
function makeRunner({
    inspect = healthyInspect(),
    // Models the rich JSON-RPC `health` payload, the first surface probeServiceStatus
    // tries; it publishes reorg_halt_checked_at beside reorg_halted. A null
    // timestamp means no marker probe ever completed, so it is not a "not halted".
    status  = { status: 'healthy', lag_blocks: 0, reorg_halted: false, reorg_halt_checked_at: 1756000000000 },
    tables  = '1\t1',
    reorgHaltRows = '0',
    syncHaltRows  = '0',
    inspectThrows = null,
    statusThrows  = null,
    sqlThrows     = null,
    // Answers for the PAIRED DECODER database an indexer gate probes second. Left
    // null, that database answers exactly as the gated one does; set it to express
    // the scenario the gate exists for and a single-database fake cannot reach:
    // decoder dirty, indexer clean. Accepts { tables, reorgHaltRows, syncHaltRows,
    // eventsWatermark, syncHaltWatermark, reorgHaltWindowRows, syncHaltWindowRows,
    // throws }.
    decoder       = null,
    // MAX(id) of each marker table: the dump-window watermark. The gate takes one
    // before the dump and hands it back as `since` after it, so these two plus the
    // *WindowRows below are what a halt raised (and possibly cleared) mid-dump
    // looks like to the probe.
    eventsWatermark     = '100',
    syncHaltWatermark   = '50',
    // Rows ABOVE the handed-in watermark, i.e. raised inside the dump window.
    reorgHaltWindowRows = '0',
    syncHaltWindowRows  = '0'
} = {}) {
    return sinon.stub().callsFake(async (cmd, args) => {
        if (args[0] === 'inspect') {
            if (inspectThrows) throw inspectThrows
            return { stdout: inspect }
        }
        // docker exec ... wget (service health probe)
        if (args.includes('wget')) {
            if (statusThrows) throw statusThrows
            return { stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result: status }) }
        }
        // docker exec ... mariadb -BN -e <sql>. lastIndexOf, because the docker
        // invocation carries its own `-e MYSQL_PWD` ahead of the client's `-e <sql>`.
        const sql = args[args.lastIndexOf('-e') + 1] || ''
        if (sqlThrows) throw sqlThrows
        const up = (decoder && sql.includes(DECODER_DB)) ? decoder : null
        if (up && up.throws) throw up.throws
        const pick = (key, fallback) => (up && up[key] !== undefined) ? up[key] : fallback
        if (/information_schema\.TABLES/.test(sql)) return { stdout: pick('tables', tables) }
        // Watermark and dump-window queries first: both mention the table names the
        // live-marker branches below match on.
        if (/COALESCE\(MAX\(id\),0\) FROM `[^`]+`\.events/.test(sql)) return { stdout: pick('eventsWatermark', eventsWatermark) }
        if (/COALESCE\(MAX\(id\),0\) FROM `[^`]+`\.sync_halt/.test(sql)) return { stdout: pick('syncHaltWatermark', syncHaltWatermark) }
        if (/code='REORG_HALT' AND id > \d+/.test(sql)) return { stdout: pick('reorgHaltWindowRows', reorgHaltWindowRows) }
        if (/sync_halt WHERE id > \d+/.test(sql)) return { stdout: pick('syncHaltWindowRows', syncHaltWindowRows) }
        if (/REORG_HALT/.test(sql)) return { stdout: pick('reorgHaltRows', reorgHaltRows) }
        if (/sync_halt/.test(sql)) return { stdout: pick('syncHaltRows', syncHaltRows) }
        return { stdout: '' }
    })
}

function callGate(gate, { module = XChainService.XCHAIN_DECODER, runner, container = SVC_CONTAINER, now, since } = {}) {
    return gate.assertBootstrapSourceHealthy(COIN, NETWORK, module, {
        runner,
        getModuleContainer: sinon.stub().resolves(container),
        now: now || Date.parse('2026-07-27T00:00:00.000Z'),
        since: since === undefined ? null : since
    })
}

async function refusal(promise) {
    try {
        await promise
    } catch (err) {
        return err
    }
    throw new Error('expected the gate to refuse, but it passed')
}

function installEnvironmentHooks() {
    let savedSkip, savedMaxLag
    beforeEach(function () {
        savedSkip   = process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE
        savedMaxLag = process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS
        delete process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE
        delete process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS
    })
    afterEach(function () {
        if (savedSkip === undefined) delete process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE
        else process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE = savedSkip
        if (savedMaxLag === undefined) delete process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS
        else process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS = savedMaxLag
    })
}

module.exports = {
    COIN,
    DB_CONTAINER,
    DECODER_DB,
    INDEXER_DB,
    NETWORK,
    SVC_CONTAINER,
    XChainService,
    callGate,
    expect,
    healthyInspect,
    installEnvironmentHooks,
    loadGate,
    makeRunner,
    proxyquire,
    refusal,
    sinon
}
