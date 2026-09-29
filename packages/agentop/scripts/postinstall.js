#!/usr/bin/env node
// Downloads the native `agentop` binary this npm package's own version was
// released with, from the same GitHub Release install.sh downloads from —
// npm is an ADDITIONAL install channel for the identical binary, never a
// separate build. Unlike install.sh (which always grabs the rolling
// `latest` release), this fetches the VERSION-TAGGED asset — an `npm i
// @agentistics/agentop@1.20.0` must download the 1.20.0 binary, not
// whatever happens to be newest on GitHub.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { resolveAsset, isMonorepoCheckout } = require('./platform.js');

const pkg = require('../package.json');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'agentop-bin');
const MAX_REDIRECTS = 5;
// packages/agentop/scripts -> packages/agentop -> packages -> repo root
const MONOREPO_ROOT_PKG = path.join(__dirname, '..', '..', '..', 'package.json');

function readAncestorPkg() {
  try {
    return JSON.parse(fs.readFileSync(MONOREPO_ROOT_PKG, 'utf8'));
  } catch {
    return null;
  }
}

function download(url, destPath, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': '@agentistics/agentop-postinstall' } }, (res) => {
        const { statusCode, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects while downloading the agentop binary.'));
            return;
          }
          download(headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${statusCode} for ${url}`));
          return;
        }

        const file = fs.createWriteStream(destPath, { mode: 0o755 });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  if (isMonorepoCheckout(readAncestorPkg())) {
    console.log(
      'Skipping agentop binary download — running inside the agentistics monorepo itself (build it with `bun run build:binary`).'
    );
    return;
  }

  const asset = resolveAsset(process.platform, process.arch, pkg.version);

  if (!asset.ok) {
    console.error(asset.message);
    console.error(
      'The agentop CLI is not available for this platform via npm. See https://github.com/agentistics/agentistics for other install options.'
    );
    process.exit(1);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  let lastErr = null;
  for (const url of asset.urls) {
    console.log(`Downloading agentop from ${url} ...`);
    try {
      await download(url, BIN_PATH, MAX_REDIRECTS);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  fs.chmodSync(BIN_PATH, 0o755);
  console.log(`Installed: ${BIN_PATH}`);
}

main().catch((err) => {
  console.error(`Failed to install the agentop binary: ${err.message}`);
  process.exit(1);
});
