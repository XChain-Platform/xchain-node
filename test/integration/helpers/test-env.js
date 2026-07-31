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

const fs    = require('fs')
const path  = require('path')
const os    = require('os')
const sinon = require('sinon')

const CommandCapture = require('./command-capture')
const HttpCapture    = require('./http-capture')

/**
 * In-memory replacement for MariaDbStore. Implements the same public API
 * (createDatabase / get/insert/remove ModuleContainer / countModules /
 * isReady / close / getAllModuleContainers) backed by a Map. Lets
 * integration tests run without a live MariaDB.
 */
class InMemoryStore {
    constructor() {
        this.modules = new Map()
        this._ready = true
    }

    _key(module, coin, network) {
        return `${module}|${coin || ''}|${network || ''}`
    }

    async createDatabase() { return this }
    async close()          { this._ready = false }
    isReady()              { return this._ready }

    // Mirrors MariaDbStore.assertReady: callers that act on the row set refuse
    // to run against a store that isn't connected, rather than reading its
    // empty result as "nothing installed" and reporting success.
    assertReady(operation) {
        if (!this._ready) {
            throw new Error("InMemoryStore is not connected, so " + operation + " would operate on an empty module set")
        }
    }

    async countModules() {
        return this.modules.size
    }

    async getAllModuleContainers(coin, network) {
        const out = []
        for (const [key, container_id] of this.modules.entries()) {
            const [module, c, n] = key.split('|')
            const matchesAll      = coin == null && network == null
            const matchesCoinNet  = coin === c && network === n
            const matchesShared   = c === '' && n === ''
            if (matchesAll || matchesCoinNet || matchesShared) {
                out.push({ module, coin: c, network: n, container_id })
            }
        }
        return out
    }

    async insertModuleContainer(module, coin, network, containerId) {
        this.modules.set(this._key(module, coin, network), containerId)
        return true
    }

    async getModuleContainer(module, coin, network) {
        const v = this.modules.get(this._key(module, coin, network))
        return v === undefined ? null : v
    }

    async removeModuleContainer(module, coin, network) {
        const key = this._key(module, coin, network)
        const value = this.modules.get(key)
        if (value === undefined) return false
        this.modules.delete(key)
        return value
    }
}

/**
 * TestEnv - sets up an isolated integration test environment.
 *
 * Provides:
 *   - In-memory store that replaces the global state.db (MariaDbStore mock)
 *   - Temp directory for config file fixtures
 *   - CommandCapture for child_process stubs
 *   - HttpCapture for axios stubs
 *   - State reset for src/state.js globals
 *
 * Usage:
 *   const env = new TestEnv()
 *   before(async () => await env.setup())
 *   after(async () => await env.teardown())
 */
class TestEnv {
    constructor() {
        this.tmpDir = null
        this.configDir = null
        this.dataDir = null
        this.moduleDir = null
        this._store = null
        this.cmdCapture = new CommandCapture()
        this.httpCapture = new HttpCapture()
        this._stubs = []
        this._origConstants = {}
        this._origDbMethods = null
    }

    async setup() {
        // Create temp directory structure
        this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-test-'))
        this.configDir = path.join(this.tmpDir, 'config')
        this.dataDir = path.join(this.tmpDir, 'data')
        this.moduleDir = path.join(this.tmpDir, 'modules')

        fs.mkdirSync(this.configDir)
        fs.mkdirSync(this.dataDir)
        fs.mkdirSync(this.moduleDir)

        this._store = new InMemoryStore()
        this._patchStateDb()
        this._resetState()

        return this
    }

    /**
     * Replace the global state.db method bag with the in-memory store's bound
     * methods so production code transparently uses the mock.
     */
    _patchStateDb() {
        const state = require('../../../src/state')
        const realDb = state.db
        const store = this._store

        const methodNames = [
            'createDatabase', 'close', 'isReady', 'assertReady', 'countModules',
            'getAllModuleContainers', 'insertModuleContainer',
            'getModuleContainer', 'removeModuleContainer'
        ]

        this._origDbMethods = {}
        for (const name of methodNames) {
            this._origDbMethods[name] = realDb[name]
            realDb[name] = store[name].bind(store)
        }
    }

