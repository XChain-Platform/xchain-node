'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function makeAxiosStub() {
    return { post: sinon.stub() }
}

function loadConnector(axiosStub) {
    return proxyquire('../../src/HubConnector', {
        'axios': axiosStub
    })
}

describe('HubConnector', function () {

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    describe('constructor', function () {

        it('builds the URL as http://<url>:<port>', function () {
            const HubConnector = loadConnector(makeAxiosStub())
            const connector = new HubConnector('localhost', 10000)
            expect(connector.url).to.equal('http://localhost:10000')
        })

        it('stores the port on the instance', function () {
            const HubConnector = loadConnector(makeAxiosStub())
            const connector = new HubConnector('127.0.0.1', 8765)
            expect(connector.port).to.equal(8765)
        })

        it('handles IP addresses', function () {
            const HubConnector = loadConnector(makeAxiosStub())
            const connector = new HubConnector('192.168.1.100', 3000)
            expect(connector.url).to.equal('http://192.168.1.100:3000')
        })
    })

    // -------------------------------------------------------------------
    // ping()
    // -------------------------------------------------------------------

    describe('ping()', function () {

        it('returns true when response contains a result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: 'pong' } })
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.ping()
            expect(result).to.be.true
        })

        it('sends correct JSON-RPC payload', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: 'pong' } })
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            await connector.ping()

            const [url, data, opts] = axiosStub.post.firstCall.args
            expect(url).to.equal('http://localhost:10000')
            expect(data.jsonrpc).to.equal('2.0')
            expect(data.method).to.equal('ping')
            expect(data.id).to.equal(1)
            expect(opts.timeout).to.equal(5000)
        })

        it('returns false when response has no result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: {} })
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.ping()
            expect(result).to.be.false
        })

        it('returns false on network error', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(new Error('ECONNREFUSED'))
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.ping()
            expect(result).to.be.false
        })

        it('returns false on timeout', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(new Error('timeout of 5000ms exceeded'))
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.ping()
            expect(result).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // updateConfig()
    // -------------------------------------------------------------------

    describe('updateConfig()', function () {

        it('returns true when response contains a result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: true } })
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.updateConfig({ bitcoin: {} })
            expect(result).to.be.true
        })

        it('sends correct JSON-RPC payload with config in params', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: true } })
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const config = { bitcoin: { mainnet: { encoder: { host: 'enc-host' } } } }
            await connector.updateConfig(config)

            const [url, data, opts] = axiosStub.post.firstCall.args
            expect(data.method).to.equal('updateconfig')
            expect(data.params).to.deep.equal({ config: config })
            expect(opts.timeout).to.equal(10000)
        })

        it('returns false when response has no result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: {} })
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.updateConfig({})
            expect(result).to.be.false
        })

        it('returns false on network error', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(new Error('ECONNREFUSED'))
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.updateConfig({})
            expect(result).to.be.false
        })
    })
})
