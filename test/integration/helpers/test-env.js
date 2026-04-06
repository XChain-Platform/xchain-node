'use strict'

const fs      = require('fs')
const path    = require('path')
const os      = require('os')
const sinon   = require('sinon')
const levelup = require('levelup')
const memdown = require('memdown')

const CommandCapture = require('./command-capture')
const HttpCapture    = require('./http-capture')

/**
 * TestEnv - sets up an isolated integration test environment.
 *
 * Provides:
 *   - In-memory LevelDB (via memdown) that replaces the global state db
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
        this.db = null
        this.cmdCapture = new CommandCapture()
        this.httpCapture = new HttpCapture()
        this._stubs = []
        this._origConstants = {}
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

        // Create in-memory LevelDB
        this.db = levelup(memdown())

        // Patch the state module's db singleton to use our in-memory db
        this._patchStateDb()

        // Reset mutable state
        this._resetState()

        return this
    }

    /**
     * Patch the state module so the global `db` singleton uses our memdown-backed LevelDB.
     * This replaces the db property methods so all services use our test db.
     */
    _patchStateDb() {
        const state = require('../../../src/state')
        const realDb = state.db

        // Store original methods so we can restore
        this._origDb = {
            createDatabase: realDb.createDatabase.bind(realDb),
            insertModuleContainer: realDb.insertModuleContainer.bind(realDb),
            getModuleContainer: realDb.getModuleContainer.bind(realDb),
            removeModuleContainer: realDb.removeModuleContainer.bind(realDb),
            getAllModuleContainers: realDb.getAllModuleContainers.bind(realDb),
            db: realDb.db
        }

        // Replace with our in-memory db
        const testDb = this.db
        realDb.db = testDb
        realDb.createDatabase = async () => testDb
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
        const dir = path.join(this.moduleDir, moduleName)
        fs.mkdirSync(dir, { recursive: true })
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20\n')
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            name: moduleName,
            version: packageVersion || '0.0.1'
        }))
    }

    /**
     * Insert a module container ID directly into the test LevelDB.
     */
    async insertModule(module, coin, network, containerId) {
        const key = 'MC' + module + ';' + coin + ';' + network
        await this.db.put(key, containerId)
    }

    /**
     * Get a module container ID from the test LevelDB.
     */
    async getModule(module, coin, network) {
        const key = 'MC' + module + ';' + coin + ';' + network
        try {
            const value = await this.db.get(key)
            return value.toString('utf-8')
        } catch {
            return null
        }
    }

    /**
     * Get all module containers from the test LevelDB.
     */
    async getAllModules() {
        return new Promise((resolve, reject) => {
            const modules = []
            const stream = this.db.createReadStream({
                gte: 'MC',
                lte: 'MC\xFF',
                keys: true,
                values: true
            })
            stream.on('data', (data) => {
                const keyStr = data.key.toString('utf-8').substring(2)
                const parts = keyStr.split(';')
                if (parts.length === 3) {
                    modules.push({
                        module: parts[0],
                        coin: parts[1],
                        network: parts[2],
                        container_id: data.value.toString('utf-8')
                    })
                }
            })
            stream.on('error', reject)
            stream.on('end', () => resolve(modules))
        })
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
        const constantsPath = require.resolve('../../../src/config/constants')
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
        // Restore the original db methods
        if (this._origDb) {
            const state = require('../../../src/state')
            state.db.db = this._origDb.db
            state.db.createDatabase = this._origDb.createDatabase
            state.db.insertModuleContainer = this._origDb.insertModuleContainer
            state.db.getModuleContainer = this._origDb.getModuleContainer
            state.db.removeModuleContainer = this._origDb.removeModuleContainer
            state.db.getAllModuleContainers = this._origDb.getAllModuleContainers
        }

        this.restoreConstants()
        this._resetState()

        // Close the in-memory db
        if (this.db && this.db.isOpen()) {
            await this.db.close()
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
