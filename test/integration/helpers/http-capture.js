'use strict'

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
 * HttpCapture - records axios.post calls and returns configurable responses.
 *
 * Usage:
 *   const capture = new HttpCapture()
 *   capture.when('http://127.0.0.1:10000').returns({ data: { result: true } })
 *   // Use capture.createAxiosStub() as the axios replacement
 */
class HttpCapture {
    constructor() {
        this._history = []
        this._routes = []
        this._defaultResponse = { data: { result: true } }
    }

    when(urlPattern) {
        const route = { pattern: urlPattern, response: { data: { result: true } }, callCount: 0, failCount: 0 }
        this._routes.push(route)
        return {
            returns: (response) => {
                route.response = response
                return this
            },
            rejects: (error) => {
                route.error = error
                return this
            },
            failsThenSucceeds: (failCount, errorOrNull, successResponse) => {
                route.failCount = failCount
                route.failError = errorOrNull || new Error('Request failed')
                route.response = successResponse || { data: { result: true } }
                return this
            }
        }
    }

    setDefault(response) {
        this._defaultResponse = response
        return this
    }

    _matchRoute(url) {
        for (const route of this._routes) {
            let matches = false
            if (route.pattern instanceof RegExp) {
                matches = route.pattern.test(url)
            } else {
                matches = url.includes(route.pattern)
            }
            if (matches) {
                route.callCount++
                if (route.failCount && route.callCount <= route.failCount) {
                    return { error: route.failError }
                }
                if (route.error) {
                    return { error: route.error }
                }
                return { response: route.response }
            }
        }
        return { response: this._defaultResponse }
    }

    createAxiosStub() {
        const self = this
        const stub = {
            post: async function (url, data, config) {
                self._history.push({ url, data, config, timestamp: Date.now() })
                const result = self._matchRoute(url)
                if (result.error) throw result.error
                return result.response
            },
            get: async function (url, config) {
                self._history.push({ url, data: null, config, method: 'get', timestamp: Date.now() })
                const result = self._matchRoute(url)
                if (result.error) throw result.error
                return result.response
            }
        }
        return stub
    }

    history() {
        return this._history
    }

    getPayloads(urlPattern) {
        return this._history
            .filter(entry => {
                if (urlPattern instanceof RegExp) return urlPattern.test(entry.url)
                return entry.url.includes(urlPattern)
            })
            .map(entry => entry.data)
    }

    callCount(urlPattern) {
        if (!urlPattern) return this._history.length
        return this._history.filter(entry => {
            if (urlPattern instanceof RegExp) return urlPattern.test(entry.url)
            return entry.url.includes(urlPattern)
        }).length
    }

    reset() {
        this._history = []
        this._routes.forEach(r => { r.callCount = 0 })
    }
}

module.exports = HttpCapture
