'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const GROUPS = [
    { name: 'unit', prefix: 'test/unit/', args: ['--timeout', '2000', '--recursive', '--exit'] },
    { name: 'security', prefix: 'test/security/', args: ['--timeout', '10000', '--recursive', '--exit'] },
    { name: 'regression', prefix: 'test/regression/', args: ['--timeout', '30000', '--recursive', '--exit'] },
]

const CONSENSUS = [
    'src/coins/',
    'src/github_hashes.json',
    'src/release-manifest.json',
    'src/config/',
    'src/services/bootstrap_service.js',
    'src/services/github_downloader.js',
    'src/services/validator_service.js',
    'src/services/go_live_gate.js',
    'src/services/skew_guard_service.js',
    'bin/pins/',
    'bin/pin_identity.js',
]

const WIDEN = ['test/helpers/']
const ALWAYS = []

function runGit(git, args) {
    const output = git(args)
    return Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '')
}

function resolveBase({ env, git }) {
    const requested = env.PROM_CI_BASE_SHA
    if (requested) {
        try {
            runGit(git, ['cat-file', '-e', `${requested}^{commit}`])
            return requested
        } catch (_) {}
    }
    try {
        return runGit(git, ['merge-base', 'HEAD', 'origin/develop']).trim() || null
    } catch (_) {
        return null
    }
}

function splitLines(value) {
    if (Array.isArray(value)) return value.filter(Boolean)
    return String(value || '').split(/\r?\n/).filter(Boolean)
}

function groupFor(file) {
    return GROUPS.find((group) => file.startsWith(group.prefix) && file.endsWith('.test.js'))
}

function startsWithAny(file, entries) {
    return entries.some((entry) => file.startsWith(entry))
}

function sourceText(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch (_) {
        return ''
    }
}

function requireTargets(source, importer) {
    const targets = []
    const expression = /\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g
    let match
    while ((match = expression.exec(source))) {
        const resolved = path.resolve(path.dirname(importer), match[2])
        targets.push(resolved, `${resolved}.js`, path.join(resolved, 'index.js'))
    }
    return targets
}

function requiresFile(importer, target) {
    const absoluteTarget = path.resolve(target)
    return requireTargets(sourceText(importer), importer).includes(absoluteTarget)
}

function namedModuleTest(importer, target) {
    const tail = target.replace(/\.js$/, '')
    return sourceText(importer).includes(tail)
}

function sourceMatches(file, tests, requirers) {
    const name = path.basename(file, '.js')
    const relativeDirectory = path.dirname(file.slice('src/'.length))
    const matches = new Set()
    for (const test of tests) {
        const testName = path.basename(test)
        const parts = test.split('/')
        if (name !== 'index' && testName === `${name}.test.js`) matches.add(test)
        if (parts.includes(`${name}.test`)) matches.add(test)
        const group = groupFor(test)
        const directDirectory = relativeDirectory === '.'
            ? group && group.prefix.slice(0, -1)
            : group && `${group.prefix}${relativeDirectory}`
        if (directDirectory && path.dirname(test) === directDirectory) matches.add(test)
        if (requirers.includes(test) && namedModuleTest(test, file)) matches.add(test)
    }
    return matches
}

function collectSourceData(changedSources, findRequirers) {
    return changedSources.map((file) => ({
        file,
        requirers: splitLines(findRequirers(path.basename(file, '.js'))),
    }))
}

function consensusReasons(changedFiles, sourceData) {
    const reasons = []
    for (const file of changedFiles) {
        if (file === 'package.json' || startsWithAny(file, CONSENSUS) || startsWithAny(file, WIDEN)) {
            reasons.push(`consensus: ${file}`)
        }
    }
    for (const { file, requirers } of sourceData) {
        for (const importer of requirers) {
            if (startsWithAny(importer, CONSENSUS) && requiresFile(importer, file)) {
                reasons.push(`consensus importer: ${importer} requires ${file}`)
            }
        }
    }
    return reasons
}

function selectedTestFiles(changedFiles, tests, sourceData, reasons) {
    const selected = new Set(ALWAYS)
    for (const file of changedFiles) {
        const group = groupFor(file)
        if (group) selected.add(file)
        else if (file.startsWith('test/') && file.endsWith('.test.js')) reasons.push(`deferred: ${file}`)
    }
    for (const { file, requirers } of sourceData) {
        for (const test of sourceMatches(file, tests, requirers)) selected.add(test)
    }
    return selected
}

function selectFastTests(changedFiles, { listTests, findRequirers }) {
    const changed = splitLines(changedFiles)
    const tests = splitLines(listTests()).filter((file) => groupFor(file) && fs.existsSync(file))
    const sources = changed.filter((file) => file.startsWith('src/') && file.endsWith('.js'))
    const sourceData = collectSourceData(sources, findRequirers)
    const reasons = consensusReasons(changed, sourceData)
    const selected = selectedTestFiles(changed, tests, sourceData, reasons)
    const consensus = reasons.some((reason) => reason.startsWith('consensus'))
    const planned = consensus ? [] : [...selected]
        .filter((file) => tests.includes(file))
        .sort()
        .map((file) => ({ group: groupFor(file).name, file }))
    return { consensus, reasons: [...new Set(reasons)].sort(), tests: planned }
}

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8' })
}

function listTrackedFiles() {
    return splitLines(git(['ls-files']))
}

function findRequirers(basename) {
    const result = spawnSync('git', ['grep', '-l', '--fixed-strings', basename, '--', '*.js'], {
        encoding: 'utf8',
    })
    if (result.status === 1) return []
    if (result.status !== 0) throw new Error((result.stderr || 'git grep failed').trim())
    return splitLines(result.stdout)
}

function resolvePlan() {
    const base = resolveBase({ env: process.env, git })
    if (!base) return { error: 'git could not resolve a usable push base' }
    const changed = splitLines(git(['diff', '--name-only', `${base}...HEAD`]))
    return { plan: selectFastTests(changed, { listTests: listTrackedFiles, findRequirers }) }
}

function printPlan(plan) {
    console.log(`consensus ${plan.consensus ? 1 : 0}`)
    for (const reason of plan.reasons) console.log(`reason ${reason}`)
    for (const test of plan.tests) console.log(`test ${test.group} ${test.file}`)
}

function runPlan(plan) {
    if (plan.tests.length === 0) {
        console.log('ci:fast: no test maps to this push')
        return 0
    }
    let failed = false
    for (const group of GROUPS) {
        const files = plan.tests.filter((test) => test.group === group.name).map((test) => test.file)
        if (files.length === 0) continue
        const result = spawnSync('./node_modules/.bin/mocha', ['--no-config', ...group.args, ...files], {
            stdio: 'inherit',
        })
        if (result.status !== 0) failed = true
    }
    return failed ? 1 : 0
}

function main() {
    const mode = process.argv[2]
    if (mode !== '--plan' && mode !== '--run') {
        console.error('usage: node bin/ci_fast_select.js --plan|--run')
        return 2
    }
    let result
    try {
        result = resolvePlan()
    } catch (error) {
        console.log(`selector-error ${error.message}`)
        return 2
    }
    if (result.error) {
        console.log(`no-base ${result.error}`)
        return 3
    }
    if (mode === '--plan') printPlan(result.plan)
    return mode === '--run' ? runPlan(result.plan) : 0
}

module.exports = { resolveBase, selectFastTests }

if (require.main === module) process.exitCode = main()
