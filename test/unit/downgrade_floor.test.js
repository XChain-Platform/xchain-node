'use strict'

const sinon = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const selfUpdate = require('../../src/services/self_update_service')

function testLogger() {
    return { log: sinon.stub(), warn: sinon.stub(), error: sinon.stub() }
}

function loadManifestService(axiosGet = sinon.stub()) {
    return proxyquire('../../src/services/release_manifest_service', {
        axios: { get: axiosGet },
        './release_signature_service': { verifyManifestForTag: sinon.stub().resolves({ verified: true }) }
    })
}

afterEach(function () {
    sinon.restore()
})

describe('major-version downgrade floor: self-update', function () {
    it('refuses to move a 1.0.0 CLI to release v0.23.0 before touching git', async function () {
        const describeCarrier = sinon.stub().resolves({ isRepo: true, commit: 'a'.repeat(40), dirty: [] })

        await selfUpdate.selfUpdateAndReexec({
            tag: 'v0.23.0',
            childArgs: ['update'],
            deps: {
                env: {},
                logger: testLogger(),
                currentVersion: () => '1.0.0',
                describeCarrier
            }
        }).then(
            () => { throw new Error('should have rejected') },
            err => {
                expect(err.message).to.match(/major version 0 is below.*major version 1/)
                expect(err.message).to.include('XCHAIN_NODE_ALLOW_MAJOR_DOWNGRADE=1')
                expect(err.message).to.include('Nothing was changed')
            }
        )

        expect(describeCarrier.called).to.equal(false)
    })

    it('does not turn a same-major version decrease into a refusal', function () {
        expect(() => selfUpdate.assertMajorDowngradeAllowed('1.9.0', 'v1.0.0')).not.to.throw()
    })

})

describe('major-version downgrade floor: manifest refusals', function () {
    it('refuses an explicit lower-major install before fetching its manifest', async function () {
        const axiosGet = sinon.stub()
        const service = loadManifestService(axiosGet)

        await service.resolveInstallTarget('v0.23.0', {
            env: {},
            logger: testLogger(),
            installedVersion: '1.0.0'
        }).then(
            () => { throw new Error('should have rejected') },
            err => expect(err.message).to.match(/Refusing release v0\.23\.0/)
        )

        expect(axiosGet.called).to.equal(false)
    })

    it('refuses a latest lower-major update before fetching its manifest', async function () {
        const axiosGet = sinon.stub().resolves({ data: { tag_name: 'v0.23.0' } })
        const service = loadManifestService(axiosGet)

        await service.resolveInstallTarget(null, {
            fallbackToBranch: false,
            env: {},
            logger: testLogger(),
            installedVersion: '1.0.0'
        }).then(
            () => { throw new Error('should have rejected') },
            err => expect(err.message).to.match(/Refusing release v0\.23\.0/)
        )

        expect(axiosGet.calledOnce).to.equal(true)
    })

})

describe('major-version downgrade floor: overrides', function () {
    it('allows the self-update override and announces it even when self-update is disabled', async function () {
        const logger = testLogger()
        const out = await selfUpdate.selfUpdateAndReexec({
            tag: 'v0.23.0',
            childArgs: ['update'],
            deps: {
                env: {
                    XCHAIN_NODE_ALLOW_MAJOR_DOWNGRADE: '1',
                    XCHAIN_NODE_NO_SELF_UPDATE: '1'
                },
                logger,
                currentVersion: () => '1.0.0'
            }
        })

        expect(out.reason).to.equal('disabled')
        expect(logger.warn.calledOnce).to.equal(true)
        expect(logger.warn.firstCall.args[0]).to.include('major-version downgrade protection is disabled')
    })

    it('announces the manifest override on every target-resolution run', async function () {
        const service = loadManifestService()
        const logger = testLogger()
        const options = {
            env: { XCHAIN_NODE_ALLOW_MAJOR_DOWNGRADE: 'yes' },
            logger,
            installedVersion: '1.0.0'
        }

        await service.resolveInstallTarget('develop', options)
        await service.resolveInstallTarget('master', options)

        expect(logger.warn.callCount).to.equal(2)
        expect(logger.warn.alwaysCalledWithMatch(/XCHAIN_NODE_ALLOW_MAJOR_DOWNGRADE=1/)).to.equal(true)
    })

    it('allows a lower-major release target when the manifest override is set', async function () {
        // The bundled manifest's own release resolves without a network read, so
        // the target follows that manifest across release bumps.
        const bundledTag = `v${require('../../src/release-manifest.json').platform_version}`
        const service = loadManifestService()
        const logger = testLogger()
        const target = await service.resolveInstallTarget(bundledTag, {
            env: { XCHAIN_NODE_ALLOW_MAJOR_DOWNGRADE: 'true' },
            logger,
            installedVersion: '1.0.0'
        })

        expect(target.kind).to.equal('release')
        expect(target.tag).to.equal(bundledTag)
        expect(logger.warn.calledOnce).to.equal(true)
    })
})
