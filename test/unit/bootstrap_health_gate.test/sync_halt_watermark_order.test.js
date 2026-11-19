'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    XChainService,
    callGate,
    expect,
    installEnvironmentHooks,
    loadGate,
    makeRunner,
    refusal,
    sinon
} = require('./support/bootstrap_health_gate')

function sqlFrom(args) {
    return args[args.lastIndexOf('-e') + 1] || ''
}

function statefulRunner(insertAfter) {
    const base = makeRunner()
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, cleared: true }))
    let inserted = false
    const insert = () => {
        if (!inserted) rows.push({ id: 51, cleared: false })
        inserted = true
    }
    const runner = sinon.stub().callsFake(async (cmd, args) => {
        const sql = sqlFrom(args)
        if (/COALESCE\(MAX\(id\),0\) FROM `[^`]+`\.sync_halt/.test(sql)) {
            const answer = Math.max(...rows.map(row => row.id))
            if (insertAfter === 'watermark') insert()
            return { stdout: String(answer) }
        }
        if (/sync_halt WHERE id > (\d+)/.test(sql)) {
            const floor = Number(sql.match(/sync_halt WHERE id > (\d+)/)[1])
            return { stdout: String(rows.filter(row => row.id > floor).length) }
        }
        if (/sync_halt WHERE cleared_at IS NULL/.test(sql)) {
            const answer = rows.filter(row => !row.cleared).length
            if (insertAfter === 'live') insert()
            return { stdout: String(answer) }
        }
        return base(cmd, args)
    })
    return { runner, rows }
}

describe('BootstrapHealthGate sync_halt watermark order', function () {
    installEnvironmentHooks()

    it('catches a halt inserted after preflight live count and cleared during the dump', async function () {
        const gate = loadGate()
        const state = statefulRunner('live')
        const before = await callGate(gate, { runner: state.runner })
        state.rows.find(row => row.id === 51).cleared = true
        const err = await refusal(callGate(gate, {
            runner: state.runner,
            since: before.watermark
        }))
        expect(err.message).to.match(/divergence halt .* was raised while the dump was streaming/)
    })

    it('refuses a halt inserted after the watermark because the later live count sees it', async function () {
        const gate = loadGate()
        const state = statefulRunner('watermark')
        const err = await refusal(callGate(gate, { runner: state.runner }))
        expect(err.message).to.match(/uncleared xchain-sync divergence halt/)
    })

    it('reads both watermarks before the live sync_halt count for each probed database', async function () {
        const gate = loadGate()
        const base = makeRunner()
        const sqls = []
        const runner = sinon.stub().callsFake((cmd, args) => {
            sqls.push(sqlFrom(args))
            return base(cmd, args)
        })
        await callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner })
        const liveIndexes = sqls.flatMap((sql, index) =>
            /sync_halt WHERE cleared_at IS NULL/.test(sql) ? [index] : [])
        expect(liveIndexes).to.have.length(2)
        for (const liveIndex of liveIndexes) {
            const dbName = sqls[liveIndex].match(/FROM `([^`]+)`\.sync_halt/)[1]
            const before = sqls.slice(0, liveIndex)
            expect(before.some(sql => sql.includes('MAX(id)') && sql.includes(`\`${dbName}\`.sync_halt`)))
                .to.equal(true)
            expect(before.some(sql => sql.includes('MAX(id)') && sql.includes(`\`${dbName}\`.events`)))
                .to.equal(true)
        }
    })
})