    _resetState() {
        const state = require('../../../src/state')
        state.setDbRootPassword(null)
        state.setInstalledModules({})
        state.setStatusUpdated(false)
        state.setLastStatus(null)
        state.setLastPrintedStatus('')
        state.setVerbose(false)
    }

    /**
     * Write a config file fixture (e.g., 'bitcoin-mainnet' with key=value content).
     */
    writeConfigFile(coinNetwork, content) {
        fs.writeFileSync(path.join(this.configDir, coinNetwork), content)
    }

    /**
     * Create a fake module directory with minimal structure (Dockerfile, src, package.json).
     */
    createFakeModule(moduleName, packageVersion) {
        this.writeFakeModuleAt(path.join(this.moduleDir, moduleName), moduleName, packageVersion)
    }

    /**
     * Same minimal structure, written at an arbitrary path. Used by the fake
     * `git clone` route, which must materialize whatever destination it is
     * handed (cloneGit stages a rewrite-clone in a sibling directory and swaps
     * it in, so the destination is not always the module directory).
     */
    writeFakeModuleAt(dir, moduleName, packageVersion) {
        fs.mkdirSync(dir, { recursive: true })
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20\n')
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            name: moduleName,
            version: packageVersion || '0.0.1'
        }))
    }

    /**
     * Insert a module container ID directly into the test store.
     */
    async insertModule(module, coin, network, containerId) {
        return this._store.insertModuleContainer(module, coin, network, containerId)
    }

    /**
     * Get a module container ID from the test store.
     */
    async getModule(module, coin, network) {
        return this._store.getModuleContainer(module, coin, network)
    }

    /**
     * Get all module containers from the test store.
     */
    async getAllModules() {
        return this._store.getAllModuleContainers(null, null)
    }

    /**
     * Overrides constants paths for config/module/data dirs to use temp dirs.
     * Returns a restore function.
     */
    patchConstants() {
        const constants = require('../../../src/config/constants')
        this._origConstants = {
            configDir: constants.configDir,
            moduleDir: constants.moduleDir,
            dataDir: constants.dataDir,
            tmpDir: constants.tmpDir,
            containersFilesDir: constants.containersFilesDir
        }

        // These are module-level exports, we need to override them directly
        constants.configDir = this.configDir
        constants.moduleDir = this.moduleDir
        constants.dataDir = this.dataDir
        constants.tmpDir = path.join(this.tmpDir, 'tmp')
        constants.containersFilesDir = path.join(this.tmpDir, 'tmp', 'containers_files')

        // Create dirs
        fs.mkdirSync(constants.tmpDir, { recursive: true })
        fs.mkdirSync(constants.containersFilesDir, { recursive: true })

        // Bust the require cache for modules that destructure constants at load time.
        // This forces them to re-require constants with patched values.
        this._cachedModules = []
        for (const key of Object.keys(require.cache)) {
            if (key.includes('ConfigService') || key.includes('ModuleService')) {
                this._cachedModules.push({ key, module: require.cache[key] })
                delete require.cache[key]
            }
        }
    }

    restoreConstants() {
        if (Object.keys(this._origConstants).length > 0) {
            const constants = require('../../../src/config/constants')
            Object.assign(constants, this._origConstants)
            this._origConstants = {}
        }
        // Restore cached modules that we evicted from require.cache
        if (this._cachedModules) {
            for (const { key, module } of this._cachedModules) {
                require.cache[key] = module
            }
            this._cachedModules = []
        }
    }

    async teardown() {
        // Restore the original db methods on the singleton
        if (this._origDbMethods) {
            const state = require('../../../src/state')
            for (const [name, fn] of Object.entries(this._origDbMethods)) {
                state.db[name] = fn
            }
            this._origDbMethods = null
        }

        this.restoreConstants()
        this._resetState()

        if (this._store) {
            await this._store.close()
            this._store = null
        }

        // Remove temp directory
        if (this.tmpDir && fs.existsSync(this.tmpDir)) {
            fs.rmSync(this.tmpDir, { recursive: true, force: true })
        }

        // Restore sinon stubs
        sinon.restore()
    }

    /**
     * Generate a fake 64-char container ID.
     */
    static fakeContainerId(seed) {
        const base = (seed || 'a').repeat(64)
        return base.substring(0, 64)
    }
}

module.exports = TestEnv
