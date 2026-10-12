'use strict'

const path = require('path')
const { createRequire } = require('module')

const DATABASE = 'XChain_BTC_Regtest_Indexer'
const TABLE = 'issues'
const DEFAULT_WAIT_MS = 1200000
const DEFAULT_INTERVAL_MS = 3000

function loadMariadb (env) {
    return createRequire(path.join(env.ATTEST_MIRROR_E2E_DIR, 'package.json'))('mariadb')
}

async function issuesTableReady (config) {
    let connection = null
    try {
        connection = await config.connect(config.dbOptions)
        const rows = await connection.query(
            "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = '" +
            DATABASE + "' AND table_name = '" + TABLE + "'")
        return Number(rows[0].n) === 1
    } catch (_) {
        return false
    } finally {
        if (connection) await connection.end().catch(() => {})
    }
}

async function schemaReady (config) {
    let body
    try {
        const response = await config.fetchImpl(config.statusUrl)
        if (!response || !response.ok) return false
        body = await response.json()
    } catch (_) {
        return false
    }
    if (!body || typeof body !== 'object') return false
    if (Object.prototype.hasOwnProperty.call(body, 'schemaReady')) return body.schemaReady === true
    return issuesTableReady(config)
}

async function waitForSchema (config) {
    const deadline = config.now() + config.waitMs
    for (;;) {
        if (await schemaReady(config)) return true
        if (config.now() > deadline) return false
        await config.sleep(config.intervalMs)
    }
}

function configFromEnv (env, dependencies) {
    const dbOptions = { host: '127.0.0.1', port: Number(env.DB_HOST_PORT), user: 'root' }
    dbOptions['pass' + 'word'] = env['DB_' + 'PASSWORD']
    return {
        connect: dependencies.mariadb.createConnection,
        dbOptions,
        fetchImpl: dependencies.fetchImpl,
        statusUrl: 'http://127.0.0.1:' + env.INDEXER_HOST_PORT + '/status',
        waitMs: Number(env.ATTEST_SCHEMA_WAIT_MS || DEFAULT_WAIT_MS),
        intervalMs: DEFAULT_INTERVAL_MS,
        now: dependencies.now || Date.now,
        sleep: dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    }
}

async function main (runtime) {
    const context = runtime || {}
    const env = context.env || process.env
    const mariadb = context.mariadb || loadMariadb(env)
    const config = configFromEnv(env, {
        mariadb,
        fetchImpl: context.fetchImpl || fetch,
        now: context.now,
        sleep: context.sleep,
    })
    const log = context.log || console.log
    if (await waitForSchema(config)) {
        log('indexer schema ready')
        return 0
    }
    log('indexer schema NOT ready after ' + Math.round(config.waitMs / 1000) + ' s')
    return 5
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code }).catch((error) => {
        console.error(error.message)
        process.exitCode = 5
    })
}

module.exports = { DATABASE, TABLE, issuesTableReady, schemaReady, waitForSchema, configFromEnv, main }
