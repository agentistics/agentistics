# @agentistics/agentop

npm install for the `agentop` CLI — the same native binary published on
[GitHub Releases](https://github.com/agentistics/agentistics/releases) and
installed by the project's `curl | bash` script. This package is only an
**additional** install channel; it downloads and runs the identical binary,
never a JS reimplementation.

## Install

```bash
npm i -g @agentistics/agentop
```

`postinstall` downloads the `agentop` binary matching this package's own
version from the corresponding GitHub Release and makes it executable.

## Supported platforms

Linux x86_64 only, same as the current GitHub Release. Installing on any
other platform fails during `postinstall` with a clear error instead of
leaving a broken binary in place.

## Usage

```bash
agentop server       # web dashboard + daemon
agentop tui           # terminal TUI
agentop watch         # daemon only
```

See the [main README](https://github.com/agentistics/agentistics#readme) for
full CLI documentation.

## Alternative install

```bash
curl -fsSL https://agentop.openvibes.tech/cli | bash
```

Both methods install the exact same binary.
