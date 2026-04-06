#!/usr/bin/env node

/**
 * XChain Node Performance Benchmark Harness
 *
 * Usage:
 *   node test/benchmarks/harness.js                    # run all scenarios
 *   node test/benchmarks/harness.js --scenario NAME    # run one scenario
 *   node test/benchmarks/harness.js --list             # list available scenarios
 *   node test/benchmarks/harness.js --compare          # compare against baseline
 *   node test/benchmarks/harness.js --save-baseline    # save results as new baseline
 *   node test/benchmarks/harness.js --json             # output raw JSON
 *   node test/benchmarks/harness.js --quick            # reduced iterations
 */

const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const levelup = require('levelup')
const memdown = require('memdown')
const proxyquire = require('proxyquire').noCallThru()
const MetricsCollector = require('./MetricsCollector')

const BASELINE_PATH = path.join(__dirname, 'baseline.json')

const SCENARIO_FILES = [
    'config-generation',
    'filter-params',
    'leveldb-operations',
    'config-parsing-scale',
    'resolve-args',
    'naming-helpers'
]

// --- Config file contents for mocking ---

const CONFIG_FILES = {
    'bitcoin-mainnet':   'NETWORK=bitcoin-mainnet\nNODE_EXPOSED_PORT=3000\nDUST_AMOUNT=546\n',
    'bitcoin-testnet':   'NETWORK=bitcoin-testnet\nNODE_EXPOSED_PORT=3010\nDUST_AMOUNT=546\n',
    'bitcoin-regtest':   'NETWORK=bitcoin-regtest\nNODE_EXPOSED_PORT=3020\nUTXO_TRACKER_PORT=3021\nDECODER_PORT=3022\nENCODER_PORT=3023\nINDEXER_PORT=3024\nREGTEST_MINER_PORT=3025\nDUST_AMOUNT=546\n',
    'dogecoin-mainnet':  'NETWORK=dogecoin-mainnet\nNODE_EXPOSED_PORT=3030\nDUST_AMOUNT=100000000\n',
    'dogecoin-testnet':  'NETWORK=dogecoin-testnet\nNODE_EXPOSED_PORT=3040\nDUST_AMOUNT=100000000\n',
    'dogecoin-regtest':  'NETWORK=dogecoin-regtest\nNODE_EXPOSED_PORT=3050\nUTXO_TRACKER_PORT=3051\nDECODER_PORT=3052\nENCODER_PORT=3053\nINDEXER_PORT=3054\nREGTEST_MINER_PORT=3055\nDUST_AMOUNT=100000000\n',
    'litecoin-mainnet':  'NETWORK=litecoin-mainnet\nNODE_EXPOSED_PORT=3060\nDUST_AMOUNT=546\n',
    'litecoin-testnet':  'NETWORK=litecoin-testnet\nNODE_EXPOSED_PORT=3070\nDUST_AMOUNT=546\n',
    'litecoin-regtest':  'NETWORK=litecoin-regtest\nNODE_EXPOSED_PORT=3080\nUTXO_TRACKER_PORT=3081\nDECODER_PORT=3082\nENCODER_PORT=3083\nINDEXER_PORT=3084\nREGTEST_MINER_PORT=3085\nDUST_AMOUNT=546\n'
}

function parseArgs() {
    const args = process.argv.slice(2)
    const config = {
        scenario: null,
        compare: false,
        saveBaseline: false,
        json: false,
        quick: false,
        list: false,
        verbose: false
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--scenario': case '-s':
                config.scenario = args[++i]; break
            case '--compare': case '-c':
                config.compare = true; break
            case '--save-baseline':
                config.saveBaseline = true; break
            case '--json': case '-j':
                config.json = true; break
            case '--quick': case '-q':
                config.quick = true; break
            case '--list': case '-l':
                config.list = true; break
            case '--verbose': case '-v':
                config.verbose = true; break
            case '--help': case '-h':
                printUsage(); process.exit(0)
        }
    }

    return config
}

function printUsage() {
    console.log(`
XChain Node Performance Benchmarks

Usage: node test/benchmarks/harness.js [options]

Options:
  --scenario, -s NAME   Run a specific scenario (default: all)
  --compare, -c         Compare results against stored baseline
  --save-baseline       Save current results as new baseline
  --json, -j            Output raw JSON results
  --quick, -q           Reduced iterations for fast feedback
  --list, -l            List available scenarios
  --verbose, -v         Show detailed progress
  --help, -h            Show this help

Scenarios: ${SCENARIO_FILES.join(', ')}
`)
}

/**
 * Build a proxyquire'd ConfigService with fs mocked to return in-memory config streams.
 */
function createMockedConfigService() {
    const realFs = require('fs')
    const configDir = require('../../src/config/constants').configDir

    const fsStub = {
        existsSync: (filePath) => {
            // Check if it's a config file path we know about
            const basename = path.basename(filePath)
            if (CONFIG_FILES[basename]) return true
            return realFs.existsSync(filePath)
        },
        createReadStream: (filePath) => {
            const basename = path.basename(filePath)
            const content = CONFIG_FILES[basename]
            if (content) {
                return Readable.from(content)
            }
            return realFs.createReadStream(filePath)
        },
        rmSync: realFs.rmSync,
        mkdirSync: realFs.mkdirSync
    }

    return proxyquire('../../src/services/ConfigService', { fs: fsStub })
}

/**
 * Create the benchmark context: in-memory LevelDB + mocked ConfigService.
 */
async function createContext() {
    const db = levelup(memdown())
    const ConfigService = createMockedConfigService()
    const constants = require('../../src/config/constants')

    return { db, ConfigService, constants, CONFIG_FILES }
}

async function destroyContext(context) {
    if (context.db && context.db.isOpen()) {
        await context.db.close()
    }
}

