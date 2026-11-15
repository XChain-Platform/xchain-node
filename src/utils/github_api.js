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
 *
 * XChain Node - talking to api.github.com
 *
 * The two things every caller of the GitHub API here needs: the headers to send
 * and the way to recognise the one failure that is not a failure of the
 * request. They live here rather than on the downloader because three modules
 * use them, and a helper with two owners does not belong to either.
 *
 ********************************************************************/

const config = require('../config');

// Bound every GitHub request (axios defaults to none) so a stalled route rejects and advisory
// callers degrade instead of hanging; it caps the wait for headers and each idle gap, not a body.
const GITHUB_API_TIMEOUT_MS = 20000;
// Release assets come from object storage behind a redirect; give them the bootstrap download's bound.
const GITHUB_DOWNLOAD_TIMEOUT_MS = 60000;

/**
 * Headers for an api.github.com call.
 *
 * Unauthenticated api.github.com calls share a 60-req/hr per-IP quota, which a busy host
 * exhausts (403 on every version check). An optional token (GITHUB_TOKEN or GH_TOKEN, any
 * scope) raises it to 5000/hr. api.github.com endpoints only: release-asset downloads
 * follow a redirect to S3, which rejects requests carrying an extra Authorization header.
 *
 * @returns {object} headers to pass to the HTTP client
 */
function githubApiHeaders() {
    const headers = { 'User-Agent': 'GitHubDownloader' };
    const token = config.GITHUB_TOKEN || config.GH_TOKEN;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

// When the limit lifts, as an ISO time, or 'unknown'. retry-after is the wait
// GitHub asks for on this response (delta seconds or an HTTP date) and wins when
// present. x-ratelimit-reset is the primary window's absolute reset, so it only
// applies when quota is exhausted or unreported: on a secondary limit that still
// shows quota remaining it points at an unrelated window.
function rateLimitResetAt(headers) {
    const retryAfter = headers['retry-after'];
    if (retryAfter !== undefined && retryAfter !== '') {
        const waitMs = Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(waitMs)) return new Date(Date.now() + waitMs).toISOString();
    }
    const remaining = headers['x-ratelimit-remaining'];
    const reset = Number(headers['x-ratelimit-reset']);
    const exhaustedOrUnreported = remaining === undefined || remaining === '0';
    if (exhaustedOrUnreported && headers['x-ratelimit-reset'] !== '' && Number.isFinite(reset) && reset > 0) {
        return new Date(reset * 1000).toISOString();
    }
    return 'unknown';
}

/**
 * The rate-limit error behind a 429, or behind a 403 that is a rate limit, or
 * null when the response means something else. A 429 is always a rate limit. A
 * 403 is told apart by the remaining-quota header (primary limit) or a
 * retry-after header (secondary limit) rather than by the status alone, because
 * a 403 is also what a genuinely forbidden request returns and the two need
 * different advice.
 *
 * @param {Error} error the HTTP client's error
 * @returns {Error|null} an error naming the reset time, or null
 */
function githubRateLimitError(error) {
    const res = error && error.response;
    if (!res || (res.status !== 403 && res.status !== 429)) return null;
    const headers = res.headers || {};
    const limited = res.status === 429
        || headers['x-ratelimit-remaining'] === '0'
        || headers['retry-after'] !== undefined;
    if (!limited) return null;
    return new Error(`GitHub API rate limit exhausted for this IP (resets ${rateLimitResetAt(headers)}); set GITHUB_TOKEN to raise the limit`);
}

module.exports = { githubApiHeaders, githubRateLimitError, GITHUB_API_TIMEOUT_MS, GITHUB_DOWNLOAD_TIMEOUT_MS };
