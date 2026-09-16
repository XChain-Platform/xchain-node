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

const { DB_MODULE_NAME } = require('../../src/config')
const { databaseSuite } = require('./database_setup.test/support/fixture')

databaseSuite('buildDatabaseModule (first install)', function (fixture) {

    it('pulls mariadb, tags it, and runs container', async function () {
        const { env, capture, makeDatabaseService } = fixture()
        const { DatabaseService, dbContainerId } = makeDatabaseService()
        env.writeConfigFile('bitcoin-mainnet', '')

        const result = await DatabaseService.buildDatabaseModule('bitcoin', 'mainnet')

        // Pin tracks src/services/database_service.js's actual `docker pull`/
        // `docker tag` target; the image tag itself is not a secret.
        capture.assertCalled(/docker pull mariadb:10.11/)
        capture.assertCalled(/docker tag mariadb:10.11 xchain-node-database/)

        const runCmds = capture.findCommands(/docker run/)
        expect(runCmds).to.have.length(1)
        const runCmd = runCmds[0].command
        const runEnv = runCmds[0].options.env
        expect(runCmd).to.include('--hostname mariadb')
        // MYSQL_ROOT_PASSWORD is a live secret. It is passed by NAME on
        // the docker run command line; its VALUE travels only through
        // execFile's `env` option (3b0c5fa), so it must never appear in
        // argv (a failed `docker run` would otherwise leak it via
        // err.cmd/err.message into upstream logging).
        expect(runCmd).to.include('--env MYSQL_ROOT_PASSWORD')
        expect(runCmd).to.not.include('MYSQL_ROOT_PASSWORD=testrootpw')
        expect(runEnv.MYSQL_ROOT_PASSWORD).to.equal('testrootpw')
        expect(runCmd).to.include('xchain-node-database')

        // What the install branch owes its caller is the new container id;
        // every downstream provisioning step keys off that return value.
        expect(result).to.equal(dbContainerId)

        // It does NOT write a `modules` registry row: that table lives
        // inside the container this branch creates, so it doesn't exist
        // yet. Lookups use DatabaseService.getDatabaseContainerId()
        // (docker inspect by name) instead.
        const state = require('../../src/state')
        const storedId = await state.db.getModuleContainer(DB_MODULE_NAME, '', '')
        expect(storedId).to.equal(null)
    })
})

databaseSuite('buildDatabaseModule (first install)', function (fixture) {

    it('includes network flag when coin/network are provided', async function () {
        const { env, capture, makeDatabaseService } = fixture()
        const { DatabaseService } = makeDatabaseService()
        env.writeConfigFile('bitcoin-mainnet', '')

        await DatabaseService.buildDatabaseModule('bitcoin', 'mainnet')

        const runCmd = capture.findCommands(/docker run/)[0].command
        expect(runCmd).to.include('--network xchain-node-bitcoin-mainnet')
    })
})
