import Module from 'node:module'

const originalResolveFilename = Module._resolveFilename

// Stryker 10's Mocha adapter still uses the pre-12 extensionless names for
// CommonJS CLI helpers, while Mocha 12 publishes those helpers as .cjs files.
Module._resolveFilename = function (request, parent, isMain, options) {
    if (typeof request === 'string' && request.endsWith('/mocha/lib/cli/run-helpers')) request += '.cjs'
    if (typeof request === 'string' && request.endsWith('/mocha/lib/cli/collect-files')) request += '.cjs'
    if (typeof request === 'string' && request.endsWith('/mocha/lib/cli/options')) request += '.cjs'
    return originalResolveFilename.call(this, request, parent, isMain, options)
}

const runner = await import('@stryker-mutator/mocha-runner')

export const strykerPlugins = runner.strykerPlugins
export const strykerValidationSchema = runner.strykerValidationSchema
