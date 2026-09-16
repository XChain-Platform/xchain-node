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

/**
 * The rate-limit error behind a 403, or null when the 403 means something else.
 * Told apart by the remaining-quota header rather than by the status alone,
 * because a 403 is also what a genuinely forbidden request returns and the two
 * need different advice.
 *
 * @param {Error} error the HTTP client's error
 * @returns {Error|null} an error naming the reset time, or null
 */
function githubRateLimitError(error) {
    const res = error.response;
    if (!res || res.status !== 403 || res.headers?.['x-ratelimit-remaining'] !== '0') return null;
    const resetSec = Number(res.headers['x-ratelimit-reset']);
    const resetAt  = Number.isFinite(resetSec) ? new Date(resetSec * 1000).toISOString() : 'unknown';
    return new Error(`GitHub API rate limit exhausted for this IP (resets ${resetAt}); set GITHUB_TOKEN to raise the limit`);
}

module.exports = { githubApiHeaders, githubRateLimitError };
