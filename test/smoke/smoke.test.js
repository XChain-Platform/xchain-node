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

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')

const ROOT = path.join(__dirname, '..', '..')

function createModuleOperationsStateStub() {
    return {
        db: { getAllModuleContainers: sinon.stub().resolves([]), setModuleContainer: sinon.stub().resolves() },
        getInstalledModules: sinon.stub().returns({}),
        setInstalledModules: sinon.stub(),
        resetInstalledModules: sinon.stub(),
        getDbRootPassword: sinon.stub().returns(null),
        setDbRootPassword: sinon.stub(),
        isVerbose: sinon.stub().returns(false)
    }
}

function createModuleOperationsConfigStub() {
    return {
        getModuleDir: sinon.stub(),
        getModuleTmpDir: sinon.stub(),
        moduleDirExists: sinon.stub(),
        checkIfModuleExists: sinon.stub(),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: sinon.stub(),
        getDockerNetwork: sinon.stub(),
        getDefaultConfig: sinon.stub().resolves({}),
        getCryptoNodeDir: sinon.stub(),
        checkIfCryptoNodeSourceExists: sinon.stub(),
        filterCommandParameters: sinon.stub(),
        getDockerContainerImageNamePrefix: sinon.stub(),
        getModuleDatabaseName: sinon.stub()
    }
}

function createModuleOperationsDockerStub() {
    return {
        checkDockerInstalledAndReachable: sinon.stub().resolves(true),
        createDockerNetwork: sinon.stub().resolves(true),
        stopContainer: sinon.stub().resolves(),
        startContainer: sinon.stub().resolves(),
        restartContainer: sinon.stub().resolves(),
        killContainer: sinon.stub().resolves(),
        removeContainer: sinon.stub().resolves(),
        execContainer: sinon.stub().resolves(),
        shellContainer: sinon.stub().resolves(),
        logContainer: sinon.stub().resolves(),
        startDockerMonitor: sinon.stub().resolves(),
        addContainerToNetwork: sinon.stub().resolves(),
        saveContainerLogs: sinon.stub().resolves(),
        waitContainer: sinon.stub().resolves()
    }
}

function loadModuleOperations() {
    return proxyquire(path.join(ROOT, 'src/operations/module_operations'), {
        '../state': createModuleOperationsStateStub(),
        '../services/config_service': createModuleOperationsConfigStub(),
        '../services/docker_service': createModuleOperationsDockerStub(),
        '../services/module_service': {
            cloneGit: sinon.stub().resolves(),
            buildAndUp: sinon.stub().resolves(),
            installModule: sinon.stub().resolves(),
            uninstallModule: sinon.stub().resolves()
        },
        '../services/status_service': {
            getStatus: sinon.stub().resolves(),
            statusChanged: sinon.stub().resolves()
        },
        '../services/database_service': {
            setDatabaseParameters: sinon.stub().resolves(),
            createDatabase: sinon.stub().resolves(),
            dropDatabase: sinon.stub().resolves()
        },
        '../services/hub_service': {
            installHubModule: sinon.stub().resolves(),
            updateHub: sinon.stub().resolves()
        },
        '../services/bootstrap_service': {
            makeBootstrap: sinon.stub().resolves(),
            restoreBootstrap: sinon.stub().resolves()
        }
    })
}

describe('S-SMOKE-001 – Module Import Chain', function () {

    // Modules that can be required with zero side-effects
    const safeDirect = {
        'config/constants':   'src/config/index.js',
        'utils/helpers':      'src/utils/helpers.js',
        'MariaDbStore':       'src/db/index.js',
        'HubConnector':       'src/services/hub_connector.js',
        'ExplorerConnector':  'src/services/explorer_connector.js'
    }

    for (const [label, relPath] of Object.entries(safeDirect)) {
        it(`requires ${label} without throwing`, function () {
            const mod = require(path.join(ROOT, relPath))
            expect(mod).to.not.be.null
            expect(mod).to.not.be.undefined
        })
    }
})

describe('S-SMOKE-001 – Module Import Chain', function () {

    // Modules that need child_process / fs / blessed / leveldb stubbed
    it('requires ConfigService without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/services/config_service'), {
            'fs': {
                existsSync: sinon.stub().returns(false),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                createReadStream: sinon.stub()
            }
        })
        expect(mod).to.have.property('getDefaultConfig').that.is.a('function')
        expect(mod).to.have.property('filterCommandParameters').that.is.a('function')
        expect(mod).to.have.property('resolveArgs').that.is.a('function')
    })

    it('requires DockerService without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/services/docker_service'), {
            'child_process': {
                execFile: sinon.stub(),
                spawn: sinon.stub(),
                spawnSync: sinon.stub()
            },
            'util': { promisify: (fn) => fn },
            'fs': { readFileSync: sinon.stub(), mkdirSync: sinon.stub() },
            'blessed': {
                screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
                text: sinon.stub(),
                log: sinon.stub().returns({ log: sinon.stub() })
            }
        })
        expect(mod).to.have.property('checkDockerInstalledAndReachable').that.is.a('function')
        expect(mod).to.have.property('createDockerNetwork').that.is.a('function')
    })
})

describe('S-SMOKE-001 – Module Import Chain', function () {

    it('requires GitHubDownloader without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/services/github_downloader'), {
            'fs': {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns('{}'),
                writeFileSync: sinon.stub(),
                readdirSync: sinon.stub().returns([]),
                statSync: sinon.stub().returns({ isFile: () => false, isDirectory: () => false })
            }
        })
        expect(mod).to.be.a('function') // class constructor
    })

    it('requires state module without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/state'), {
            './db': function StubMariaDbStore() {
                this.createDatabase = sinon.stub().resolves()
                this.isReady = sinon.stub().returns(false)
            },
            './services/github_downloader.js': function StubGitHubDownloader() {
                this.loadHashesFile = sinon.stub().returns({})
            }
        })
        expect(mod).to.have.property('db')
        expect(mod).to.have.property('gitHubDownloader')
        expect(mod).to.have.property('setVerbose').that.is.a('function')
    })
})

describe('S-SMOKE-001 – Module Import Chain', function () {

    it('requires precheck without throwing', function () {
        const mod = proxyquire(path.join(ROOT, 'src/precheck'), {
            './state': {
                db: { createDatabase: sinon.stub().resolves() },
                isVerbose: sinon.stub().returns(false)
            },
            './services/docker_service': {
                checkDockerInstalledAndReachable: sinon.stub().resolves(true),
                createDockerNetwork: sinon.stub().resolves(true)
            },
            './services/config_service': {
                getDockerNetwork: sinon.stub().returns('xchain-node')
            },
            './services/version_service': {
                checkAllRemoteVersions: sinon.stub().resolves()
            },
            './services/status_service': {
                getStatus: sinon.stub().resolves()
            },
            './services/hub_service': {
                installHubModule: sinon.stub().resolves(),
                updateHub: sinon.stub().resolves()
            },
            './services/explorer_service': {
                updateExplorer: sinon.stub().resolves()
            }
        })
        expect(mod).to.have.property('preCheck').that.is.a('function')
    })
})

describe('S-SMOKE-001 – Module Import Chain', function () {

    it('requires moduleOperations without throwing', function () {
        const mod = loadModuleOperations()
        expect(mod).to.have.property('installModules').that.is.a('function')
        expect(mod).to.have.property('startModules').that.is.a('function')
        expect(mod).to.have.property('stopModules').that.is.a('function')
    })
})
