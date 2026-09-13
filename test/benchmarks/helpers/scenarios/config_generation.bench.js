/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Benchmark: getDefaultConfig() throughput.
 *
 * Measures config generation for all 9 coin-network combinations plus
 * the shared-module path (null coin/network). Each call creates a full
 * environment variable set by merging hardcoded defaults with config
 * file overrides parsed via readline.
 */

const DEFAULT_ITERATIONS = 1000

const COIN_NETWORKS = [
    { coin: 'bitcoin',  network: 'mainnet' },
    { coin: 'bitcoin',  network: 'testnet' },
    { coin: 'bitcoin',  network: 'regtest' },
    { coin: 'dogecoin', network: 'mainnet' },
    { coin: 'dogecoin', network: 'testnet' },
    { coin: 'dogecoin', network: 'regtest' },
    { coin: 'litecoin', network: 'mainnet' },
    { coin: 'litecoin', network: 'testnet' },
    { coin: 'litecoin', network: 'regtest' }
]

module.exports = {
    name: 'config-generation',
    description: 'getDefaultConfig() throughput for all coin-network combinations',

    async run(context, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const { getDefaultConfig } = context.ConfigService
        const results = {}

        metrics.start()

        for (const { coin, network } of COIN_NETWORKS) {
            const label = `${coin}-${network}`

            for (let i = 0; i < 5; i++) {
                await getDefaultConfig('xchain-decoder', coin, network)
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                await getDefaultConfig('xchain-decoder', coin, network)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record(`config_${label}`, elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // Benchmark shared module path (no coin/network: hub/explorer config)
        {
            const label = 'shared-module'

            for (let i = 0; i < 5; i++) {
                await getDefaultConfig('xchain-hub', null, null)
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                await getDefaultConfig('xchain-hub', null, null)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record('config_shared', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        metrics.takeSnapshot('after-config-generation')
        metrics.stop()

        return {
            scenario: 'config-generation',
            results,
            peakMemory: metrics.getPeakMemory(),
            eventLoopLag: metrics.getEventLoopStats()
        }
    }
}
