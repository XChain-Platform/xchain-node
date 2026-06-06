/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Benchmark: filterCommandParameters() throughput.
 *
 * Measures the combinatorial expansion of service/coin/network arguments
 * into the nested servicesList structure. The "all/all/all" case is the
 * worst-case expansion (3 coins x 3 networks x N modules).
 */

const DEFAULT_ITERATIONS = 5000

module.exports = {
    name: 'filter-params',
    description: 'filterCommandParameters() expansion for all/single/explorer cases',

    async run(context, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const { filterCommandParameters } = context.ConfigService
        const results = {}

        metrics.start()

        // --- all/all/all (worst case: full expansion) ---
        {
            const label = 'all-all-all'

            for (let i = 0; i < 10; i++) {
                filterCommandParameters(null, 'all', 'all', 'all')
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                filterCommandParameters(null, 'all', 'all', 'all')
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record('filter_all', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // --- Single coin/network/module ---
        {
            const label = 'single-target'

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record('filter_single', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // --- Explorer shortcut ---
        {
            const label = 'explorer'

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                filterCommandParameters(null, 'explorer', 'all', 'all')
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record('filter_explorer', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // --- Node shortcut ---
        {
            const label = 'node-all-all'

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                filterCommandParameters(null, 'node', 'all', 'all')
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record('filter_node', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        metrics.takeSnapshot('after-filter-params')
        metrics.stop()

        return {
            scenario: 'filter-params',
            results,
            peakMemory: metrics.getPeakMemory()
        }
    }
}
