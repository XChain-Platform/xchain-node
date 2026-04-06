'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { XChainService } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadModuleService(stubs) {
    return proxyquire('../../src/services/ModuleService', {
        'child_process': { exec: stubs.exec },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: (mod, coin, net) => 'xchain-node-' + coin + '-' + net + '-' + mod,
            getDockerNetwork: (coin, net) => 'xchain-node-' + coin + '-' + net,
            getDefaultConfig: sinon.stub().resolves(stubs.envVars || {
                'NETWORK': 'bitcoin-mainnet',
                'NODE_PORT': 8332,
                'ENCODER_PORT': 3003,
                'ENCODER_API_PORT': 3003
            }),
            validatePort: (v) => { const p = Number(v); return Number.isInteger(p) && p >= 1 && p <= 65535 }
        },
        './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
        './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

function makeStubs(envVars) {
    return {
        exec: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            readFileSync: sinon.stub()
        },
        db: {
            insertModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves(null),
            removeModuleContainer: sinon.stub().resolves(true)
        },
        envVars
    }
}

/**
 * Captures the `docker run` command string that buildAndUp constructs.
 * The exec stub handles both `docker build` and `docker run` calls.
 */
function captureDockerRunCmd(stubs) {
    let runCmd = null
    stubs.exec.callsFake((cmd, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {} }
        if (cmd.includes('docker build')) {
            cb(null)
        } else if (cmd.includes('docker run')) {
            runCmd = cmd
            cb(null, 'a'.repeat(64) + '\n')
        }
    })
    return () => runCmd
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fuzz: Environment Variable Escaping', function () {

    // Each entry: [description, malicious value, assertion about the docker run command]
    const shellMetacharInputs = [
        ['double quote',           'val"injection',      (cmd) => expect(cmd).to.not.match(/[^\\]"injection/)],
        ['backslash',              'val\\injection',     (cmd) => expect(cmd).to.include('val\\\\injection')],
        ['dollar sign',            'val$injection',      (cmd) => expect(cmd).to.include('val\\$injection')],
        ['backtick',               'val`id`',            (cmd) => expect(cmd).to.include('val\\`id\\`')],
        ['dollar paren',           'val$(whoami)',        (cmd) => expect(cmd).to.include('val\\$(whoami)')],
        ['semicolon',              'val;rm -rf /',       (cmd) => expect(cmd).to.include('val;rm -rf /')], // safe inside double quotes
        ['pipe',                   'val|cat /etc/passwd',(cmd) => expect(cmd).to.include('val|cat /etc/passwd')], // safe inside double quotes
        ['ampersand',              'val&&echo pwned',    (cmd) => expect(cmd).to.include('val&&echo pwned')], // safe inside double quotes
    ]

    for (const [desc, maliciousValue, assertion] of shellMetacharInputs) {
        it(`escapes ${desc} in env var value`, async function () {
            const stubs = makeStubs({ 'TEST_KEY': maliciousValue, 'ENCODER_PORT': 3003, 'ENCODER_API_PORT': 3003 })
            const getCmd = captureDockerRunCmd(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            const cmd = getCmd()
            expect(cmd).to.exist
            assertion(cmd)
        })
    }

    // --- Newline / carriage return injection (the bug we fixed) ---

    it('escapes newline characters to prevent Docker flag injection', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'safe_value\n-v /:/host:ro',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        // The newline must NOT appear literally — it should be escaped
        expect(cmd).to.not.include('\n')
        // The escaped form should be present
        expect(cmd).to.include('safe_value\\n-v /:/host:ro')
    })

    it('escapes carriage return characters', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'safe_value\r-v /:/host:ro',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.not.include('\r')
        expect(cmd).to.include('safe_value\\r-v /:/host:ro')
    })

    it('escapes combined \\r\\n injection', async function () {
        const stubs = makeStubs({
            'EVIL_KEY': 'value\r\n--privileged',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.not.include('\r')
        expect(cmd).to.not.include('\n')
    })

    // --- Escape chain / double-encoding attacks ---

    it('handles double-backslash before dollar sign', async function () {
        const stubs = makeStubs({
            'TEST': '\\\\$(id)',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        // Original \\ should become \\\\\\\\ (each \ doubled), $ should be escaped
        expect(cmd).to.include('\\$')
    })

    it('handles backslash-backtick combination', async function () {
        const stubs = makeStubs({
            'TEST': '\\`whoami\\`',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        // All backticks should be escaped
        expect(cmd).to.not.match(/[^\\]`/)
    })

    // --- Null byte and binary data ---

    it('handles null byte in env var value', async function () {
        const stubs = makeStubs({
            'TEST': 'safe\x00malicious',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        // Should not crash; command should exist
        expect(cmd).to.exist
    })

    // --- Extreme lengths ---

    it('handles extremely long env var value without crashing', async function () {
        const stubs = makeStubs({
            'TEST': 'A'.repeat(100000),
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.include('A'.repeat(1000)) // spot check
    })

    it('handles empty string env var value', async function () {
        const stubs = makeStubs({
            'TEST': '',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.include('-e "TEST="')
    })

    // --- Type coercion ---

    it('handles numeric env var value', async function () {
        const stubs = makeStubs({
            'PORT': 8332,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.include('-e "PORT=8332"')
    })

    it('handles boolean env var value', async function () {
        const stubs = makeStubs({
            'FLAG': false,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.include('-e "FLAG=false"')
    })

    it('handles null env var value via String() coercion', async function () {
        const stubs = makeStubs({
            'NULLVAL': null,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.include('-e "NULLVAL=null"')
    })

    it('handles undefined env var value via String() coercion', async function () {
        const stubs = makeStubs({
            'UNDEF': undefined,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        expect(cmd).to.include('-e "UNDEF=undefined"')
    })

    // --- Unicode / special encoding ---

    it('handles unicode characters in env var value', async function () {
        const stubs = makeStubs({
            'TEST': '\u{1F4A9}\u0000bitcoin\u200F',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
    })

    // --- Comprehensive: all dangerous chars in one value ---

    it('escapes a value containing all dangerous shell characters at once', async function () {
        const combined = 'a"b\\c$d`e\nf\rg'
        const stubs = makeStubs({
            'COMBINED': combined,
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003
        })
        const getCmd = captureDockerRunCmd(stubs)
        const ms = loadModuleService(stubs)
        await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
        const cmd = getCmd()
        expect(cmd).to.exist
        // No raw newlines or carriage returns
        expect(cmd).to.not.include('\n')
        expect(cmd).to.not.include('\r')
        // Dollar and backtick escaped
        expect(cmd).to.include('\\$')
        expect(cmd).to.include('\\`')
    })
})
