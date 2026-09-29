'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const { resolveBase, selectFastTests } = require('../ci_fast_select')

const ROOT = path.resolve(__dirname, '../..')

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

function listTests() {
    return git(['ls-files']).split(/\r?\n/).filter(Boolean)
}

function findRequirers(basename) {
    const result = spawnSync('git', ['grep', '-l', '--fixed-strings', basename, '--', '*.js'], {
        cwd: ROOT,
        encoding: 'utf8',
    })
    if (result.status === 1) return []
    assert.strictEqual(result.status, 0, result.stderr)
    return result.stdout.split(/\r?\n/).filter(Boolean)
}

function select(changedFiles) {
    const previous = process.cwd()
    process.chdir(ROOT)
    try {
        return selectFastTests(changedFiles, { listTests, findRequirers })
    } finally {
        process.chdir(previous)
    }
}

function files(plan) {
    return plan.tests.map((test) => test.file)
}

function scratchGit(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeScratchFile(cwd, file, source) {
    const target = path.join(cwd, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
}

function scratchCommit(cwd, message, files) {
    scratchGit(cwd, ['add', '--', ...files])
    scratchGit(cwd, [
        '-c', 'user.name=Selector Test',
        '-c', 'user.email=selector-test',
        'commit', '-m', message,
    ])
}

describe('bin/ci_fast_select.js', () => {
    it('maps command_lock to its unit test without widening the suite', () => {
        const plan = select(['src/utils/command_lock.js'])
        assert.strictEqual(plan.consensus, false)
        assert.ok(files(plan).includes('test/unit/command_lock.test.js'))
    })

    it('maps autoheal_service to its unit test family', () => {
        const plan = select(['src/services/autoheal_service.js'])
        assert.strictEqual(plan.consensus, false)
        assert.ok(files(plan).includes('test/unit/autoheal_service.test.js'))
        assert.ok(files(plan).includes('test/unit/autoheal_service.test/01_health_state_guards.test.js'))
    })

    it('widens for the hashes manifest and validator service', () => {
        for (const changed of ['src/github_hashes.json', 'src/services/validator_service.js']) {
            const plan = select([changed])
            assert.strictEqual(plan.consensus, true)
            assert.ok(plan.reasons.some((reason) => reason.includes(changed)))
            assert.deepStrictEqual(plan.tests, [])
        }
    })

    it('widens when a consensus entry point requires the changed module', () => {
        const plan = select(['src/state.js'])
        assert.strictEqual(plan.consensus, true)
        assert.ok(plan.reasons.some((reason) => reason.includes('src/services/bootstrap_service.js')))
    })

    it('selects nothing for documentation alone', () => {
        const plan = select(['README.md'])
        assert.strictEqual(plan.consensus, false)
        assert.deepStrictEqual(plan.tests, [])
        assert.deepStrictEqual(plan.reasons, [])
    })

    it('widens for package metadata', () => {
        const plan = select(['package.json'])
        assert.strictEqual(plan.consensus, true)
        assert.ok(plan.reasons.some((reason) => reason.includes('package.json')))
    })

    it('defers a changed integration test instead of selecting it', () => {
        const changed = 'test/integration/config_pipeline.test.js'
        const plan = select([changed])
        assert.strictEqual(plan.consensus, false)
        assert.deepStrictEqual(plan.tests, [])
        assert.ok(plan.reasons.includes(`deferred: ${changed}`))
    })

    it('returns null when neither requested nor fallback base resolves', () => {
        const rejectingGit = () => { throw new Error('unknown revision') }
        assert.strictEqual(resolveBase({
            env: { PROM_CI_BASE_SHA: 'missing' },
            git: rejectingGit,
        }), null)
    })

    it('returns the requested base when git accepts it as a commit', () => {
        const calls = []
        const acceptingGit = (args) => {
            calls.push(args)
            assert.deepStrictEqual(args, ['cat-file', '-e', 'abc123^{commit}'])
            return ''
        }
        assert.strictEqual(resolveBase({
            env: { PROM_CI_BASE_SHA: 'abc123' },
            git: acceptingGit,
        }), 'abc123')
        assert.strictEqual(calls.length, 1)
    })

    it('falls back to the develop merge base after a stale requested base', () => {
        const fallbackGit = (args) => {
            if (args[0] === 'cat-file') throw new Error('stale')
            assert.deepStrictEqual(args, ['merge-base', 'HEAD', 'origin/develop'])
            return 'def456\n'
        }
        assert.strictEqual(resolveBase({
            env: { PROM_CI_BASE_SHA: 'stale' },
            git: fallbackGit,
        }), 'def456')
    })

    it('keeps the fast selector guarded and the original strict ci tier available', () => {
        const script = fs.readFileSync(path.join(ROOT, 'bin/ci-full.sh'), 'utf8')
        assert.ok(script.includes('ci_fast_select.js --plan'))
        assert.match(script, /CI_TIER:-full[^\n]+fast[\s\S]+ci_fast_select\.js --plan/)
        assert.ok(script.includes('run_tier "ci" env XCHAIN_REQUIRE_SIBLINGS=1 npm run ci'))
    })

    it('replays develop history, compares narrowing, and checks required selections', () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fast-select-replay-'))
        try {
            scratchGit(cwd, ['init', '--initial-branch=develop'])
            const initial = {
                'src/coins/rule.js': "module.exports = 'rule'\n",
                'src/feature/plain.js': "module.exports = 'plain'\n",
                'test/unit/coins/rule.test.js': "require('../../../src/coins/rule')\n",
                'test/unit/feature/plain.test.js': "require('../../../src/feature/plain')\n",
                'test/unit/only.test.js': "module.exports = 'only'\n",
                'test/unit/other/unrelated.test.js': "module.exports = 'unrelated'\n",
            }
            for (const [file, source] of Object.entries(initial)) {
                writeScratchFile(cwd, file, source)
            }
            scratchCommit(cwd, 'initial files', Object.keys(initial))

            const consensusFile = 'src/coins/rule.js'
            fs.appendFileSync(path.join(cwd, consensusFile), "module.exports += ' changed'\n")
            scratchCommit(cwd, 'consensus change', [consensusFile])

            const plainFile = 'src/feature/plain.js'
            fs.appendFileSync(path.join(cwd, plainFile), "module.exports += ' changed'\n")
            scratchCommit(cwd, 'plain source change', [plainFile])

            const testFile = 'test/unit/only.test.js'
            fs.appendFileSync(path.join(cwd, testFile), "module.exports += ' changed'\n")
            scratchCommit(cwd, 'test only change', [testFile])
            scratchGit(cwd, ['update-ref', 'refs/remotes/origin/develop', 'HEAD'])

            const selector = path.resolve(__dirname, '../ci_fast_select.js')
            const mustSelect = [
                'src/coins/rule.js:test/unit/coins/rule.test.js',
                'src/feature/plain.js:test/unit/other/unrelated.test.js',
            ].join(',')
            const result = spawnSync(process.execPath, [
                selector,
                '--replay', '3',
                '--narrow', 'src/coins/',
                '--must-select', mustSelect,
            ], { cwd, encoding: 'utf8' })

            assert.strictEqual(result.status, 1, result.stderr)
            const lines = result.stdout.trim().split(/\r?\n/)
            assert.ok(lines.includes('plan commits consensus-1 changed-tests test-only no-tests'))
            assert.ok(lines.includes('current 3 1/3 1/3 1/3 0/3'))
            assert.ok(lines.includes('narrowed 3 0/3 2/3 1/3 0/3'))
            assert.ok(lines.includes(
                'must-select PASS src/coins/rule.js:test/unit/coins/rule.test.js'))
            assert.ok(lines.includes(
                'must-select FAIL src/feature/plain.js:test/unit/other/unrelated.test.js'))
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true })
        }
    })
})
