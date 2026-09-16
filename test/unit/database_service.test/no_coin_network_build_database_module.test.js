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

const { sinon, expect, VALID_CONTAINER_ID, fakeSpawn, mariadbAttempts, makeStubs, loadDatabaseService } = require('./helpers/harness')

describe('DatabaseService', function () {

        describe('buildDatabaseModule(): no coin/network', function () {

        it('returns true without network join when coin+network are empty', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            // Pass empty coin/network so the addContainerToNetwork branch is skipped
            const result = await ds.buildDatabaseModule('', '')
            expect(result).to.be.true
            expect(stubs.addContainerToNetwork.called).to.be.false
        })

        it('throws string error when addContainerToNetwork fails on existing container', async function () {
            const stubs = makeStubs()
            stubs.addContainerToNetwork.rejects(new Error('network unavailable'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
                expect.fail('should have thrown')
            } catch (err) {
                // Source throws a plain string, not an Error object
                expect(err).to.include('There was a problem trying to add the db container to the network')
            }
        })

        it('appends DB data dir volume mount when XCHAIN_NODE_DB_DATA_DIR is set', async function () {
            const saved = process.env.XCHAIN_NODE_DB_DATA_DIR
            process.env.XCHAIN_NODE_DB_DATA_DIR = '/mnt/nvme/mysql'
            try {
                const stubs = makeStubs()
                stubs.execFileAsync
                    .onFirstCall().rejects(new Error('No such container')) // getDatabaseContainerId
                    .resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runCall = stubs.execFileAsync.getCalls().find(c =>
                    c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
                expect(runCall, 'docker run call not found').to.exist
                const args = runCall.args[1]
                const vIdx = args.indexOf('-v')
                expect(vIdx).to.be.greaterThan(-1)
                expect(args[vIdx + 1]).to.equal('/mnt/nvme/mysql:/var/lib/mysql')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_DATA_DIR
                else process.env.XCHAIN_NODE_DB_DATA_DIR = saved
            }
        })
        })
})
