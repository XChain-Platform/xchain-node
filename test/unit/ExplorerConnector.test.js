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

function makeAxiosStub() {
    return { post: sinon.stub() }
}

function loadConnector(axiosStub) {
    return proxyquire('../../src/ExplorerConnector', {
        'axios': axiosStub
    })
}

describe('ExplorerConnector', function () {

    describe('constructor', function () {

        it('builds the URL as http://<url>:<port>', function () {
            const ExplorerConnector = loadConnector(makeAxiosStub())
            const connector = new ExplorerConnector('localhost', 18080)
            expect(connector.url).to.equal('http://localhost:18080')
        })

        it('stores the port on the instance', function () {
            const ExplorerConnector = loadConnector(makeAxiosStub())
            const connector = new ExplorerConnector('127.0.0.1', 8080)
            expect(connector.port).to.equal(8080)
        })
    })

    describe('ping()', function () {

        it('returns true when response contains a result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: 'pong' } })
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            const result = await connector.ping()
            expect(result).to.be.true
        })

        it('sends correct JSON-RPC payload', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: { result: 'pong' } })
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            await connector.ping()

            const [url, data] = axiosStub.post.firstCall.args
            expect(url).to.equal('http://localhost:18080')
            expect(data.jsonrpc).to.equal('2.0')
            expect(data.method).to.equal('ping')
            expect(data.id).to.equal(1)
        })

        it('returns false when response has no result', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.resolves({ data: {} })
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            const result = await connector.ping()
            expect(result).to.be.false
        })

        it('returns false on network error', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.post.rejects(new Error('ECONNREFUSED'))
            const ExplorerConnector = loadConnector(axiosStub)
            const connector = new ExplorerConnector('localhost', 18080)
            const result = await connector.ping()
            expect(result).to.be.false
        })
    })
})

// probe() splits the single boolean ping() reports into the two facts the install
// path needs. The explorer answers 503 whenever it holds no DB pool, which is the
// CORRECT state on a host whose coin stacks are not installed yet, and a 503 is an
// answer while a refused connection is not. Collapsing both to false made the
// first install of a stack unsatisfiable: the explorer is installed before any
// coin, so it could never report healthy and the install failed after ten seconds.
describe('ExplorerConnector.probe()', function () {

    const rpcOk = { data: { jsonrpc: '2.0', result: { status: 'success', db: true }, id: 1 } }

    function connectorWith(axiosStub) {
        const ExplorerConnector = loadConnector(axiosStub)
        return new ExplorerConnector('localhost', 18080)
    }

    it('a success result is answering AND healthy', async function () {
        const axiosStub = makeAxiosStub()
        axiosStub.post.resolves(rpcOk)
        expect(await connectorWith(axiosStub).probe()).to.deep.equal({ answering: true, healthy: true })
    })

    it('a 503 is ANSWERING but not healthy: the server replied, it just holds no pool', async function () {
        const axiosStub = makeAxiosStub()
        const err = new Error('Request failed with status code 503')
        err.response = { status: 503, data: { result: undefined } }
        axiosStub.post.rejects(err)
        expect(await connectorWith(axiosStub).probe()).to.deep.equal({ answering: true, healthy: false })
    })

    it('a refused connection is neither: nothing answered', async function () {
        const axiosStub = makeAxiosStub()
        axiosStub.post.rejects(new Error('connect ECONNREFUSED 127.0.0.1:18080'))
        expect(await connectorWith(axiosStub).probe()).to.deep.equal({ answering: false, healthy: false })
    })

    it('a timeout is neither, so a hung explorer cannot pass as installed', async function () {
        const axiosStub = makeAxiosStub()
        axiosStub.post.rejects(new Error('timeout of 5000ms exceeded'))
        expect(await connectorWith(axiosStub).probe()).to.deep.equal({ answering: false, healthy: false })
    })

    it('a 200 carrying no result is answering but not healthy', async function () {
        const axiosStub = makeAxiosStub()
        axiosStub.post.resolves({ data: { jsonrpc: '2.0', error: { message: 'nope' }, id: 1 } })
        expect(await connectorWith(axiosStub).probe()).to.deep.equal({ answering: true, healthy: false })
    })

    it('ping() keeps its old contract, reporting probe()s health half only', async function () {
        const okStub = makeAxiosStub()
        okStub.post.resolves(rpcOk)
        expect(await connectorWith(okStub).ping()).to.be.true

        const degraded = makeAxiosStub()
        const err = new Error('Request failed with status code 503')
        err.response = { status: 503 }
        degraded.post.rejects(err)
        expect(await connectorWith(degraded).ping()).to.be.false
    })
})
