/**
 * Benchmark: LevelDB operations throughput.
 *
 * Measures put/get/del single-key latency and getAllModuleContainers
 * scan performance at varying entry counts using memdown (in-memory).
 */

const levelup = require('levelup')
const memdown = require('memdown')

const DEFAULT_ITERATIONS = 5000
const PREFIX = 'MC'

const MODULES = ['xchain-decoder', 'xchain-encoder', 'xchain-indexer', 'xchain-utxo-tracker', 'xchain-regtest-miner']
const COINS = ['bitcoin', 'dogecoin', 'litecoin']
const NETWORKS = ['mainnet', 'testnet', 'regtest']

function fakeContainerId(n) {
    return n.toString(16).padStart(64, 'a')
}

function buildKey(module, coin, network) {
    return `${PREFIX}${module};${coin};${network}`
}

/**
 * Scan all MC-prefixed entries (mirrors LevelUpStore.getAllModuleContainers).
 */
function scanAll(db, coin, network) {
    return new Promise((resolve, reject) => {
        const modules = []
        const stream = db.createReadStream({
            gte: PREFIX,
            lte: PREFIX + '\xFF',
            keys: true,
            values: true
        })
        stream.on('data', (data) => {
            const keyStr = data.key.toString('utf-8').substring(PREFIX.length)
            const parts = keyStr.split(';')
            if (parts.length === 3) {
                if ((coin == null && network == null) ||
                    (coin === parts[1] && network === parts[2]) ||
                    (parts[1] === '' && parts[2] === '')) {
                    modules.push({
                        module: parts[0],
                        coin: parts[1],
                        network: parts[2],
                        container_id: data.value.toString('utf-8')
                    })
                }
            }
        })
        stream.on('error', reject)
        stream.on('end', () => resolve(modules))
    })
}

module.exports = {
    name: 'leveldb-operations',
    description: 'LevelDB put/get/del/scan throughput with memdown',

    async run(context, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const results = {}

        metrics.start()

        // --- Single put ---
        {
            const db = levelup(memdown())
            const label = 'single-put'

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                await db.put(buildKey('xchain-decoder', 'bitcoin', 'regtest'), fakeContainerId(i))
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000

            metrics.record('leveldb_put', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }

            await db.close()
        }

        // --- Single get ---
        {
            const db = levelup(memdown())
            const key = buildKey('xchain-decoder', 'bitcoin', 'regtest')
            await db.put(key, fakeContainerId(0))
            const label = 'single-get'

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                await db.get(key)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000

            metrics.record('leveldb_get', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }

            await db.close()
        }

        // --- Single del ---
        {
            const db = levelup(memdown())
            const label = 'single-del'

            // Pre-populate
            for (let i = 0; i < iterations; i++) {
                await db.put(buildKey('mod' + i, 'bitcoin', 'regtest'), fakeContainerId(i))
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                await db.del(buildKey('mod' + i, 'bitcoin', 'regtest'))
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000

            metrics.record('leveldb_del', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }

            await db.close()
        }

        // --- Scan (getAllModuleContainers) at varying sizes ---
        const scanSizes = [10, 50, 100, 500]
        const scanIterations = Math.min(iterations, 500)

        for (const size of scanSizes) {
            const db = levelup(memdown())
            const label = `scan-${size}-entries`

            // Populate with realistic keys
            let idx = 0
            for (const mod of MODULES) {
                for (const coin of COINS) {
                    for (const net of NETWORKS) {
                        if (idx >= size) break
                        await db.put(buildKey(mod, coin, net), fakeContainerId(idx++))
                    }
                    if (idx >= size) break
                }
                if (idx >= size) break
            }
            // Fill remaining with synthetic entries
            while (idx < size) {
                await db.put(buildKey(`mod-${idx}`, 'bitcoin', 'regtest'), fakeContainerId(idx))
                idx++
            }

            // Warm up
            for (let i = 0; i < 3; i++) {
                await scanAll(db, null, null)
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < scanIterations; i++) {
                await scanAll(db, null, null)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const avgMs = elapsed / scanIterations

            metrics.record(`leveldb_scan_${size}`, elapsed)

            results[label] = {
                iterations: scanIterations,
                totalMs: Math.round(elapsed * 100) / 100,
                avgMs: Math.round(avgMs * 100) / 100,
                opsPerSec: Math.round((scanIterations / elapsed) * 1000)
            }

            await db.close()
        }

        // --- Filtered scan (single coin-network) ---
        {
            const db = levelup(memdown())
            const label = 'scan-filtered'
            const size = 100

            let idx = 0
            for (const mod of MODULES) {
                for (const coin of COINS) {
                    for (const net of NETWORKS) {
                        if (idx >= size) break
                        await db.put(buildKey(mod, coin, net), fakeContainerId(idx++))
                    }
                    if (idx >= size) break
                }
                if (idx >= size) break
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < scanIterations; i++) {
                await scanAll(db, 'bitcoin', 'regtest')
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6

            metrics.record('leveldb_scan_filtered', elapsed)

            results[label] = {
                iterations: scanIterations,
                totalMs: Math.round(elapsed * 100) / 100,
                avgMs: Math.round((elapsed / scanIterations) * 100) / 100,
                opsPerSec: Math.round((scanIterations / elapsed) * 1000)
            }

            await db.close()
        }

        metrics.takeSnapshot('after-leveldb')
        metrics.stop()

        return {
            scenario: 'leveldb-operations',
            results,
            peakMemory: metrics.getPeakMemory()
        }
    }
}
