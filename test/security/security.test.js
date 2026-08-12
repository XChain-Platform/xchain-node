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

function makeExecFileStub() {
    return sinon.stub()
}

// executeDockerMariaDbCommand pipes SQL to the mariadb client over STDIN (never
// argv). This builds a fake `spawn` child that records argv (`_args`) and the
// piped SQL (`_stdin`) and resolves with empty output. Grab the child via
// `stubs.spawn.firstCall.returnValue`.
function makeDbSpawnStub() {
    const { EventEmitter } = require('events')
    return sinon.stub().callsFake(function (cmd, args, opts) {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child._args = args
        child._env = opts && opts.env
        child._stdin = ''
        child.stdin = {
            write(d) { if (d != null) child._stdin += d },
            end(d) {
                if (d != null) child._stdin += d
                setImmediate(() => child.emit('close', 0))
            },
            on() {}
        }
        return child
    })
}

function loadDockerService(stubs) {
    return proxyquire('../../src/services/DockerService', {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn || sinon.stub(),
            spawnSync: stubs.spawnSync || sinon.stub()
        },
        'fs': stubs.fs || { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({ key: sinon.stub(), on: sinon.stub(), render: sinon.stub(), destroy: sinon.stub() }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

function loadModuleService(stubs, configOverrides) {
    const configServiceStub = {
        getModuleDir: (mod) => '/modules/' + mod,
        getModuleTmpDir: (mod) => '/tmp/' + mod,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (mod, coin, net) => `xchain-node-${coin}-${net}-${mod}`,
        getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
        validatePort: (v) => { if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535; if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 } return false },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'mainnet',
            'NODE_PORT': 8332,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        }),
        ...(configOverrides || {})
    }

    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || { existsSync: sinon.stub().returns(true), rmSync: sinon.stub(), mkdirSync: sinon.stub() },
        '../state': { db: stubs.db || { insertModuleContainer: sinon.stub().resolves(true) }, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
        './ConfigService': configServiceStub,
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), getStatusFromContainer: sinon.stub().resolves({}),
            // buildAndUp now runs a host-port-conflict pre-check (assertNoHostPortConflicts ->
            // getPublishedHostPorts), which returns a Map<hostPort, Set<name>>. Empty Map = no
            // conflict, so the container-ID validation path under test is reached.
            getPublishedHostPorts: sinon.stub().resolves(new Map()) },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

function loadDatabaseService(stubs) {
    return proxyquire('../../src/services/DatabaseService', {
        'child_process': { execFile: stubs.execFile, spawn: stubs.spawn || makeDbSpawnStub() },
        'util': { promisify: () => stubs.execFileAsync || sinon.stub().resolves({ stdout: '', stderr: '' }) },
        'mariadb': {},
        'enquirer': { Password: sinon.stub() },
        '../state': {
            db: stubs.db || { getModuleContainer: sinon.stub().resolves('db-container-123') },
            getDbRootPassword: stubs.getDbRootPassword || sinon.stub().returns('rootpass'),
            setDbRootPassword: sinon.stub()
        },
        '../utils/helpers': { sleep: sinon.stub().resolves() },
        './ConfigService': {
            getDefaultConfig: sinon.stub().resolves({}),
            getDockerContainerImageName: sinon.stub().returns('xchain-node-database'),
            getDockerNetwork: sinon.stub().returns('xchain-node-bitcoin-mainnet'),
            getModuleDatabaseName: sinon.stub().returns('XChain_BTC_Mainnet_Decoder')
        },
        './DockerService': {
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
            getDockerNetworkInspect: sinon.stub().resolves({ IPAM: { Config: [{ Gateway: '172.18.0.1' }] } }),
            addContainerToNetwork: sinon.stub().resolves()
        },
        './StatusService': { statusChanged: sinon.stub().resolves() }
    })
}

describe('Security', function () {

    describe('Shell injection prevention via execFile', function () {

        it('DockerService uses execFile (no shell) for all Docker commands', async function () {
            const stubs = { execFile: makeExecFileStub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            await ds.startContainer('abc123')
            expect(stubs.execFile.calledOnce).to.be.true
            const [cmd, args] = stubs.execFile.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.be.an('array')
            expect(args).to.deep.equal(['start', 'abc123'])
        })

        it('execContainer passes command as array elements, not a shell string', async function () {
            const stubs = { execFile: makeExecFileStub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'output\n')
            })
            const ds = loadDockerService(stubs)
            // Pass as array; shell metacharacters are treated as literals
            await ds.execContainer('abc123', ['echo', '$(whoami)'])
            const [cmd, args] = stubs.execFile.firstCall.args
            expect(cmd).to.equal('docker')
            expect(args).to.deep.equal(['exec', '-i', 'abc123', 'echo', '$(whoami)'])
        })

        it('shell metacharacters in container IDs are passed literally to execFile', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const maliciousId = 'abc; rm -rf /'
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, maliciousId + '\n')
            })
            const ds = loadDockerService(stubs)
            // The malicious string is passed as a single array element
            try {
                await ds.stopContainer(maliciousId)
            } catch { /* may reject due to ID mismatch; that's fine */ }
            const [, args] = stubs.execFile.firstCall.args
            expect(args[0]).to.equal('stop')
            expect(args[1]).to.equal(maliciousId)
        })

        it('buildAndUp passes env vars via the child env (bare --env NAME), never as values in argv', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            let runArgs = null
            let runOpts = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const opts = typeof rest[0] === 'object' && rest[0] !== null ? rest[0] : null
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'run') {
                    runArgs = args
                    runOpts = opts
                    cb(null, 'a'.repeat(64) + '\n')
                } else {
                    cb(null, '')
                }
            })

            const ms = loadModuleService(stubs, {
                getDefaultConfig: sinon.stub().resolves({
                    'HUB_DB_PASS': 's3cr3t-pw',
                    'HUB_API_KEY': 'api-key-xyz',
                    'DANGEROUS_VAR': 'value$(whoami)'
                })
            })
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')

            // Secrets (and every env value) reach the container through the child
            // process env, keeping them out of argv / /proc/<pid>/cmdline and out
            // of a failed-run error.message.
            expect(runOpts).to.be.an('object')
            expect(runOpts.env).to.include({ HUB_DB_PASS: 's3cr3t-pw', HUB_API_KEY: 'api-key-xyz' })
            // argv carries only the NAME (bare --env), never the value.
            expect(runArgs).to.include('--env')
            expect(runArgs).to.include('HUB_DB_PASS')
            const argvStr = runArgs.join(' ')
            expect(argvStr).to.not.include('s3cr3t-pw')
            expect(argvStr).to.not.include('api-key-xyz')
            expect(argvStr).to.not.include('HUB_DB_PASS=')
            // A hostile value in the env still can't reach a shell (execFile, no shell).
            expect(runArgs).to.not.include('DANGEROUS_VAR=value$(whoami)')
            expect(runOpts.env.DANGEROUS_VAR).to.equal('value$(whoami)')
        })
    })

    describe('Container ID validation', function () {

        it('ModuleService buildAndUp validates container ID as 64-char hex', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            const validId = 'a'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, validId + '\n')
            })
            const ms = loadModuleService(stubs)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(result).to.equal(validId)
        })

        it('rejects non-hex container IDs', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            const invalidId = 'g'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, invalidId + '\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('rejects container IDs with shell metacharacters', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            const maliciousId = 'a'.repeat(63) + ';'
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, maliciousId + '\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('rejects container IDs shorter than 64 chars', async function () {
            const stubs = { execFile: makeExecFileStub(), db: { insertModuleContainer: sinon.stub().resolves(true) } }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null, '')
                else cb(null, 'abc123\n')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })
    })

    describe('NODE_PREFIX validation', function () {

        it('accepts valid lowercase alphanumeric prefix', function () {
            // The default "xchain-node" must pass validation
            const constants = require('../../src/config/constants')
            expect(constants.NODE_PREFIX).to.match(/^[a-z0-9][a-z0-9._-]*$/)
        })

        it('rejects prefix with shell metacharacters via env var', function () {
            const malicious = 'xchain;rm -rf /'
            const origEnv = process.env.NODE_PREFIX
            process.env.NODE_PREFIX = malicious
            try {
                delete require.cache[require.resolve('../../src/config/constants')]
                expect(() => {
                    require('../../src/config/constants')
                }).to.throw('Invalid NODE_PREFIX')
            } finally {
                if (origEnv === undefined) delete process.env.NODE_PREFIX
                else process.env.NODE_PREFIX = origEnv
                delete require.cache[require.resolve('../../src/config/constants')]
            }
        })

        it('rejects prefix with spaces', function () {
            const origEnv = process.env.NODE_PREFIX
            process.env.NODE_PREFIX = 'xchain node'
            try {
                delete require.cache[require.resolve('../../src/config/constants')]
                expect(() => {
                    require('../../src/config/constants')
                }).to.throw('Invalid NODE_PREFIX')
            } finally {
                if (origEnv === undefined) delete process.env.NODE_PREFIX
                else process.env.NODE_PREFIX = origEnv
                delete require.cache[require.resolve('../../src/config/constants')]
            }
        })

        it('rejects prefix with dollar sign', function () {
            const origEnv = process.env.NODE_PREFIX
            process.env.NODE_PREFIX = 'xchain$HOME'
            try {
                delete require.cache[require.resolve('../../src/config/constants')]
                expect(() => {
                    require('../../src/config/constants')
                }).to.throw('Invalid NODE_PREFIX')
            } finally {
                if (origEnv === undefined) delete process.env.NODE_PREFIX
                else process.env.NODE_PREFIX = origEnv
                delete require.cache[require.resolve('../../src/config/constants')]
            }
        })
    })

    describe('Branch name validation', function () {

        it('cloneGit rejects branch names with shell metacharacters', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master;rm -rf /')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('cloneGit rejects branch names with backticks', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'master`whoami`')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('cloneGit rejects branch names with $() command substitution', async function () {
            const stubs = { execFile: makeExecFileStub() }
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, '$(whoami)')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('cloneGit accepts valid branch names', async function () {
            const stubs = { execFile: makeExecFileStub() }
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, 'feature/my-branch_v1.0')
            expect(stubs.execFile.calledOnce).to.be.true
            const [, args] = stubs.execFile.firstCall.args
            expect(args).to.include('-b')
            expect(args).to.include('feature/my-branch_v1.0')
        })

        it('resolveArgs rejects invalid branch names', function () {
            const ConfigService = require('../../src/services/ConfigService')
            expect(() => {
                ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'bad;branch'], { expectBranch: true })
            }).to.throw('Invalid branch name')
        })

        it('resolveArgs accepts valid branch names', function () {
            const ConfigService = require('../../src/services/ConfigService')
            const result = ConfigService.resolveArgs(['xchain-encoder', 'bitcoin', 'mainnet', 'develop'], { expectBranch: true })
            expect(result.branch).to.equal('develop')
        })
    })

    describe('Config path traversal prevention', function () {

        it('getDefaultConfig rejects a path-traversal coin parameter', async function () {
            const ConfigService = require('../../src/services/ConfigService')
            // A traversal string in `coin` must be refused. The guard is a known-coin
            // allowlist that rejects unknown coins before any path join (a dedicated
            // traversal-detection guard also exists on other code paths), so the
            // malicious input must never be silently accepted.
            let threw = null
            try {
                await ConfigService.getDefaultConfig('xchain-encoder', '../../../etc', 'passwd')
            } catch (err) {
                threw = err
            }
            expect(threw, 'a traversal coin parameter must be rejected').to.not.equal(null)
            expect(threw.message).to.match(/traversal|unknown coin|invalid/i)
        })
    })

    describe('Database command safety', function () {

        it('executeDockerMariaDbCommand pipes SQL via stdin, never argv', async function () {
            const stubs = { execFile: makeExecFileStub(), spawn: makeDbSpawnStub() }
            const ds = loadDatabaseService(stubs)
            const sql = "SELECT COUNT(*) FROM mysql.user WHERE user = 'test'"
            await ds.executeDockerMariaDbCommand('db-container', 'rootpass', sql, '-B -N')

            const child = stubs.spawn.firstCall.returnValue
            expect(stubs.spawn.firstCall.args[0]).to.equal('docker')
            // The SQL must NOT appear anywhere in argv; it is piped via stdin.
            // This keeps a user-creation statement's embedded PASSWORD('...')
            // out of the child's /proc/<pid>/cmdline.
            expect(child._args.some(a => String(a).includes('mysql.user'))).to.be.false
            expect(child._args).to.not.include('-e' + sql)
            expect(child._stdin).to.include(sql)
            // Command options stay as separate argv elements.
            expect(child._args).to.include('-B')
            expect(child._args).to.include('-N')
        })

        it('password travels via MYSQL_PWD env, never a -p argv token', async function () {
            const stubs = { execFile: makeExecFileStub(), spawn: makeDbSpawnStub() }
            const ds = loadDatabaseService(stubs)
            const password = 'pa$$w0rd`whoami`'
            await ds.executeDockerMariaDbCommand('db-container', password, 'SELECT 1')

            const child = stubs.spawn.firstCall.returnValue
            // No -p<password> token anywhere; the secret is only in the env.
            expect(child._args.some(a => String(a).startsWith('-p'))).to.be.false
            expect(child._args.some(a => String(a).includes(password))).to.be.false
            expect(child._env.MYSQL_PWD).to.equal(password)
        })
    })

    describe('GitHubDownloader archive extraction safety', function () {

        it('uses spawnSync instead of execSync for tar extraction', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../src/GitHubDownloader.js'), 'utf8'
            )
            expect(source).to.not.include('execSync')
            expect(source).to.include('spawnSync')
        })

        it('uses fs.unlinkSync instead of shell rm for cleanup', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../src/GitHubDownloader.js'), 'utf8'
            )
            expect(source).to.include('fs.unlinkSync')
            expect(source).to.not.match(/&& rm /)
        })
    })

    describe('helpers.js decompressTarGz safety', function () {

        it('uses execFile instead of exec', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../src/utils/helpers.js'), 'utf8'
            )
            expect(source).to.include('execFile')
            expect(source).to.not.match(/\bexec\b[^F]/) // no bare exec (only execFile)
        })
    })

    describe('stringToDockerContainerFile safety', function () {

        it('uses spawn with tee instead of exec with shell interpolation', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../src/services/DockerService.js'), 'utf8'
            )
            // Guards against a regression to the earlier broken template literal.
            expect(source).to.not.include("docker exec -i ${containerId}")
            expect(source).to.include("spawn('docker'")
            expect(source).to.include("'tee'")
        })
    })

    describe('Bootstrap directory permissions', function () {

        it('uses chmod 755 instead of 777 for bootstrap directories', function () {
            const source = require('fs').readFileSync(
                path.join(__dirname, '../../src/services/BootstrapService.js'), 'utf8'
            )
            expect(source).to.not.include('chmod 777')
            expect(source).to.include("'755'")
        })
    })

    describe('No remaining exec() calls in source files', function () {
        const fs = require('fs')
        const srcDir = path.join(__dirname, '../../src')

        function getAllJsFiles(dir) {
            const files = []
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) files.push(...getAllJsFiles(full))
                else if (entry.name.endsWith('.js')) files.push(full)
            }
            return files
        }

        const jsFiles = getAllJsFiles(srcDir)

        for (const file of jsFiles) {
            const relPath = path.relative(srcDir, file)
            it(`${relPath} does not use child_process.exec()`, function () {
                const source = fs.readFileSync(file, 'utf8')
                // Flags a bare exec( (imported child_process.exec), skipping comment
                // and require('child_process') lines and excluding execFile/execFileAsync.
                const lines = source.split('\n')
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim()
                    if (line.startsWith('//') || line.startsWith('*')) continue
                    if (line.includes("require('child_process')")) continue
                    // Requires the char before `exec` to be start-of-line or non-word/non-dot,
                    // which excludes `x.exec(` method calls (RegExp.prototype.exec was a false
                    // positive here) while still catching a bare imported exec(.
                    if (/(^|[^.\w])exec\s*\(/.test(line) && !/\bexecFile/.test(line)) {
                        // Allow promisify references and variable names
                        if (/promisify/.test(line)) continue
                        if (/execAsync/.test(line)) continue
                        expect.fail(`${relPath}:${i + 1} contains exec() call: ${line}`)
                    }
                    // Also catch an aliased child_process.exec( (e.g. cp.exec / childProcess.exec)
                    if (/\b(child_?[pP]rocess|cp)\s*\.\s*exec\s*\(/.test(line)) {
                        expect.fail(`${relPath}:${i + 1} contains child_process.exec() call: ${line}`)
                    }
                    if (/\bexecSync\s*\(/.test(line)) {
                        expect.fail(`${relPath}:${i + 1} contains execSync() call: ${line}`)
                    }
                }
            })
        }
    })
})
