/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Config Service Path Helpers
 ********************************************************************/

'use strict'

function createPathReaders(dependencies) {
    const { fs, moduleDir, tmpDir, cryptoNodesDir, Coin, stringToCoin } = dependencies

    function getModuleDir(module) {
        return moduleDir + "/" + module
    }

    function getModuleTmpDir(module) {
        return tmpDir + "/" + module
    }

    function getCryptoNodeDir(coin) {
        if (!(coin in Coin)) coin = stringToCoin(coin)
        return cryptoNodesDir + "/" + Coin[coin]
    }

    function moduleDirExists(module) {
        return fs.existsSync(getModuleDir(module))
    }

    return { getModuleDir, getModuleTmpDir, getCryptoNodeDir, moduleDirExists }
}

function createPathOperations(dependencies, readers) {
    const { fs } = dependencies
    const { getModuleDir, getModuleTmpDir, getCryptoNodeDir } = readers

    function removeModuleDir(module) {
        fs.rmSync(getModuleDir(module), { recursive: true })
    }

    function removeModuleTmpDir(module) {
        const dir = getModuleTmpDir(module)
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
    }

    function createModuleTmpDir(module) {
        const dir = getModuleTmpDir(module)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir)
    }

    function checkIfModuleExists(module) {
        const dir = getModuleDir(module)
        return fs.existsSync(dir)
            && fs.existsSync(dir + "/Dockerfile")
            && fs.existsSync(dir + "/src")
            && fs.existsSync(dir + "/package.json")
    }

    function checkIfCryptoNodeSourceExists(coin) {
        const dir = getCryptoNodeDir(coin)
        return fs.existsSync(dir)
            && fs.existsSync(dir + "/Dockerfile")
            && fs.existsSync(dir + "/src")
    }

    return {
        removeModuleDir,
        removeModuleTmpDir,
        createModuleTmpDir,
        checkIfModuleExists,
        checkIfCryptoNodeSourceExists
    }
}

function configure(dependencies) {
    const readers = createPathReaders(dependencies)
    Object.assign(module.exports, readers, createPathOperations(dependencies, readers))
}

module.exports = { configure }
