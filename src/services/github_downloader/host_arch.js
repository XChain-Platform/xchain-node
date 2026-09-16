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
 * XChain Node - Github Downloader host architecture
 *
 * This file maps the host architecture to the GitHub release asset key
 *
 ********************************************************************/

// Map Node's process.arch to the substring used in GitHub release asset names
// for crypto-node tarballs (bitcoin-core / litecoin / dogecoin). Mirrors
// NodeService.js's archMap for bitcoincore.org downloads.
const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64' };

function getHostArch() {
    const arch = ARCH_MAP[process.arch];
    if (!arch) throw new Error(`Unsupported host architecture for GitHub asset download: ${process.arch}`);
    return arch;
}

module.exports = { getHostArch };
