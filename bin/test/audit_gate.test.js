'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const GATE = path.join(ROOT, 'bin', 'audit_gate.js')
const REPORT = path.join(ROOT, 'test', 'fixtures', 'npm_audit_omit_dev.json')
const ACCEPT = path.join(ROOT, 'test', 'fixtures', 'audit_exceptions_accept.md')
const REJECT = path.join(ROOT, 'test', 'fixtures', 'audit_exceptions_reject.md')

function gate(args, input) {
    return spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8', input })
}

describe('audit gate', function () {
    it('accepts the elliptic advisory through the repo-root ledger', function () {
        const r = gate(['--input', REPORT])
        assert.strictEqual(r.status, 0, r.stderr)
    })

    it('reads the report from standard input when --input is -', function () {
        const accepted = gate(['--input', '-', '--exceptions', ACCEPT], fs.readFileSync(REPORT, 'utf8'))
        assert.strictEqual(accepted.status, 0, accepted.stderr)
        const rejected = gate(['--input', '-', '--exceptions', REJECT], fs.readFileSync(REPORT, 'utf8'))
        assert.strictEqual(rejected.status, 1)
        assert.match(rejected.stderr, /elliptic/)
    })

    it('exits 0 when the elliptic advisory is accepted', function () {
        const r = gate(['--input', REPORT, '--exceptions', ACCEPT])
        assert.strictEqual(r.status, 0, r.stderr)
    })

    it('accepts the flags in either order', function () {
        const r = gate(['--exceptions', ACCEPT, '--input', REPORT])
        assert.strictEqual(r.status, 0, r.stderr)
    })

    it('exits 1 naming elliptic when the ledger does not accept it', function () {
        const r = gate(['--input', REPORT, '--exceptions', REJECT])
        assert.strictEqual(r.status, 1)
        assert.match(r.stderr, /elliptic/)
        assert.match(r.stderr, /GHSA-848j-6mx2-7j84/i)
    })

    it('exits 2 for an unknown flag', function () {
        assert.strictEqual(gate(['--input', REPORT, '--bogus']).status, 2)
    })

    it('exits 2 for a repeated --exceptions', function () {
        const r = gate(['--input', REPORT, '--exceptions', ACCEPT, '--exceptions', ACCEPT])
        assert.strictEqual(r.status, 2)
    })

    it('exits 2 for a repeated --input', function () {
        assert.strictEqual(gate(['--input', REPORT, '--input', REPORT]).status, 2)
    })

    it('exits 2 for an unreadable input', function () {
        assert.strictEqual(gate(['--input', path.join(ROOT, 'tmp', 'no-such-report.json')]).status, 2)
    })

    it('exits 2 for a report whose auditReportVersion is not 2', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'))
        try {
            const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
            report.auditReportVersion = 1
            const file = path.join(dir, 'report.json')
            fs.writeFileSync(file, JSON.stringify(report))
            assert.strictEqual(gate(['--input', file, '--exceptions', ACCEPT]).status, 2)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
