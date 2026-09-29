# Licensing

Agentistics is **source-available**. You can read, run, modify and self-host all of it. It
becomes **open source (Apache-2.0) two years after each release**.

## What licence covers what

| Path | Licence |
|---|---|
| Everything in this repository, unless listed below | [FSL-1.1-ALv2](LICENSE) (Functional Source License, Apache-2.0 future licence) |
| A package whose own `LICENSE` file says Apache-2.0 | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Reserved for the integration surface: the hub contract, the SDK and the adapter SDK, once each exists as its own package |

Each package's `package.json` `license` field states its licence. `licensing.lint.test.ts` fails the
build when a field disagrees with this table. It also fails when an Apache-2.0 package depends on
an FSL package, because an Apache package that bundles FSL code would not really be Apache.

## What you may do (FSL-1.1-ALv2)

You may do anything **except a Competing Use**: making the software available to others in a
commercial product or service that substitutes for it, or offers the same or substantially similar
functionality. In plain terms:

| You want to… | Allowed? |
|---|---|
| Use it yourself, at home or at work | Yes |
| Install it inside your company for your employees, on any number of machines | Yes, free, with no licence key and no registration |
| Modify it for your own or your company's internal use | Yes |
| Self-host the team central for your own organisation | Yes |
| Write your own adapter, integration, plugin or extension | Yes |
| Fork it to experiment, study or contribute back | Yes |
| As a consultancy, install, configure and support it **on your client's own infrastructure**, and charge for that work | Yes (the licence names professional services explicitly) |
| Offer it to others as a hosted or managed service | No, not without a commercial agreement |
| Rebrand it (white-label) and sell or distribute it | No, not without a commercial agreement |
| Sell it, or a modified version of it, as your own product | No, not without a commercial agreement |
| Build a competing product or service on top of it | No, not without a commercial agreement |

**Two years after each release**, that release is also available under Apache-2.0, and from then
on the restrictions above no longer apply to it.

For anything in the "No" rows, or any case you are unsure about, open an issue or contact the
maintainer. Commercial licences are available.

## History: everything up to `mit-final` stays MIT

Agentistics was released under the MIT licence up to the commit tagged **`mit-final`**. The last
release published under MIT is v2.68.7. **Every version and every commit published up to and
including `mit-final` remains available under MIT, and always will.** The licence change applies only to work published
after that point. Nothing already published was relicensed retroactively.

## Contributions

Contributions are accepted under the [Contributor License Agreement](CLA.md). You keep ownership of
your contribution; you grant the maintainer permission to license it on any terms. That permission
is what makes it possible to offer the software under both FSL and commercial licences. See
[CONTRIBUTING.md](CONTRIBUTING.md#licensing-of-contributions).

## Trademarks

The licence grants no rights to the Agentistics name or logo. See [TRADEMARKS.md](TRADEMARKS.md).
