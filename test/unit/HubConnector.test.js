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

// Axios-style error for a non-2xx response that still carries a valid JSON-RPC
// body — e.g. the hub's HTTP 503 "degraded" health response when its DB pool is
// down. Axios attaches the full response to the thrown error as err.response.
function degraded503Error(body) {
    const err = new Error('Request failed with status code 503')
    err.response = {
        status: 503,
        data: { jsonrpc: '2.0', id: 1, result: body || { status: 'degraded', db: false } }
    }
    return err
}

describe('HubConnector', function () {

    // -------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------

    describe('constructor', function () {

        it('builds urls array with http://<host>:<port> from host+port args', function () {
            const HubConnector = loadConnector(makeAxiosStub())
            const connector = new HubConnector('localhost', 10000)
            expect(connector.urls).to.be.an('array').with.lengthOf(1)
            expect(connector.urls[0]).to.equal('http://localhost:10000')
        })

        it('stores a single-element urls array when constructed with host+port', function () {
            const HubConnector = loadConnector(makeAxiosStub())
            const connector = new HubConnector('127.0.0.1', 8765)
            expect(connector.urls).to.be.an('array').with.lengthOf(1)
            expect(connector.urls[0]).to.equal('http://127.0.0.1:8765')
        })

        it('handles IP addresses in urls array', function () {
            const HubConnector = loadConnector(makeAxiosStub())
            const connector = new HubConnector('192.168.1.100', 3000)
            expect(connector.urls).to.be.an('array').with.lengthOf(1)
            expect(connector.urls[0]).to.equal('http://192.168.1.100:3000')
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

        it('returns true (reachable) for a 503 "degraded" hub rather than masking it as down', async function () {
            // A live hub with a dead DB pool must NOT read the same as a crashed
            // one, or the install/restart loop would exhaust its retries against
            // a hub that is actually running.
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(degraded503Error())
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector.ping()
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // _call() — degraded-response handling
    // -------------------------------------------------------------------

    describe('_call()', function () {

        it('surfaces the JSON-RPC body of a 503 "degraded" response instead of discarding it', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(degraded503Error())
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector._call({ jsonrpc: '2.0', method: 'ping', id: 1 })
            expect(result).to.deep.equal({ status: 'degraded', db: false })
        })

        it('prefers a healthy endpoint over a degraded one', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.onFirstCall().rejects(degraded503Error())
            axiosStub.post.onSecondCall().resolves({ data: { result: 'pong' } })
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector(['http://hub1:10000', 'http://hub2:10000'])
            const result = await connector._call({ jsonrpc: '2.0', method: 'ping', id: 1 })
            expect(result).to.equal('pong')
            expect(axiosStub.post.callCount).to.equal(2)
        })

        it('returns null when an endpoint is truly unreachable (no err.response)', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(new Error('ECONNREFUSED'))
            const HubConnector = loadConnector(axiosStub)
            const connector = new HubConnector('localhost', 10000)
            const result = await connector._call({ jsonrpc: '2.0', method: 'ping', id: 1 })
            expect(result).to.be.null
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
            expect(opts.timeout).to.equal(60000)
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
