# Mobile push

Mobile operating-system notifications require the dashboard to be on HTTPS. Agentistics does not
configure a tunnel or advertise the dashboard. The owner may publish the local dashboard to the
tailnet only, from the machine that runs Agentistics:

```sh
tailscale serve --bg http://127.0.0.1:47292
tailscale serve status
```

Open the HTTPS tailnet URL on the phone, install the PWA, then enable **Settings → Notifications →
Receive notifications on this device**. Do not use `tailscale funnel` or a public tunnel. To remove
the mapping, the owner runs `tailscale serve reset`.

On iOS, push requires an installed PWA and iOS 16.4 or newer. Vibration while silent follows the
iOS haptics setting.
