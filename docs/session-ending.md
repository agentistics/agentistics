# Session ending wait ownership

Each ending attempt owns an AbortController. The fleet inactivity waiter subscribes to the shared
fleet feed only until the session becomes inactive or that attempt is cancelled. Both paths remove
the fleet listener and its abort listener; polling stops when no UI or waiter subscribers remain.

The ending wrapper disposes the waiter and both request timers in finally, including timeout and
error paths. Retry cancels the previous attempt before creating a new one. Dismiss and the ending
gate's unmount or session-id change clear ending state and abort its wait. A late result from a
cancelled attempt cannot clear a newer attempt's state. This cancellation stops observation of the
kill outcome; it does not undo a kill request already sent to the server.

A timeout still displays the unconfirmed outcome with retry/dismiss. These outcome controls retain
no inactivity waiter. Mounted fleet views keep their normal subscription until those views unmount.
