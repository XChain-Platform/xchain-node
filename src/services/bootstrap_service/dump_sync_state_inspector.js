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
 * Inspect sync_state rows in a plaintext MariaDB dump before publishing.
 ********************************************************************/

'use strict'

const { Writable } = require('stream')
const { TextDecoder } = require('util')
const { syncStateDumpPrefixes } = require('../../db/dump_syntax')
const { isValidRollbackGuardState } = require('../bootstrap_health_gate/halt_markers')

const { create: CREATE_PREFIX, insert: INSERT_PREFIX } = syncStateDumpPrefixes()
const EXPECTED_COLUMNS = ['state_key', 'state_value', 'updated_at']
const DEFAULT_LIMIT = 16 * 1024 * 1024

function startsWith(buffer, prefix) {
    return buffer.length <= prefix.length
        ? prefix.subarray(0, buffer.length).equals(buffer)
        : buffer.subarray(0, prefix.length).equals(prefix)
}

function decode(bytes) {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes))
}

function parseQuoted(buffer, state) {
    const out = []
    state.at++
    while (state.at < buffer.length) {
        const byte = buffer[state.at++]
        if (byte === 0x27) return Buffer.from(out)
        if (byte !== 0x5c) {
            out.push(byte)
            continue
        }
        if (state.at >= buffer.length) throw new Error('truncated escape')
        const escaped = buffer[state.at++]
        const mapped = new Map([
            [0x30, 0x00], [0x27, 0x27], [0x22, 0x22], [0x62, 0x08],
            [0x6e, 0x0a], [0x72, 0x0d], [0x74, 0x09], [0x5a, 0x1a], [0x5c, 0x5c]
        ]).get(escaped)
        if (mapped === undefined) throw new Error(`unknown escape 0x${escaped.toString(16)}`)
        out.push(mapped)
    }
    throw new Error('truncated quoted value')
}

function parseValue(buffer, state) {
    if (buffer[state.at] === 0x27) return parseQuoted(buffer, state)
    if (buffer.subarray(state.at, state.at + 4).toString('ascii') === 'NULL') {
        state.at += 4
        return null
    }
    throw new Error('expected a quoted value or NULL')
}

function parseTuples(line) {
    const buffer = line.subarray(INSERT_PREFIX.length)
    const state = { at: 0 }
    const rows = []
    while (state.at < buffer.length) {
        if (buffer[state.at++] !== 0x28) throw new Error('expected tuple start')
        const fields = []
        for (let index = 0; index < 3; index++) {
            fields.push(parseValue(buffer, state))
            if (index < 2 && buffer[state.at++] !== 0x2c) throw new Error('expected field separator')
        }
        if (buffer[state.at++] !== 0x29) throw new Error('expected tuple end')
        rows.push(fields)
        if (buffer[state.at] === 0x3b) {
            state.at++
            break
        }
        if (buffer[state.at++] !== 0x2c) throw new Error('expected tuple separator')
    }
    if (state.at !== buffer.length) throw new Error('unexpected bytes after INSERT')
    return rows
}

class SyncStateInspector extends Writable {
    constructor(byteLimit) {
        super({
            write: (...args) => this.writeChunk(...args),
            final: callback => this.finalize(callback)
        })
        this.byteLimit = byteLimit
        this.verdict = { pendingHalt: 0, rollbackGuardInvalid: 0, unreadable: [] }
        this.line = []
        this.mode = 'undecided'
        this.collectingCreate = false
        this.createBytes = []
        this.sawCreate = false
        this.collected = 0
    }

    fail(detail) {
        this.verdict.unreadable.push(detail)
    }

    account(bytes) {
        this.collected += bytes.length
        if (this.collected > this.byteLimit)
            throw new Error(`sync_state dump data exceeds ${this.byteLimit} bytes`)
    }

    validateCreate() {
        const text = Buffer.concat(this.createBytes).toString('utf8')
        const columns = text.split('\n').flatMap(entry => {
            const match = entry.match(/^\s*`([^`]+)`\s+/)
            return match ? [match[1]] : []
        })
        if (columns.length !== 3 || columns.some((name, index) => name !== EXPECTED_COLUMNS[index]))
            this.fail(`sync_state columns are ${columns.join(',') || 'unreadable'}, expected ${EXPECTED_COLUMNS.join(',')}`)
        this.sawCreate = this.verdict.unreadable.length === 0
        this.collectingCreate = false
        this.createBytes = []
    }

    inspectInsert(bytes) {
        if (!this.sawCreate) {
            this.fail('sync_state INSERT appeared without a readable CREATE TABLE')
            return
        }
        try {
            for (const [keyBytes, valueBytes] of parseTuples(bytes)) {
                const key = decode(keyBytes).toLowerCase()
                const value = valueBytes === null ? null : decode(valueBytes)
                if (key.startsWith('halt_pending:') && value !== null && value.length > 0)
                    this.verdict.pendingHalt++
                if (key.startsWith('rollback_guard:') && value !== null && !isValidRollbackGuardState(value))
                    this.verdict.rollbackGuardInvalid++
            }
        } catch (err) {
            this.fail(`could not parse sync_state INSERT: ${err.message}`)
        }
    }

    finishLine() {
        const bytes = Buffer.from(this.line)
        if (this.collectingCreate || this.mode === 'create') {
            this.account(bytes)
            this.createBytes.push(bytes, Buffer.from('\n'))
            this.collectingCreate = true
            if (/^\) ENGINE=.*;\s*$/.test(bytes.toString('utf8'))) this.validateCreate()
        } else if (this.mode === 'insert') {
            this.account(bytes)
            this.inspectInsert(bytes)
        }
        this.line = []
        this.mode = 'undecided'
    }

    writeChunk(chunk, encoding, callback) {
        try {
            for (const byte of chunk) {
                if (byte === 0x0a) {
                    this.finishLine()
                    continue
                }
                if (this.mode === 'skip') continue
                this.line.push(byte)
                if (this.mode === 'undecided') this.classifyLine()
            }
            callback()
        } catch (err) {
            this.fail(err.message)
            callback()
        }
    }

    classifyLine() {
        const probe = Buffer.from(this.line)
        if (startsWith(probe, CREATE_PREFIX)) {
            if (probe.length >= CREATE_PREFIX.length) this.mode = 'create'
        } else if (startsWith(probe, INSERT_PREFIX)) {
            if (probe.length >= INSERT_PREFIX.length) this.mode = 'insert'
        } else if (!this.collectingCreate) {
            this.mode = 'skip'
            this.line = []
        } else {
            this.mode = 'create'
        }
    }

    finalize(callback) {
        if (this.line.length > 0) this.finishLine()
        if (this.collectingCreate) this.fail('dump ended inside sync_state CREATE TABLE')
        callback()
    }

    getVerdict() {
        return {
            pendingHalt: this.verdict.pendingHalt,
            rollbackGuardInvalid: this.verdict.rollbackGuardInvalid,
            unreadable: [...this.verdict.unreadable]
        }
    }
}

function createDumpSyncStateInspector({ byteLimit = DEFAULT_LIMIT } = {}) {
    return new SyncStateInspector(byteLimit)
}

module.exports = { createDumpSyncStateInspector }
