// Real Nay dock, notice, watcher and chat; HTTP responses are supplied by the browser test.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { NayDock } from '../src/components/nay/NayDock'
import { refreshVaultWatch } from '../src/lib/vaultWatch'
import { pushAlert, readNayAlerts } from '../src/lib/nayNotifyStore'
import { readNotifications } from '../src/lib/notifications'
import '../src/index.css'

Object.assign(window, { vaultTest: { refreshVaultWatch, readNayAlerts, readNotifications, pushAlert } })
createRoot(document.getElementById('root')!).render(<BrowserRouter>
  <main style={{ padding: 24 }}><h1>Agentistics</h1><p>Ambiente de teste · Nay e aviso do cofre</p></main>
  <NayDock lang="pt" isMobile={window.innerWidth < 768} activeOnly={false} filters={{} as never}
    ctx={{ data: null, currency: 'USD', brlRate: 5, costBasis: 'api', planBasis: { basis: null },
      chatModel: '', setChatModel: () => {}, chatSoundEnabled: false, setChatSoundEnabled: () => {},
      chatSoundId: '', setChatSoundId: () => {} } as never} />
</BrowserRouter>)
