/**
 * Benchmark: resolveArgs() throughput.
 *
 * Measures order-independent argument resolution for various combinations
 * of service/chain/network/branch arguments, including branch validation.
 */

const DEFAULT_ITERATIONS = 10000

module.exports = {
    name: 'resolve-args',
    description: 'resolveArgs() throughput for various argument patterns',

    async run(context, metrics, config = {}) {
        const iterations = config.iterations || DEFAULT_ITERATIONS
        const { resolveArgs } = context.ConfigService
        const results = {}

        metrics.start()

        // --- Standard order: service, chain, network ---
        {
            const label = 'standard-order'
            const args = ['xchain-decoder', 'bitcoin', 'regtest']

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                resolveArgs(args)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6
            const opsPerSec = (iterations / elapsed) * 1000

            metrics.record('resolve_standard', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round(opsPerSec),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }
        }

        // --- Reversed order: network, chain, service ---
        {
            const label = 'reversed-order'
            const args = ['regtest', 'bitcoin', 'xchain-decoder']

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                resolveArgs(args)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6

            metrics.record('resolve_reversed', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round((iterations / elapsed) * 1000),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }
        }

        // --- With branch (expectBranch=true) ---
        {
            const label = 'with-branch'
            const args = ['master', 'xchain-decoder', 'bitcoin', 'regtest']

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                resolveArgs(args, { expectBranch: true })
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6

            metrics.record('resolve_branch', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round((iterations / elapsed) * 1000),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }
        }

        // --- All defaults (empty args) ---
        {
            const label = 'empty-args'
            const args = []

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                resolveArgs(args)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6

            metrics.record('resolve_empty', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round((iterations / elapsed) * 1000),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }
        }

        // --- All "all" values ---
        {
            const label = 'all-values'
            const args = ['all', 'all', 'all']

            const startTime = process.hrtime.bigint()

            for (let i = 0; i < iterations; i++) {
                resolveArgs(args)
            }

            const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6

            metrics.record('resolve_all', elapsed)

            results[label] = {
                iterations,
                totalMs: Math.round(elapsed * 100) / 100,
                opsPerSec: Math.round((iterations / elapsed) * 1000),
                avgUs: Math.round((elapsed / iterations) * 1000 * 100) / 100
            }
        }

        metrics.takeSnapshot('after-resolve-args')
        metrics.stop()

        return {
            scenario: 'resolve-args',
            results,
            peakMemory: metrics.getPeakMemory()
        }
    }
}
