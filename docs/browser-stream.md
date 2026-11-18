# Browser screen streams

The session card opens `/api/browser/stream` through the stream mux only while visible.
The optional `width`, `height` and `dpr` query parameters describe the screen area inside
the card, in CSS pixels, and the viewer's device pixel ratio. The initial stream includes
the measured size; subsequent size changes reconnect after a 250 ms debounce.

The viewer sends its surface size, but the server takes only its **aspect ratio**:
the page is emulated at width = max(surface width, 1024) (at most 1920) and height =
width × aspect (at least 400, at most 3200; a clamp that breaks the aspect widens or
narrows the width, never below 1024). Scale is clamped to 1–3. The model's page is
therefore always a desktop layout (`innerWidth` ≥ 1024, no mobile media query), and the
client scales the frame down to fill the surface exactly: no black bars at any size.
When a viewer leaves and another stays, the page takes the remaining viewer's aspect at
once. The model's browser tools state the same: the viewport follows whoever is watching.
The last viewer to open or resize a stream for a tab wins. All viewers of that tab
share its viewport and screencast. A resize applies `Emulation.setDeviceMetricsOverride`
and restarts the screencast with matching `maxWidth` and `maxHeight`. The last viewer
leaving stops the cast and clears the metrics override, restoring Chromium's default.
No watcher means no viewport or screencast commands. Existing clients without size
parameters keep the default size until a viewer supplies dimensions.

The 3200 height ceiling preserves a desktop width of at least 1024 for tall phone
surfaces (including 360×800 and 390×844), without cropping the model's page.
Each cast start and viewport change receives a monotonically increasing epoch,
including reconnects and tab switches. Frames are ordered by `(epoch, seq)`;
the client rejects frames that do not match its requested surface before consuming
the new connection's first-frame allowance. An equal key from an older server can
only replace a frame when it corrects its size to the current surface.
The server clears cached frames on resize and validates incoming pixels against
the requested viewport, including frames arriving during cast startup. Stale
frames trigger five fast retries, then one retry every five seconds until a good
frame arrives or the last viewer leaves. Exhaustion never leaves a still page
permanently stuck, and teardown cancels the recovery timer.

Pointer coordinates remain normalized relative to the displayed image, then map to
the frame's CSS viewport dimensions on the server; device scale does not multiply them.
Because the frame is scaled uniformly, normalized pointer coordinates stay exact after the scale-down.

In full screen, Escape belongs to the application: it exits full screen even when
the unlocked page has focus. Capture handling consumes keydown before the page input
handler, and the maximized screen does not forward Escape keyup. Outside full screen,
the unlocked page receives Escape normally. The browser tab strip uses the session tab
presentation; it omits the optional list button because the card has no tab list menu.
