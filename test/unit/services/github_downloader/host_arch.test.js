'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const { getHostArch } = require('../../../../src/services/github_downloader/host_arch')

const originalArchDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')

function setProcessArch(arch) {
    Object.defineProperty(process, 'arch', { ...originalArchDescriptor, value: arch })
}

describe('getHostArch', function () {
    afterEach(function () {
        Object.defineProperty(process, 'arch', originalArchDescriptor)
    })

    it('maps x64 to x86_64', function () {
        setProcessArch('x64')

        expect(getHostArch()).to.equal('x86_64')
    })

    it('maps arm64 to aarch64', function () {
        setProcessArch('arm64')

        expect(getHostArch()).to.equal('aarch64')
    })

    for (const arch of ['ia32', 'ppc64']) {
        it(`rejects unsupported architecture ${arch}`, function () {
            setProcessArch(arch)

            expect(getHostArch).to.throw(Error, `Unsupported host architecture for GitHub asset download: ${arch}`)
        })
    }
})
