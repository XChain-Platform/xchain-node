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
 * Benchmark: naming and validation helper functions.
 *
 * Measures pure string functions that are called frequently during
 * Docker command construction: image naming, network naming, database
 * naming, and port validation.
 */

const DEFAULT_ITERATIONS = 10000

const MODULES = ['xchain-decoder', 'xchain-encoder', 'xchain-indexer', 'xchain-utxo-tracker', 'xchain-regtest-miner']
const COINS = ['bitcoin', 'dogecoin', 'litecoin']
const NETWORKS = ['mainnet', 'testnet', 'regtest']

module.exports = {
    name: 'naming-helpers',
    description: 'Docker naming, DB naming, and port validation throughput',

    async run(context, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const {
            getDockerContainerImageName,
            getDockerNetwork,
            getModuleDatabaseName,
            validatePort
        } = context.ConfigService
        const results = {}

        metrics.start()

        // --- getDockerContainerImageName (all combos) ---
        {
            const label = 'docker-image-name'
            const combos = []
            for (const mod of MODULES) {
                for (const coin of COINS) {
                    for (const net of NETWORKS) {
                        combos.push([mod, coin, net])
                    }
                }
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                for (const [mod, coin, net] of combos) {
                    getDockerContainerImageName(mod, coin, net)
                }
            }

            const totalOps = iterations * combos.length
            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (totalOps / elapsed) * 1000

            metrics.record('naming_image', elapsed)

            results[label] = {
                iterations: totalOps,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / totalOps) * 1000 * 100) / 100
            }
        }

        // --- getDockerNetwork ---
        {
            const label = 'docker-network'

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                for (const coin of COINS) {
                    for (const net of NETWORKS) {
                        getDockerNetwork(coin, net)
                    }
                }
                // Also test shared network (empty strings)
                getDockerNetwork('', '')
            }

            const totalOps = iterations * (COINS.length * NETWORKS.length + 1)
            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (totalOps / elapsed) * 1000

            metrics.record('naming_network', elapsed)

            results[label] = {
                iterations: totalOps,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / totalOps) * 1000 * 100) / 100
            }
        }

        // --- getModuleDatabaseName ---
        {
            const label = 'database-name'
            const dbModules = ['xchain-decoder', 'xchain-indexer']

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                for (const mod of dbModules) {
                    for (const coin of COINS) {
                        for (const net of NETWORKS) {
                            getModuleDatabaseName(mod, coin, net)
                        }
                    }
                }
            }

            const totalOps = iterations * dbModules.length * COINS.length * NETWORKS.length
            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (totalOps / elapsed) * 1000

            metrics.record('naming_database', elapsed)

            results[label] = {
                iterations: totalOps,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / totalOps) * 1000 * 100) / 100
            }
        }

        // --- validatePort ---
        {
            const label = 'validate-port'
            const testPorts = [
                80, 443, 3000, 8080, 8332, 18332, 18444, 65535,    // valid numbers
                '80', '3000', '18444', '65535',                      // valid strings
                0, -1, 65536, 'abc', '', null, undefined             // invalid
            ]

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                for (const port of testPorts) {
                    validatePort(port)
                }
            }

            const totalOps = iterations * testPorts.length
            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (totalOps / elapsed) * 1000

            metrics.record('validate_port', elapsed)

            results[label] = {
                iterations: totalOps,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / totalOps) * 1000 * 100) / 100
            }
        }

        metrics.takeSnapshot('after-naming-helpers')
        metrics.stop()

        return {
            scenario: 'naming-helpers',
            results,
            peakMemory: metrics.getPeakMemory()
        }
    }
}