function formatNumber(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDelta(current, baseline) {
    if (!baseline) return ''
    const pct = ((current - baseline) / baseline) * 100
    const sign = pct > 0 ? '+' : ''
    return ` (${sign}${pct.toFixed(1)}%)`
}

function printScenarioResult(result) {
    console.log(`\n--- ${result.scenario} ---`)

    if (result.results) {
        for (const [label, data] of Object.entries(result.results)) {
            const parts = [`  ${label.padEnd(24)}`]
            if (data.opsPerSec != null) parts.push(`${formatNumber(data.opsPerSec).padStart(10)} ops/sec`)
            if (data.avgUs != null) parts.push(`avg: ${data.avgUs}us`)
            if (data.avgMs != null) parts.push(`avg: ${data.avgMs}ms`)
            if (data.totalMs != null) parts.push(`total: ${data.totalMs}ms`)
            if (data.iterations != null) parts.push(`n=${formatNumber(data.iterations)}`)
            console.log(parts.join('  '))
        }
    }

    if (result.peakMemory) {
        console.log(`  Memory: peak heap ${result.peakMemory.heapUsedMB.toFixed(1)}MB  RSS ${result.peakMemory.rssMB.toFixed(1)}MB`)
    }
}

async function runScenario(scenarioName, context, config) {
    const scenario = require(`./scenarios/${scenarioName}.bench.js`)
    const metrics = new MetricsCollector()

    const scenarioConfig = { ...config }
    if (config.quick) {
        scenarioConfig.iterations = Math.max(50, Math.floor((scenarioConfig.iterations || 1000) / 10))
    }

    if (!config.json) {
        process.stdout.write(`  Running ${scenario.name}...`)
    }

    const result = await scenario.run(context, metrics, scenarioConfig)

    if (!config.json) {
        process.stdout.write(` done\n`)
    }

    return result
}

async function main() {
    const config = parseArgs()

    if (config.list) {
        console.log('Available scenarios:')
        for (const name of SCENARIO_FILES) {
            const s = require(`./scenarios/${name}.bench.js`)
            console.log(`  ${s.name.padEnd(24)} ${s.description}`)
        }
        return
    }

    const scenariosToRun = config.scenario
        ? [config.scenario]
        : SCENARIO_FILES

    for (const name of scenariosToRun) {
        if (!SCENARIO_FILES.includes(name)) {
            console.error(`Unknown scenario: ${name}`)
            console.error(`Available: ${SCENARIO_FILES.join(', ')}`)
            process.exit(1)
        }
    }

    let baseline = null
    if (config.compare) {
        try {
            baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
        } catch (e) {
            console.error('No baseline found. Run with --save-baseline first.')
        }
    }

    let commitHash = 'unknown'
    try {
        const { execSync } = require('child_process')
        commitHash = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '../..') })
            .toString().trim()
    } catch (e) { /* ignore */ }

    if (!config.json) {
        console.log('=== XChain Node Performance Benchmarks ===')
        console.log(`Date: ${new Date().toISOString()}`)
        console.log(`Commit: ${commitHash}`)
        console.log(`Mode: ${config.quick ? 'quick' : 'full'}`)
        console.log(`Scenarios: ${scenariosToRun.join(', ')}`)
        console.log('')
    }

    const allResults = {
        timestamp: new Date().toISOString(),
        commit: commitHash,
        mode: config.quick ? 'quick' : 'full',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        scenarios: {}
    }

    // Suppress logs during benchmarks unless verbose
    const originalLog = console.log
    const originalWarn = console.warn
    const originalError = console.error
    const suppressLogs = !config.verbose && !config.json

    for (const name of scenariosToRun) {
        const context = await createContext()

        if (suppressLogs) {
            console.log = () => {}
            console.warn = () => {}
            console.error = () => {}
        }

        try {
            const result = await runScenario(name, context, config)
            allResults.scenarios[name] = result

            console.log = originalLog
            console.warn = originalWarn
            console.error = originalError

            if (!config.json) {
                printScenarioResult(result)
            }
        } catch (err) {
            console.log = originalLog
            console.warn = originalWarn
            console.error = originalError
            console.error(`\n  ERROR in ${name}: ${err.message}`)
            if (config.verbose) console.error(err.stack)
            allResults.scenarios[name] = { error: err.message }
        } finally {
            // Restore logs before context cleanup (which may log warnings)
            console.log = originalLog
            console.warn = originalWarn
            console.error = originalError
            await destroyContext(context)
        }
    }

    if (config.json) {
        console.log(JSON.stringify(allResults, null, 2))
    }

    if (config.saveBaseline) {
        fs.writeFileSync(BASELINE_PATH, JSON.stringify(allResults, null, 2))
        console.log(`\nBaseline saved to ${BASELINE_PATH}`)
    }

    // Print baseline comparison if available
    if (baseline && !config.json) {
        console.log('\n--- Baseline Comparison ---')
        for (const [scenarioName, result] of Object.entries(allResults.scenarios)) {
            const baseScenario = baseline.scenarios?.[scenarioName]
            if (!baseScenario || !result.results) continue
            console.log(`\n  ${scenarioName}:`)
            for (const [label, data] of Object.entries(result.results)) {
                const baseData = baseScenario.results?.[label]
                if (!baseData || data.opsPerSec == null) continue
                console.log(`    ${label.padEnd(24)} ${formatNumber(data.opsPerSec).padStart(10)} ops/sec${formatDelta(data.opsPerSec, baseData.opsPerSec)}`)
            }
        }
    }

    if (!config.json) {
        console.log('\n=== Benchmark Complete ===')
    }
}

main().catch(err => {
    console.error('Benchmark harness failed:', err)
    process.exit(1)
})
