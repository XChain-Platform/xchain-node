'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const { Readable } = require('stream')
const path       = require('path')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(fsStub, readlineOverride) {
    const constants = require('../../src/config/constants')
    const stubs = {
        'fs': fsStub || require('fs'),
        '../config/constants': {
            ...constants,
            configDir: '/test/config'
        },
        '../utils/helpers': { stringToCoin: (s) => s }
    }
    if (readlineOverride) {
        stubs['readline'] = readlineOverride
    }
    return proxyquire('../../src/services/ConfigService', stubs)
}

describe('Chaos: Config Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // -------------------------------------------------------------------
    // Experiment 1: Config file missing (FS-01)
    // -------------------------------------------------------------------

    describe('Experiment 1: Config file missing', function () {

        it('falls back to hardcoded defaults when config file does not exist', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const warnSpy = sinon.stub(console, 'warn')

            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'regtest')

            expect(config).to.have.property('NETWORK', 'regtest')
            expect(config).to.have.property('NODE_PORT', 18444)
            expect(config).to.have.property('DECODER_DB_HOST', 'mariadb')
            expect(warnSpy.calledOnce).to.be.true
            expect(warnSpy.firstCall.args[0]).to.include('config file not found')
        })

        it('still returns all required default keys when config file is missing', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            sinon.stub(console, 'warn')

            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            const requiredKeys = [
                'NETWORK', 'NODE_URL', 'NODE_PORT', 'NODE_USER', 'NODE_PASSWORD',
                'DECODER_DB_HOST', 'DECODER_DB_PORT', 'ENCODER_URL', 'INDEXER_HOST',
                'HUB_HOST', 'HUB_PORT'
            ]
            for (const key of requiredKeys) {
                expect(config).to.have.property(key)
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment 1b: Config file unreadable (FS-02)
    // -------------------------------------------------------------------

    describe('Experiment 1b: Config file unreadable (permission denied)', function () {

        it('propagates stream error when config file cannot be read', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => {
                    const s = new Readable({ read() { this.destroy(new Error('EACCES: permission denied')) } })
                    return s
                }),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)

            try {
                await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('EACCES')
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment 2: Malformed config content (FS-03)
    // -------------------------------------------------------------------

    describe('Experiment 2: Malformed config content', function () {

        it('skips lines without = delimiter', async function () {
            const configContent = 'THIS_LINE_HAS_NO_EQUALS\nNODE_PORT=9999\nANOTHER_BAD_LINE'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent.split('\n').map(l => l + '\n'))),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PORT', '9999')
            expect(config).to.not.have.property('THIS_LINE_HAS_NO_EQUALS')
            expect(config).to.not.have.property('ANOTHER_BAD_LINE')
        })

        it('handles empty config file gracefully', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from('')),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            // Should fall back to all defaults
            expect(config).to.have.property('NETWORK')
            expect(config).to.have.property('NODE_PORT', 8332)
        })

        it('handles config with duplicate keys (last value wins)', async function () {
            const configContent = 'NODE_PORT=1111\nNODE_PORT=2222\nNODE_PORT=3333'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent.split('\n').map(l => l + '\n'))),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PORT', '3333')
        })

        it('handles config with values containing = signs', async function () {
            const configContent = 'NODE_PASSWORD=my=secret=password'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent + '\n')),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PASSWORD', 'my=secret=password')
        })

        it('handles config with empty values', async function () {
            const configContent = 'NODE_PASSWORD='
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent + '\n')),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config).to.have.property('NODE_PASSWORD', '')
        })

        it('handles config with only whitespace lines', async function () {
            const configContent = '   \n\t\n  \n'
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from(configContent)),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            // All defaults should still be present
            expect(config).to.have.property('NODE_PORT', 8332)
        })
    })

    // -------------------------------------------------------------------
    // Experiment 12: Config path traversal (FS-09)
    // -------------------------------------------------------------------

    describe('Experiment 12: Config path traversal', function () {

        it('blocks basic path traversal with ../', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from('')),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)

            try {
                await cs.getDefaultConfig('xchain-encoder', '../../etc', 'passwd')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('path traversal')
            }
        })

        it('blocks traversal with encoded separators in coin name', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                createReadStream: sinon.stub().callsFake(() => Readable.from('')),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)

            try {
                await cs.getDefaultConfig('xchain-encoder', '../..', 'etc/passwd')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('path traversal')
            }
        })

        it('allows valid coin-network combinations', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                createReadStream: sinon.stub(),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub()
            }
            const cs = makeConfigService(fsStub)
            sinon.stub(console, 'warn')

            // These should NOT throw path traversal
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(config).to.have.property('NETWORK')
        })
    })

    // -------------------------------------------------------------------
    // Experiment: resolveArgs chaos (ARG-01 through ARG-06)
    // -------------------------------------------------------------------

    describe('Experiment: Argument parsing resilience', function () {

        it('handles empty args array', function () {
            const cs = makeConfigService()
            const result = cs.resolveArgs([])
            expect(result.service).to.equal('all')
            expect(result.chain).to.equal('all')
            expect(result.network).to.equal('all')
        })

        it('handles null/undefined args in array', function () {
            const cs = makeConfigService()
            const result = cs.resolveArgs([null, undefined, ''])
            expect(result.service).to.equal('all')
        })

        it('rejects branch name with shell injection characters', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['$(whoami)'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with semicolons', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['master; rm -rf /'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with backticks', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['`whoami`'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })

        it('rejects branch name with spaces', function () {
            const cs = makeConfigService()
            try {
                cs.resolveArgs(['branch with spaces'], { expectBranch: true })
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Invalid branch name')
            }
        })

        it('accepts valid branch names with dots, hyphens, underscores, slashes', function () {
            const cs = makeConfigService()
            const result = cs.resolveArgs(['feature/my-branch_v1.0'], { expectBranch: true })
            expect(result.branch).to.equal('feature/my-branch_v1.0')
        })

        it('handles extremely long argument strings without crashing', function () {
            const cs = makeConfigService()
            const longArg = 'a'.repeat(10000)
            // Should not throw or hang — just treated as unknown arg
            const result = cs.resolveArgs([longArg])
            expect(result.service).to.equal('all')
        })
    })

    // -------------------------------------------------------------------
    // Experiment: validatePort chaos
    // -------------------------------------------------------------------

    describe('Experiment: Port validation under chaos', function () {

        it('rejects port 0', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(0)).to.be.false
        })

        it('rejects negative ports', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(-1)).to.be.false
        })

        it('rejects ports above 65535', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(70000)).to.be.false
        })

        it('rejects NaN', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(NaN)).to.be.false
        })

        it('rejects non-numeric strings', function () {
            const cs = makeConfigService()
            expect(cs.validatePort('abc')).to.be.false
        })

        it('rejects float values', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(3.14)).to.be.false
        })

        it('rejects Infinity', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(Infinity)).to.be.false
        })

        it('rejects null/undefined/objects', function () {
            const cs = makeConfigService()
            expect(cs.validatePort(null)).to.be.false
            expect(cs.validatePort(undefined)).to.be.false
            expect(cs.validatePort({})).to.be.false
            expect(cs.validatePort([])).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // Experiment: getDefaultConfig with no coin/network (shared modules)
    // -------------------------------------------------------------------

    describe('Experiment: Shared module config (no coin/network)', function () {

        it('returns shared defaults when coin and network are null', async function () {
            const cs = makeConfigService()
            const config = await cs.getDefaultConfig('xchain-hub', null, null)

            expect(config).to.have.property('HUB_HOST', '127.0.0.1')
            expect(config).to.have.property('HUB_PORT', 10000)
            expect(config).to.not.have.property('DECODER_DB_HOST')
        })

        it('returns shared defaults when coin and network are empty strings', async function () {
            const cs = makeConfigService()
            const config = await cs.getDefaultConfig('xchain-explorer', '', '')

            expect(config).to.have.property('EXPLORER_HOST')
            expect(config).to.have.property('EXPLORER_PORT')
        })
    })
})
