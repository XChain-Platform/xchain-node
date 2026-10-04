'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const ROOT = path.join(__dirname, '..')
const BASE_PATH = path.join(ROOT, '.github/hub-failover/compose.yml')
const OVERRIDE_PATH = path.join(ROOT, '.github/hub-failover/compose.testnet-ids.yml')
const HUBS = ['hub-a', 'hub-b']
const PEER_LIST_KEYS = ['P2P_PEERS', 'SEED_NODES']

function load (file) {
    return fs.readFileSync(file, 'utf8')
}

function indentation (line) {
    return line.length - line.trimStart().length
}

function block (source, header, depth) {
    const lines = source.split('\n')
    const start = lines.indexOf(header)
    assert.notEqual(start, -1, `missing ${header.trim()}`)

    let end = start + 1
    while (end < lines.length && (!lines[end].trim() || indentation(lines[end]) > depth)) end++
    return lines.slice(start, end).join('\n').trimEnd()
}

function keysAt (source, depth) {
    return source.split('\n')
        .filter((line) => indentation(line) === depth && /^[ ]*[A-Za-z0-9_<>&-]+:/.test(line))
        .map((line) => line.trim().split(':', 1)[0])
}

function scalar (source, key) {
    const match = source.match(new RegExp(`^ +${key}: +([^\\n]+)$`, 'm'))
    assert.notEqual(match, null, `missing ${key}`)
    return match[1]
}

function registrations (command) {
    return [...command.matchAll(/'({[^']+"method":"registervalidator"[^']+})'/g)]
        .map((match) => JSON.parse(match[1]))
}

function isUrl (value) {
    try {
        return Boolean(new URL(value).protocol)
    } catch {
        return false
    }
}

test('hub failover testnet identities preserve peer URLs and all other compose settings', () => {
    const base = load(BASE_PATH)
    const override = load(OVERRIDE_PATH)

    assert.deepEqual(keysAt(override, 0), ['services'])
    assert.deepEqual(keysAt(override, 2), [...HUBS, 'hub-federation-init'])

    const validatorIds = new Map()
    for (const hub of HUBS) {
        const baseService = block(base, `  ${hub}:`, 2)
        const overrideService = block(override, `  ${hub}:`, 2)
        const baseEnvironment = block(baseService, '    environment:', 4)
        const overrideEnvironment = block(overrideService, '    environment:', 4)
        assert.deepEqual(keysAt(overrideService, 4), ['environment'])
        assert.deepEqual(keysAt(overrideEnvironment, 6), ['P2P_VALIDATOR_ADDR'])

        const validatorId = scalar(overrideEnvironment, 'P2P_VALIDATOR_ADDR')
        assert.match(validatorId, /^mverify[1-9A-HJ-NP-Za-km-z]+$/)
        assert.equal(isUrl(validatorId), false)
        validatorIds.set(hub, validatorId)

        const peerLists = PEER_LIST_KEYS
            .filter((key) => new RegExp(`^ +${key}:`, 'm').test(baseEnvironment))
            .map((key) => scalar(baseEnvironment, key))
        assert.ok(peerLists.length > 0, `${hub} must keep a peer list`)
        for (const peers of peerLists) {
            for (const peer of peers.split(',')) assert.match(peer, /^wss?:\/\//)
        }
    }
    assert.equal(new Set(validatorIds.values()).size, HUBS.length)

    const baseInit = block(base, '  hub-federation-init:', 2)
    const overrideInit = block(override, '  hub-federation-init:', 2)
    assert.deepEqual(keysAt(overrideInit, 4), ['command'])

    const baseCommand = block(baseInit, '    command:', 4)
    const overrideCommand = block(overrideInit, '    command:', 4)
    const restoredCommand = HUBS.reduce((command, hub) => {
        const baseEnvironment = block(block(base, `  ${hub}:`, 2), '    environment:', 4)
        const url = scalar(baseEnvironment, 'P2P_VALIDATOR_ADDR')
        assert.equal(isUrl(url), true)
        return command.replaceAll(validatorIds.get(hub), url)
    }, overrideCommand)
    assert.equal(restoredCommand, baseCommand)

    const registered = registrations(overrideCommand)
    assert.equal(registered.length, HUBS.length)
    assert.deepEqual(
        registered.map((request) => request.params.addr),
        HUBS.map((hub) => validatorIds.get(hub))
    )

    for (const validatorId of validatorIds.values()) {
        assert.equal(override.split(validatorId).length - 1, 2)
    }
})
