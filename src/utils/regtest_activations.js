'use strict'

const fs = require('fs')

const REGTEST_ACTIVATION_KEY = /^XC_[A-Z0-9_]+_REGTEST_ACTIVATION$/
const NON_NEGATIVE_INTEGER = /^\d+$/

function parseRegtestActivations(input) {
    const value = String(input || '').trim()
    if (!value) return []

    return value.split(/\s+/).map(pair => {
        const separator = pair.indexOf('=')
        const key = separator === -1 ? pair : pair.slice(0, separator)
        const activation = separator === -1 ? '' : pair.slice(separator + 1)

        if (!REGTEST_ACTIVATION_KEY.test(key)) {
            throw new Error(`invalid regtest activation key "${key}"; expected XC_*_REGTEST_ACTIVATION`)
        }
        if (!NON_NEGATIVE_INTEGER.test(activation)) {
            throw new Error(`invalid value for ${key}; expected a non-negative integer`)
        }
        return [key, activation]
    })
}

function appendRegtestActivations(input, githubEnvPath) {
    const pairs = parseRegtestActivations(input)
    if (!pairs.length) return pairs
    if (!githubEnvPath) throw new Error('GITHUB_ENV path is required')

    fs.appendFileSync(githubEnvPath, pairs.map(([key, value]) => `${key}=${value}\n`).join(''))
    return pairs
}

if (require.main === module) {
    try {
        appendRegtestActivations(process.argv[2], process.argv[3])
    } catch (err) {
        process.stderr.write(`regtest_activations: ${err.message}\n`)
        process.exitCode = 1
    }
}

module.exports = { REGTEST_ACTIVATION_KEY, parseRegtestActivations, appendRegtestActivations }
