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
 * Benchmark: config file parsing at varying sizes.
 *
 * Measures how getDefaultConfig() scales when the coin-network config
 * file grows from 10 to 500 lines. Each line is a KEY=VALUE override
 * parsed via readline from an in-memory stream.
 */

const { Readable } = require('stream')
const path = require('path')
const proxyquire = require('proxyquire').noCallThru()

const DEFAULT_ITERATIONS = 500

const LINE_COUNTS = [10, 50, 100, 500]

function generateConfigContent(lineCount) {
    const lines = []
    // Start with realistic overrides
    lines.push('NETWORK=bitcoin-regtest')
    lines.push('NODE_EXPOSED_PORT=3020')
    lines.push('UTXO_TRACKER_PORT=3021')
    lines.push('DECODER_PORT=3022')
    lines.push('ENCODER_PORT=3023')
    lines.push('INDEXER_PORT=3024')
    lines.push('REGTEST_MINER_PORT=3025')
    lines.push('DUST_AMOUNT=546')

    // Pad with additional synthetic overrides
    for (let i = lines.length; i < lineCount; i++) {
        lines.push(`CUSTOM_VAR_${i}=value_${i}`)
    }

    return lines.join('\n') + '\n'
}

module.exports = {
    name: 'config-parsing-scale',
    description: 'getDefaultConfig() scaling with config file sizes (10–500 lines)',

    async run(context, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const results = {}

        metrics.start()

        for (const lineCount of LINE_COUNTS) {
            const label = `${lineCount}-lines`
            const content = generateConfigContent(lineCount)

            // Build a ConfigService with this specific content
            const fsStub = {
                existsSync: () => true,
                createReadStream: () => Readable.from(content),
                rmSync: () => {},
                mkdirSync: () => {}
            }

            const ConfigService = proxyquire('../../../src/services/ConfigService', { fs: fsStub })

            // Warm up
            for (let i = 0; i < 5; i++) {
                await ConfigService.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
            }

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                await ConfigService.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000
            const avgUs = (elapsed / iterations) * 1000

            metrics.record(`parse_${lineCount}`, elapsed)

            results[label] = {
                iterations,
                lineCount,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round(avgUs * 100) / 100
            }
        }

        // Calculate scaling factor: how much slower is 500 lines vs 10 lines?
        const fast = results['10-lines']
        const slow = results['500-lines']
        const scalingFactor = fast && slow && fast.avgUs > 0
            ? Math.round((slow.avgUs / fast.avgUs) * 100) / 100
            : null

        metrics.takeSnapshot('after-parsing-scale')
        metrics.stop()

        return {
            scenario: 'config-parsing-scale',
            results,
            scalingFactor,
            peakMemory: metrics.getPeakMemory()
        }
    }
}
