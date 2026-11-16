# Browser screen streams

The session card opens `/api/browser/stream` through the stream mux only while visible.
The optional `width`, `height` and `dpr` query parameters describe the screen area inside
the card, in CSS pixels, and the viewer's device pixel ratio. The initial stream includes
the measured size; subsequent size changes reconnect after a 250 ms debounce.

The server clamps dimensions to 320–1920 by 240–1200 CSS pixels and scale to 1–3.
The last viewer to open or resize a stream for a tab wins. All viewers of that tab
share its viewport and screencast. A resize applies `Emulation.setDeviceMetricsOverride`
and restarts the screencast with matching `maxWidth` and `maxHeight`. The last viewer
leaving stops the cast and clears the metrics override, restoring Chromium's default.
No watcher means no viewport or screencast commands. Existing clients without size
parameters keep the default size until a viewer supplies dimensions.

Pointer coordinates remain normalized relative to the displayed image, then map to
the frame's CSS viewport dimensions on the server; device scale does not multiply them.
Clamping may leave small margins when the card is smaller than the minimum viewport.

In full screen, Escape belongs to the application: it exits full screen even when
the unlocked page has focus. Capture handling consumes keydown before the page input
handler, and the maximized screen does not forward Escape keyup. Outside full screen,
the unlocked page receives Escape normally. The browser tab strip uses the session tab
presentation; it omits the optional list button because the card has no tab list menu.
