/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'
// Argument and file checks restore-dump makes before it touches anything.

const { expect, path, config, dispatchSettings, SERVICE, DATABASE, COMPLETE_DUMP, makeFile, expectRefusal, harness } = require('./helpers/index.js')

describe('DumpRestoreService', function validationTests() {
    it('classifies restore-dump as a lock-holding mutating command', function () {
        expect(dispatchSettings(config).mutatingCommands).to.include('restore-dump')
    })

    it('refuses a missing file', async function () {
        const h = harness()
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', {
            file: path.join(h.directory, `${DATABASE}.missing.sql.gz`), yes: true
        }), /file not found/)
    })

    it('refuses a file without the .sql.gz suffix', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql`, COMPLETE_DUMP, false)
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /must end in \.sql\.gz/)
    })

    it('refuses a corrupt gzip stream', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`, 'not gzip', false)
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /gzip integrity check failed/)
    })

    it('refuses a gzip whose decompressed tail has no completion marker', async function () {
        const h = harness()
        const file = makeFile(h.directory, `${DATABASE}.stamp.sql.gz`, 'CREATE TABLE blocks (id INT);\n')
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /no final '-- Dump completed' line/)
    })

    it('refuses a dump named for another database', async function () {
        const h = harness()
        const file = makeFile(h.directory, 'XChain_DOGE_Testnet_Indexer.stamp.sql.gz')
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'testnet', { file, yes: true }),
            /expected XChain_BTC_Testnet_Indexer/)
    })

    it('refuses mainnet unless --allow-mainnet is separately present', async function () {
        const h = harness()
        await expectRefusal(h.restoreDump(SERVICE, 'bitcoin', 'mainnet', {
            file: path.join(h.directory, 'unused.sql.gz'), yes: true
        }), /without --allow-mainnet/)
    })
})
