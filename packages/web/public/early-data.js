/* Starts the first-screen data request while the app bundle is still downloading.
 * Over a slow link the slim payload (~90 KB) used to be asked for only AFTER every boot chunk had
 * been fetched and executed; asking now overlaps the two. The app (src/lib/startupLoad.ts
 * `takeEarlySlim`) consumes this promise once and falls back to its own request when it is
 * missing, late or not OK, so this file is an optimisation and never a dependency. */
(function () {
  try {
    window.__agEarlySlim = fetch('/api/data?partial=1&slim=1', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r : null })
      .catch(function () { return null })
  } catch (e) { /* the app asks for itself */ }
})()
