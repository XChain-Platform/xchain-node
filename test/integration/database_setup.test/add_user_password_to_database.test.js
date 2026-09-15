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

const { expect } = require('chai')

const { DB_MODULE_NAME } = require('../../../src/config')
const { databaseSuite } = require('./support/fixture')

databaseSuite('addUserPasswordToDatabase', function (fixture) {

    it('creates database, user, and grants for decoder', async function () {
        const { env, capture, fakeContainerId, makeDatabaseService } = fixture()
        const dbContainerId = fakeContainerId('d')
        const decoderId = fakeContainerId('e')
        await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)
        await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decoderId)

        env.writeConfigFile('bitcoin-mainnet', '')

        // containerExists: addUserPasswordToDatabase's preCheckContainerId
        // guard (DatabaseService.js ~L489) requires getDatabaseContainerId()
        // to resolve the already-installed database, unlike the fresh-install
        // test above.
        const { DatabaseService } = makeDatabaseService({ dbContainerId, containerExists: true })

        await DatabaseService.addUserPasswordToDatabase(
            'xchain-decoder', 'bitcoin', 'mainnet',
            'XChain_BTC_Mainnet_Decoder',
            'xchain_decoder_bitcoin_mainnet',
            'xchain-password'
        )

        capture.assertCalled(/CREATE DATABASE IF NOT EXISTS XChain_BTC_Mainnet_Decoder/)

        const createUserCmds = capture.findCommands(/CREATE USER/)
        expect(createUserCmds).to.have.length(1)
        expect(createUserCmds[0].command).to.include('xchain_decoder_bitcoin_mainnet')
        // Host is unconditionally '%' (4cc107e, predates the argv fix under
        // test), not a per-network gateway-derived subnet: gateway-scoped
        // hosts block shared services on a different docker
        // network (e.g. the explorer) from reaching a per-coin DB.
        expect(createUserCmds[0].command).to.include("'%'")

        capture.assertCalled(/GRANT ALL PRIVILEGES ON XChain_BTC_Mainnet_Decoder/)
        capture.assertCalled(/FLUSH PRIVILEGES/)
    })
})

databaseSuite('addUserPasswordToDatabase', function (fixture) {

    // Renamed in spirit from its original "gateway-derived subnet" premise:
    // 4cc107e replaced the per-network subnet host with a universal '%' so
    // cross-network shared services could reach per-coin DBs, so a
    // different-than-usual gateway (172.20.x here vs. 172.18.x above) now
    // has to produce the SAME '%' host, not a different subnet. This is a
    // regression guard against reintroducing gateway-derived hosts, not a
    // test of gateway derivation (which no longer exists).
    it('uses "%" as the grant host regardless of the Docker network gateway', async function () {
        const { env, capture, fakeContainerId, makeDatabaseService } = fixture()
        const dbContainerId = fakeContainerId('d')
        const decoderId = fakeContainerId('e')
        await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)
        await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decoderId)
        env.writeConfigFile('bitcoin-mainnet', '')

        // Same preCheckContainerId requirement as the test above: resolve
        // the already-installed database container via `docker inspect
        // --type container --format {{.Id}}`.
        capture.when(/docker inspect --type container --format/).returns({ stdout: dbContainerId + '\n' })

        // See makeDatabaseService's identical comment above: DatabaseService
        // logs through redactSecrets(), so a bare `{ sleep }` mock throws
        // "redactSecrets is not a function" once code reaches a log line.
        const { DatabaseService } = makeDatabaseService({
            dbContainerId,
            containerExists: true,
            gateway: '172.20.0.1'
        })

        const state = require('../../../src/state')
        state.setDbRootPassword('testrootpw')

        await DatabaseService.addUserPasswordToDatabase(
            'xchain-decoder', 'bitcoin', 'mainnet',
            'XChain_BTC_Mainnet_Decoder',
            'xchain_decoder_bitcoin_mainnet',
            'xchain-password'
        )

        const createUserCmds = capture.findCommands(/CREATE USER/)
        expect(createUserCmds[0].command).to.include("'%'")
    })
})
