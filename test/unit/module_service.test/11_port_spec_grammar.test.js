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

// Pins the one `-p` grammar the port validator and the host-port conflict
// check share: split on the last colon, host port is the field before it.

const { sinon, expect, proxyquire, moduleSuite } = require('./support/helpers')
const { validatePort } = require('../../../src/services/config_service/validation')
const { parsePortSpec } = require('../../../src/services/module_service/docker_args')
// Load a fresh copy so a sibling suite's configureDependencies cannot swap validatePort.
const { validatePortArgs } = proxyquire('../../../src/services/module_service/build_and_up', {
    '../config_service': { validatePort }
})

moduleSuite('configureDependencies()', function () {
    it('configureDependencies keeps its own getPublishedHostPorts and getUtxoTrackerVolumeName when the injected value is absent', async function () {
        const ownGetUtxoTrackerVolumeName = sinon.stub().returns('own-tracker-volume')
        const ownGetPublishedHostPorts = sinon.stub().resolves(new Map())
        const dockerArgs = proxyquire('../../../src/services/module_service/docker_args', {
            '../config_service': { getUtxoTrackerVolumeName: ownGetUtxoTrackerVolumeName },
            '../docker_service': { getPublishedHostPorts: ownGetPublishedHostPorts }
        })

        dockerArgs.configureDependencies({
            SERVICE_REGISTRY: {
                tracker: {
                    docker: {
                        volumes: [{ hostFn: 'utxoTrackerVolume', container: '/data' }]
                    }
                }
            },
            getUtxoTrackerVolumeName: undefined,
            getPublishedHostPorts: undefined
        })

        const built = dockerArgs.buildModuleDockerArgs('tracker', {}, 'bitcoin', 'mainnet')
        expect(built.volumeArgs).to.deep.equal(['-v', 'own-tracker-volume:/data'])
        expect(ownGetUtxoTrackerVolumeName.calledOnceWithExactly('bitcoin', 'mainnet')).to.equal(true)

        await dockerArgs.assertNoHostPortConflicts(['-p', '8080:80'], 'self')
        expect(ownGetPublishedHostPorts.calledOnceWithExactly()).to.equal(true)
    })
})

moduleSuite('parsePortSpec()', function () {
    it('splits HOST:CONTAINER with an empty ip', function () {
        expect(parsePortSpec('8080:80')).to.deep.equal({ ip: '', hostPort: '8080', containerPort: '80' })
    })

    it('splits IP:HOST:CONTAINER on the last colon', function () {
        expect(parsePortSpec('127.0.0.1:13306:3306')).to.deep.equal({ ip: '127.0.0.1', hostPort: '13306', containerPort: '3306' })
    })

    it('keeps a bracketed IPv6 host address whole', function () {
        expect(parsePortSpec('[::1]:8080:80')).to.deep.equal({ ip: '[::1]', hostPort: '8080', containerPort: '80' })
    })

    it('returns null for a colon-less value or a non-string', function () {
        expect(parsePortSpec('8080')).to.equal(null)
        expect(parsePortSpec(undefined)).to.equal(null)
        expect(parsePortSpec(8080)).to.equal(null)
    })
})

moduleSuite('validatePortArgs()', function () {
    const invalid = (pair) => () => validatePortArgs(['-p', pair])

    it('accepts in-range HOST:CONTAINER pairs and skips colon-less values', function () {
        expect(() => validatePortArgs(['-p', '8080:80', '-v', 'a:b', '-p', '9000'])).not.to.throw()
    })

    it('throws on an out-of-range or non-numeric port', function () {
        expect(invalid('99999:80')).to.throw('Invalid port value in configuration: 99999:80')
        expect(invalid('8080:not_a_port')).to.throw('Invalid port value')
        expect(invalid('8080:')).to.throw('Invalid port value')
    })

    it('refuses an IP-scoped spec even when both ports are valid', function () {
        expect(invalid('127.0.0.1:13306:3306')).to.throw('Invalid port value in configuration: 127.0.0.1:13306:3306')
        expect(invalid('3003:3003:3003')).to.throw('Invalid port value')
    })

    it('throws on a dangling -p with no value', function () {
        expect(() => validatePortArgs(['-p'])).to.throw('Invalid port value')
    })
})
