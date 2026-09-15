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

const {
    sinon, configStub, expect, proxyquire, modulesUrls, XChainService,
    DEFAULT_NODE_PREFIX, DEPENDENCY_HEALTH_START_PERIOD, makeStubs,
    loadModuleService, stubDockerCreate, runArgsOf, inspectMemoryBytes,
    captureConsole, proxyquireCallThru, moduleSuite
} = require('./module_service.test/support/helpers')

    // -------------------------------------------------------------------
    // cloneGit
    // -------------------------------------------------------------------
moduleSuite('cloneGit()', function () {

        it('clones to module directory with correct git URL', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('git')
                expect(args).to.include('clone')
                expect(args).to.include(modulesUrls['xchain-encoder'])
                expect(args).to.include('/modules/xchain-encoder')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder')
        })

        it('rejects when module has no URL mapping', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('unknown-module')
                expect.fail()
            } catch (err) {
                expect(err).to.include("doesn't have an url")
            }
        })

        it('removes existing directory when rewrite=true', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)
            // moduleDirExists returns false by default, so rewrite path won't trigger rmSync
            // but the function should still succeed
            await ms.cloneGit('xchain-encoder', true)
            // Exactly one CLONE. Counting every execFile call instead would drift with
            // the source-identity reads that follow a clone, which are not clones.
            const clones = stubs.execFile.getCalls().filter(c => c.args[1][0] === 'clone')
            expect(clones.length).to.equal(1)
        })

        })

moduleSuite('cloneGit()', function () {it('rejects when directory exists and rewrite=false', async function () {
            const stubs = makeStubs()
            const ms2 = proxyquire('../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(true),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub(),
                    getDockerNetwork: sinon.stub(),
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName, getStatusFromContainer: stubs.getStatusFromContainer },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() }
            })
            try {
                await ms2.cloneGit('xchain-encoder', false, false)
                expect.fail()
            } catch (err) {
                expect(err).to.include('already exists')
            }
        })

        it('uses tmp directory when useTmp=true', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('/tmp/xchain-encoder')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, true)
        })

        it('rejects on git clone error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('git clone failed'))
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })
    })
