// Pure platform resolution for the @agentistics/agentop npm postinstall.
//
// Mirrors the gate in /install.sh (Linux x86_64 only, same error message shape).
// install.sh cannot be sourced from here — it is fetched standalone via
// `curl | bash` with no local checkout at run time — so this check is kept in
// sync by hand. See CLAUDE.md's PKG_FILES comment in release.yml for the same
// documented trade-off (two things that must agree, checked nowhere but here).

// The repository moved from blpsoares/ to agentistics/. Both owners are tried, new first, so a
// package published on either side of the transfer can still find its binary.
const REPOS = ['agentistics/agentistics', 'blpsoares/agentistics'];
const REPO = REPOS[0];
const BINARY = 'agentop';

// node's process.platform/process.arch -> the `uname -s` / `uname -m` strings
// install.sh's error messages are phrased in terms of, so a Node-side failure
// reads the same way as a curl|bash one.
const OS_NAMES = {
  linux: 'Linux',
  darwin: 'Darwin',
  win32: 'Windows',
};

const ARCH_NAMES = {
  x64: 'x86_64',
  arm64: 'arm64',
  ia32: 'x86',
};

function displayOs(platform) {
  return OS_NAMES[platform] || platform;
}

function displayArch(arch) {
  return ARCH_NAMES[arch] || arch;
}

/**
 * @param {string} platform - process.platform value
 * @param {string} arch - process.arch value
 * @param {string} version - the npm package's own version (no leading "v")
 * @returns {{ok: true, url: string, urls: string[]} | {ok: false, message: string}}
 */
function resolveAsset(platform, arch, version) {
  if (platform !== 'linux') {
    return {
      ok: false,
      message: `Error: only Linux binaries are published at the moment (detected: ${displayOs(platform)}).`,
    };
  }

  if (arch !== 'x64') {
    return {
      ok: false,
      message: `Error: only x86_64 binaries are published at the moment (detected: ${displayArch(arch)}).`,
    };
  }

  const urls = REPOS.map((r) => `https://github.com/${r}/releases/download/v${version}/${BINARY}`);
  return { ok: true, url: urls[0], urls };
}

// True when the ancestor package.json (the root of whatever checkout this
// package sits in) IS the agentistics monorepo itself, rather than some
// unrelated project that installed @agentistics/agentop as a dependency.
// `bun install` at this repo's own root runs every workspace member's
// postinstall (workspace-local scripts are trusted by default, unlike a
// dependency's) — so without this check, every contributor's `bun install`,
// and any CI job that runs it for an unrelated reason (e.g. the Windows
// desktop build, which has nothing to do with the agentop CLI), downloaded
// an 87MB binary it never uses, and failed outright on a platform this npm
// package doesn't support. The repo already builds its own binary via
// `bun run build:binary` — the npm postinstall exists for EXTERNAL installs.
/**
 * @param {{name?: string} | null} ancestorPkg - the parsed package.json 3
 *   levels up from this file (repo root), or null if none was found/readable
 * @returns {boolean}
 */
function isMonorepoCheckout(ancestorPkg) {
  return ancestorPkg != null && ancestorPkg.name === 'agentistics';
}

module.exports = { resolveAsset, isMonorepoCheckout, REPO, REPOS, BINARY };
