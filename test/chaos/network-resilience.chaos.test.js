'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadHubConnector(axiosStub) {
    return proxyquire('../../src/HubConnector', {
        'axios': axiosStub
    })
}

function loadExplorerConnector(axiosStub) {
    return proxyquire('../../src/ExplorerConnector', {
        'axios': axiosStub
    })
}

describe('Chaos: Network Resilience (Hub/Explorer)', function () {

    afterEach(function () {
        sinon.restore()
    })

    // -------------------------------------------------------------------
    // Experiment 15: Hub registration failures (NET-04)
    // -------------------------------------------------------------------

    describe('Experiment 15: Hub connector resilience', function () {

        it('returns false when hub is unreachable (ECONNREFUSED)', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('connect ECONNREFUSED 127.0.0.1:10000'))
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })

        it('returns false when hub times out', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('timeout of 5000ms exceeded'))
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })

        it('returns false when hub returns empty response', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: {} })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })

        it('returns false when hub returns null data', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: null })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })

        it('returns true when hub responds with result', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { result: true } })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.true
        })

        it('updateConfig returns false when hub is unreachable', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('ECONNREFUSED'))
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.updateConfig({ key: 'value' })
            expect(result).to.be.false
        })

        it('updateConfig returns false when hub returns HTTP 500', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('Request failed with status code 500'))
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.updateConfig({ key: 'value' })
            expect(result).to.be.false
        })

        it('updateConfig returns false when response has no result', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { error: 'something went wrong' } })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.updateConfig({ key: 'value' })
            expect(result).to.be.false
        })

        it('updateConfig returns true on successful response', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { result: true } })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.updateConfig({ key: 'value' })
            expect(result).to.be.true
        })

        it('updateConfig sends correct JSON-RPC payload', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { result: true } })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const configPayload = { services: ['xchain-encoder'], coin: 'bitcoin' }
            await hub.updateConfig(configPayload)

            const [url, data, opts] = axiosStub.post.firstCall.args
            expect(url).to.equal('http://127.0.0.1:10000')
            expect(data.jsonrpc).to.equal('2.0')
            expect(data.method).to.equal('updateconfig')
            expect(data.params.config).to.deep.equal(configPayload)
            expect(opts.timeout).to.equal(10000)
        })
    })

    // -------------------------------------------------------------------
    // Experiment 15b: Explorer registration failures (NET-05)
    // -------------------------------------------------------------------

    describe('Experiment 15b: Explorer connector resilience', function () {

        it('returns false when explorer is unreachable', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('connect ECONNREFUSED 127.0.0.1:18080'))
            }
            const ExplorerConnector = loadExplorerConnector(axiosStub)
            const explorer = new ExplorerConnector('127.0.0.1', 18080)

            const result = await explorer.ping()
            expect(result).to.be.false
        })

        it('returns false when explorer times out', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('timeout exceeded'))
            }
            const ExplorerConnector = loadExplorerConnector(axiosStub)
            const explorer = new ExplorerConnector('127.0.0.1', 18080)

            const result = await explorer.ping()
            expect(result).to.be.false
        })

        it('returns false when explorer returns empty response', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: {} })
            }
            const ExplorerConnector = loadExplorerConnector(axiosStub)
            const explorer = new ExplorerConnector('127.0.0.1', 18080)

            const result = await explorer.ping()
            expect(result).to.be.false
        })

        it('returns false when explorer returns error in response', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { error: { code: -32601, message: 'Method not found' } } })
            }
            const ExplorerConnector = loadExplorerConnector(axiosStub)
            const explorer = new ExplorerConnector('127.0.0.1', 18080)

            const result = await explorer.ping()
            expect(result).to.be.false
        })

        it('returns true when explorer responds with result', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { result: true } })
            }
            const ExplorerConnector = loadExplorerConnector(axiosStub)
            const explorer = new ExplorerConnector('127.0.0.1', 18080)

            const result = await explorer.ping()
            expect(result).to.be.true
        })

        it('sends correct JSON-RPC ping payload', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { result: true } })
            }
            const ExplorerConnector = loadExplorerConnector(axiosStub)
            const explorer = new ExplorerConnector('127.0.0.1', 18080)

            await explorer.ping()

            const [url, data] = axiosStub.post.firstCall.args
            expect(url).to.equal('http://127.0.0.1:18080')
            expect(data.jsonrpc).to.equal('2.0')
            expect(data.method).to.equal('ping')
            expect(data.id).to.equal(1)
        })
    })

    // -------------------------------------------------------------------
    // Experiment: DNS resolution failure
    // -------------------------------------------------------------------

    describe('Experiment: DNS resolution failure for service endpoints', function () {

        it('hub returns false on DNS failure', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('getaddrinfo ENOTFOUND xchain-node-xchain-hub'))
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('xchain-node-xchain-hub', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })

        it('explorer returns false on DNS failure', async function () {
            const axiosStub = {
                post: sinon.stub().rejects(new Error('getaddrinfo ENOTFOUND xchain-node-xchain-explorer'))
            }
            const ExplorerConnector = loadExplorerConnector(axiosStub)
            const explorer = new ExplorerConnector('xchain-node-xchain-explorer', 18080)

            const result = await explorer.ping()
            expect(result).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Malformed JSON-RPC responses
    // -------------------------------------------------------------------

    describe('Experiment: Malformed JSON-RPC responses', function () {

        it('hub returns false when response.data is undefined', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({})
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })

        it('hub returns false when result is false', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { result: false } })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })

        it('hub returns false when result is null', async function () {
            const axiosStub = {
                post: sinon.stub().resolves({ data: { result: null } })
            }
            const HubConnector = loadHubConnector(axiosStub)
            const hub = new HubConnector('127.0.0.1', 10000)

            const result = await hub.ping()
            expect(result).to.be.false
        })
    })
})
