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

function consensusReasons(changedFiles, sourceData, consensusPrefixes) {
    const reasons = []
    for (const file of changedFiles) {
        if (file === 'package.json' || startsWithAny(file, consensusPrefixes) || startsWithAny(file, WIDEN)) {
            reasons.push(`consensus: ${file}`)
        }
    }
    for (const { file, requirers } of sourceData) {
        for (const importer of requirers) {
            if (startsWithAny(importer, consensusPrefixes) && requiresFile(importer, file)) {
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

function selectFastTests(
    changedFiles,
    { listTests, findRequirers },
    { consensusPrefixes = CONSENSUS } = {},
) {
    const changed = splitLines(changedFiles)
    const tests = splitLines(listTests()).filter((file) => groupFor(file) && fs.existsSync(file))
    const sources = changed.filter((file) => file.startsWith('src/') && file.endsWith('.js'))
    const sourceData = collectSourceData(sources, findRequirers)
    const reasons = consensusReasons(changed, sourceData, consensusPrefixes)
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

function selectionDependencies({ indexed = false } = {}) {
    const files = listTrackedFiles()
    if (indexed) {
        const sources = files
            .filter((file) => file.endsWith('.js') && fs.existsSync(file))
            .map((file) => [file, sourceText(file)])
        const cache = new Map()
        return {
            listTests: () => files,
            findRequirers: (basename) => {
                if (!cache.has(basename)) {
                    cache.set(basename, sources
                        .filter(([, source]) => source.includes(basename))
                        .map(([file]) => file))
                }
                return cache.get(basename)
            },
        }
    }
    return { listTests: () => files, findRequirers }
}

function withoutConsensusPrefixes(prefixes) {
    const removed = new Set(prefixes.flatMap((prefix) => {
        const trimmed = prefix.trim()
        if (!trimmed) return []
        return [trimmed, trimmed.endsWith('/') ? trimmed.slice(0, -1) : `${trimmed}/`]
    }))
    return CONSENSUS.filter((prefix) => !removed.has(prefix))
}

function changedFilesForCommit(commit) {
    const revision = splitLines(git(['rev-list', '--parents', '-n', '1', commit]))[0]
    const [, parent] = revision.split(' ')
    if (parent) return splitLines(git(['diff', '--name-only', `${parent}..${commit}`]))
    return splitLines(git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit]))
}

function emptyReplayCounts() {
    return { wholeUnit: 0, changedTests: 0, testOnly: 0, noTests: 0 }
}

function countReplayPlan(counts, changed, plan) {
    if (plan.consensus) {
        counts.wholeUnit++
    } else if (plan.tests.length && changed.every((file) => file.startsWith('test/'))) {
        counts.testOnly++
    } else if (plan.tests.length) {
        counts.changedTests++
    } else {
        counts.noTests++
    }
}

function replayPlans(limit, narrowPrefixes) {
    const commits = splitLines(git([
        'log', '--first-parent', '-n', String(limit), '--format=%H', 'origin/develop',
    ]))
    const current = emptyReplayCounts()
    const narrowed = emptyReplayCounts()
    const consensusPrefixes = withoutConsensusPrefixes(narrowPrefixes)
    const dependencies = selectionDependencies({ indexed: true })
    for (const commit of commits) {
        const changed = changedFilesForCommit(commit)
        countReplayPlan(current, changed, selectFastTests(changed, dependencies))
        countReplayPlan(narrowed, changed, selectFastTests(changed, dependencies, {
            consensusPrefixes,
        }))
    }
    return { commits, current, narrowed, consensusPrefixes, dependencies }
}

function fraction(value, total) {
    return `${value}/${total}`
}

function printReplayRow(name, total, counts) {
    console.log([
        name,
        total,
        fraction(counts.wholeUnit, total),
        fraction(counts.changedTests, total),
        fraction(counts.testOnly, total),
        fraction(counts.noTests, total),
    ].join(' '))
}

function parseList(value) {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseMustSelect(value) {
    return parseList(value).map((pair) => {
        const separator = pair.indexOf(':')
        if (separator <= 0 || separator === pair.length - 1) {
            throw new Error(`invalid --must-select pair: ${pair}`)
        }
        return { source: pair.slice(0, separator), test: pair.slice(separator + 1) }
    })
}

function replayOptions(args) {
    const limit = Number(args[0])
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('--replay requires a positive integer')
    }
    const options = { limit, narrowPrefixes: [], mustSelect: [] }
    for (let index = 1; index < args.length; index += 2) {
        const flag = args[index]
        const value = args[index + 1]
        if (!value || (flag !== '--narrow' && flag !== '--must-select')) {
            throw new Error(`invalid replay option: ${flag || ''}`.trim())
        }
        if (flag === '--narrow') options.narrowPrefixes.push(...parseList(value))
        else options.mustSelect.push(...parseMustSelect(value))
    }
    return options
}

function runReplay(args) {
    try {
        const options = replayOptions(args)
        const result = replayPlans(options.limit, options.narrowPrefixes)
        console.log('plan commits consensus-1 changed-tests test-only no-tests')
        printReplayRow('current', result.commits.length, result.current)
        if (options.narrowPrefixes.length) {
            printReplayRow('narrowed', result.commits.length, result.narrowed)
        }
        let failed = false
        for (const pair of options.mustSelect) {
            const plan = selectFastTests([pair.source], result.dependencies, {
                consensusPrefixes: result.consensusPrefixes,
            })
            const selected = plan.tests.some((test) => test.file === pair.test)
            console.log(`must-select ${selected ? 'PASS' : 'FAIL'} ${pair.source}:${pair.test}`)
            if (!selected) failed = true
        }
        return failed ? 1 : 0
    } catch (error) {
        console.error(`replay-error ${error.message}`)
        return 2
    }
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
    if (mode === '--replay') return runReplay(process.argv.slice(3))
    if (mode !== '--plan' && mode !== '--run') {
        console.error('usage: node bin/ci_fast_select.js --plan|--run|--replay N ' +
            '[--narrow prefix,...] [--must-select file:testfile,...]')
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

module.exports = { replayPlans, resolveBase, selectFastTests }

if (require.main === module) process.exitCode = main()
