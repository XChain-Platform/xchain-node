'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// The state file carries the restart cooldown, the backoff counts, the escalation
// history and the stopped-container flags. A torn write or a silent reset of it
// re-arms every one of them at once.
let dir, file, warn, restartState

function prepareStateFileTest() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-state-'))
    file = path.join(dir, 'autoheal-state.json')
    warn = sinon.stub()
    restartState = proxyquire('../../../src/services/autoheal_service/restart_state', {
        '../../observability/logger': { getLogger: () => ({ warn, info: sinon.stub(), error: sinon.stub() }) }
    })
}

function cleanUpStateFileTest() {
    sinon.restore()
    fs.rmSync(dir, { recursive: true, force: true })
}

function asideFiles() {
    return fs.readdirSync(dir).filter(n => n.includes('.corrupt-'))
}

function defineStateFileReadTests() {

    it('reads a missing state file as empty without a warning', () => {
        const state = restartState.readState(file)
        expect(state).to.deep.equal({ restarts: {}, unhealthySince: {}, restartCount: {}, stoppedByAutoheal: {} })
        expect(warn.called).to.equal(false)
    })

    it('warns and keeps a truncated state file aside instead of silently resetting it', () => {
        const torn = '{\n  "restarts": { "abc": 1760000000000 },\n  "restartCount": { "abc": 3'
        fs.writeFileSync(file, torn)

        const state = restartState.readState(file)

        expect(state.restarts).to.deep.equal({})
        expect(state.restartCount).to.deep.equal({})
        expect(warn.calledOnce).to.equal(true)
        expect(warn.firstCall.args[0]).to.include(file).and.to.include('unreadable')
        expect(fs.existsSync(file)).to.equal(false)
        const aside = asideFiles()
        expect(aside).to.have.length(1)
        expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).to.equal(torn)
    })

    it('warns on a zero-byte state file and on a document with no restarts map', () => {
        const zeroByte = ''
        const noRestarts = JSON.stringify({ unhealthySince: { abc: 1 } })
        sinon.useFakeTimers({ now: new Date('2026-11-16T12:34:56.789Z') })

        fs.writeFileSync(file, zeroByte)
        restartState.readState(file)
        fs.writeFileSync(file, noRestarts)
        restartState.readState(file)

        expect(warn.callCount).to.equal(2)
        const aside = asideFiles()
        expect(aside).to.have.length(2)
        expect(aside.map(name => fs.readFileSync(path.join(dir, name), 'utf8')))
            .to.have.members([zeroByte, noRestarts])
    })

    it('reads an intact state file back without a warning or an aside copy', () => {
        const saved = { restarts: { abc: 5 }, unhealthySince: { abc: 4 }, restartCount: { abc: 2 }, stoppedByAutoheal: { abc: true } }
        fs.writeFileSync(file, JSON.stringify(saved))
        expect(restartState.readState(file)).to.deep.equal(saved)
        expect(warn.called).to.equal(false)
        expect(asideFiles()).to.have.length(0)
    })
}

function defineStateFileWriteTests() {
    it('writes through a sibling temp file renamed over the live path, never onto it', () => {
        fs.writeFileSync(file, JSON.stringify({ restarts: { old: 1 } }))
        const write = sinon.spy(fs, 'writeFileSync')
        const rename = sinon.spy(fs, 'renameSync')

        restartState.writeState(file, { restarts: { abc: 9 }, unhealthySince: {}, restartCount: {}, stoppedByAutoheal: {} })

        expect(write.args.map(a => a[0])).to.not.include(file)
        expect(rename.calledOnce).to.equal(true)
        expect(rename.firstCall.args[1]).to.equal(file)
        expect(path.dirname(rename.firstCall.args[0])).to.equal(dir)
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).restarts).to.deep.equal({ abc: 9 })
        expect(fs.readdirSync(dir)).to.deep.equal(['autoheal-state.json'])
    })

    it('leaves the previous state and no temp file behind when the rename fails', () => {
        const blocked = path.join(dir, 'blocked')
        fs.mkdirSync(blocked)
        fs.writeFileSync(path.join(blocked, 'keep'), 'x')

        expect(() => restartState.writeState(blocked, { restarts: {} })).to.throw()

        expect(fs.readdirSync(dir)).to.deep.equal(['blocked'])
    })
}

function defineStateFileIntegrityTests() {
    beforeEach(prepareStateFileTest)
    afterEach(cleanUpStateFileTest)
    defineStateFileReadTests()
    defineStateFileWriteTests()
}

describe('autoheal restart state file integrity', defineStateFileIntegrityTests)
