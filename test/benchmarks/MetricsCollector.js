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
 * Performance metrics collector for xchain-node benchmarks.
 *
 * Provides high-resolution timing, resource snapshots, percentile
 * calculations, and event loop delay monitoring.
 */

const { performance, monitorEventLoopDelay } = require('perf_hooks')

class MetricsCollector {
    constructor() {
        this._timers = new Map()
        this._measurements = new Map()  // name -> [durations in ms]
        this._snapshots = []
        this._eventLoopHistogram = null
        this._startCpuUsage = null
        this._startTime = null
    }

    start() {
        this._startTime = performance.now()
        this._startCpuUsage = process.cpuUsage()
        this._eventLoopHistogram = monitorEventLoopDelay({ resolution: 10 })
        this._eventLoopHistogram.enable()
    }

    stop() {
        if (this._eventLoopHistogram) {
            this._eventLoopHistogram.disable()
        }
    }

    startTimer(name) {
        const key = `${name}_${Date.now()}_${Math.random()}`
        this._timers.set(key, performance.now())
        return key
    }

    endTimer(key, measurementName) {
        const start = this._timers.get(key)
        if (start == null) return 0
        const duration = performance.now() - start
        this._timers.delete(key)

        const name = measurementName || key.split('_')[0]
        if (!this._measurements.has(name)) {
            this._measurements.set(name, [])
        }
        this._measurements.get(name).push(duration)
        return duration
    }

    record(name, durationMs) {
        if (!this._measurements.has(name)) {
            this._measurements.set(name, [])
        }
        this._measurements.get(name).push(durationMs)
    }

    takeSnapshot(label) {
        this._snapshots.push({
            label,
            time: performance.now() - (this._startTime || 0),
            memory: process.memoryUsage(),
            cpu: process.cpuUsage(this._startCpuUsage)
        })
    }

    _percentile(sorted, p) {
        if (sorted.length === 0) return 0
        const idx = Math.ceil(sorted.length * p / 100) - 1
        return sorted[Math.max(0, idx)]
    }

    getStats(name) {
        const values = this._measurements.get(name)
        if (!values || values.length === 0) {
            return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, total: 0 }
        }

        const sorted = [...values].sort((a, b) => a - b)
        const total = values.reduce((s, v) => s + v, 0)

        return {
            count: values.length,
            mean: total / values.length,
            p50: this._percentile(sorted, 50),
            p95: this._percentile(sorted, 95),
            p99: this._percentile(sorted, 99),
            min: sorted[0],
            max: sorted[sorted.length - 1],
            total
        }
    }

    getWallTime() {
        return performance.now() - (this._startTime || 0)
    }

    getCpuUsage() {
        return process.cpuUsage(this._startCpuUsage)
    }

    getEventLoopStats() {
        const h = this._eventLoopHistogram
        if (!h) return { p50: 0, p95: 0, p99: 0, mean: 0, max: 0 }
        return {
            mean: h.mean / 1e6,  // ns -> ms
            p50: h.percentile(50) / 1e6,
            p95: h.percentile(95) / 1e6,
            p99: h.percentile(99) / 1e6,
            max: h.max / 1e6
        }
    }

    getPeakMemory() {
        if (this._snapshots.length === 0) {
            const mem = process.memoryUsage()
            return { heapUsedMB: mem.heapUsed / 1048576, rssMB: mem.rss / 1048576 }
        }
        let peakHeap = 0, peakRss = 0
        for (const s of this._snapshots) {
            peakHeap = Math.max(peakHeap, s.memory.heapUsed)
            peakRss = Math.max(peakRss, s.memory.rss)
        }
        return { heapUsedMB: peakHeap / 1048576, rssMB: peakRss / 1048576 }
    }

    getMeasurementNames() {
        return [...this._measurements.keys()]
    }

    getRawValues(name) {
        return this._measurements.get(name) || []
    }

    buildReport(metadata = {}) {
        const measurements = {}
        for (const name of this._measurements.keys()) {
            measurements[name] = this.getStats(name)
        }

        return {
            ...metadata,
            wallTimeMs: this.getWallTime(),
            cpu: this.getCpuUsage(),
            eventLoop: this.getEventLoopStats(),
            peakMemory: this.getPeakMemory(),
            measurements,
            snapshotCount: this._snapshots.length
        }
    }

    reset() {
        this._timers.clear()
        this._measurements.clear()
        this._snapshots = []
        this._eventLoopHistogram = null
        this._startCpuUsage = null
        this._startTime = null
    }
}

module.exports = MetricsCollector
