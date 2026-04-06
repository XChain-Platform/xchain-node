'use strict'

const sinon = require('sinon')

/**
 * CommandCapture - records child_process.exec/spawn calls and returns configurable responses.
 *
 * Usage:
 *   const capture = new CommandCapture()
 *   capture.when(/docker run/).returns({ stdout: 'abc123...' })
 *   capture.when(/docker build/).returns({ stdout: '' })
 *   const execStub = capture.createExecStub()
 *
 * Then assert:
 *   capture.history()          // all recorded calls
 *   capture.findCommands(/docker run/)  // matching calls
 *   capture.assertCalled(/docker run/)  // throws if not found
 */
class CommandCapture {
    constructor() {
        this._history = []
        this._routes = []
        this._defaultResponse = { stdout: '', stderr: '' }
    }

    /**
     * Register a pattern-based response route.
     * Returns a builder with .returns({ stdout, stderr, error })
     */
    when(pattern) {
        const route = { pattern, response: { stdout: '', stderr: '' }, dynamic: null }
        this._routes.push(route)
        return {
            returns: (response) => {
                route.response = response
                return this
            },
            /**
             * Dynamic response: fn(command) => { stdout, stderr, error }
             */
            respondsWith: (fn) => {
                route.dynamic = fn
                return this
            }
        }
    }

    /**
     * Set the default response for unmatched commands.
     */
    setDefault(response) {
        this._defaultResponse = response
        return this
    }

    /**
     * Find the matching route for a command string.
     */
    _matchRoute(command) {
        for (const route of this._routes) {
            let matches = false
            if (route.pattern instanceof RegExp) {
                matches = route.pattern.test(command)
            } else if (typeof route.pattern === 'string') {
                matches = command.includes(route.pattern)
            }
            if (matches) {
                if (route.dynamic) return route.dynamic(command)
                return route.response
            }
        }
        return this._defaultResponse
    }

    /**
     * Create a stub for child_process.exec (callback style).
     * Compatible with: exec(command, [options], callback)
     */
    createExecStub() {
        const self = this
        return function execStub(command, ...rest) {
            let options = {}
            let callback = null

            if (typeof rest[0] === 'function') {
                callback = rest[0]
            } else if (rest.length >= 2) {
                options = rest[0] || {}
                callback = rest[1]
            }

            self._history.push({ command, options, type: 'exec', timestamp: Date.now() })
            const response = self._matchRoute(command)

            if (callback) {
                process.nextTick(() => {
                    if (response.error) {
                        callback(response.error, response.stdout || '', response.stderr || '')
                    } else {
                        callback(null, response.stdout || '', response.stderr || '')
                    }
                })
            }

            // Return a minimal ChildProcess-like object
            return { kill: () => {}, on: () => {} }
        }
    }

    /**
     * Create a stub for promisified exec (util.promisify(exec)).
     */
    createExecAsyncStub() {
        const self = this
        return async function execAsyncStub(command, options) {
            self._history.push({ command, options: options || {}, type: 'execAsync', timestamp: Date.now() })
            const response = self._matchRoute(command)

            if (response.error) {
                throw response.error
            }
            return { stdout: response.stdout || '', stderr: response.stderr || '' }
        }
    }

    /**
     * Create a stub for child_process.spawn.
     * Returns a minimal object with stdout/stderr event emitters.
     */
    createSpawnStub() {
        const self = this
        return function spawnStub(command, args, options) {
            const fullCommand = command + ' ' + (args || []).join(' ')
            self._history.push({ command: fullCommand, args, options: options || {}, type: 'spawn', timestamp: Date.now() })

            const EventEmitter = require('events')
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            child.kill = sinon.stub()
            child.pid = 12345

            return child
        }
    }

    /**
     * Create a stub for child_process.spawnSync.
     */
    createSpawnSyncStub() {
        const self = this
        return function spawnSyncStub(command, args, options) {
            const fullCommand = command + ' ' + (args || []).join(' ')
            self._history.push({ command: fullCommand, args, options: options || {}, type: 'spawnSync', timestamp: Date.now() })
            return { status: 0, stdout: '', stderr: '' }
        }
    }

    // --- Query methods ---

    history() {
        return this._history
    }

    findCommands(pattern) {
        return this._history.filter(entry => {
            if (pattern instanceof RegExp) return pattern.test(entry.command)
            return entry.command.includes(pattern)
        })
    }

    assertCalled(pattern, message) {
        const matches = this.findCommands(pattern)
        if (matches.length === 0) {
            const cmds = this._history.map(e => '  ' + e.command).join('\n')
            throw new Error(
                (message || `Expected command matching ${pattern} to be called`) +
                `\n\nRecorded commands:\n${cmds || '  (none)'}`
            )
        }
        return matches
    }

    assertNotCalled(pattern, message) {
        const matches = this.findCommands(pattern)
        if (matches.length > 0) {
            throw new Error(
                (message || `Expected command matching ${pattern} NOT to be called`) +
                `\n\nBut found: ${matches.map(e => e.command).join(', ')}`
            )
        }
    }

    /**
     * Assert a command was called and its string contains all specified flags/fragments.
     */
    assertCommandContains(pattern, fragments) {
        const matches = this.assertCalled(pattern)
        const cmd = matches[0].command
        for (const fragment of fragments) {
            if (!cmd.includes(fragment)) {
                throw new Error(
                    `Command matching ${pattern} missing fragment "${fragment}"\n\nFull command:\n  ${cmd}`
                )
            }
        }
        return matches[0]
    }

    reset() {
        this._history = []
    }
}

module.exports = CommandCapture
