import React from 'react'
import { createRoot } from 'react-dom/client'
import { VaultBulkFixture, fakeVaultFetch } from './vault-bulk-fixture'
import '../src/index.css'
globalThis.fetch = fakeVaultFetch(new URLSearchParams(location.search).has('partial')).fetcher
createRoot(document.getElementById('root')!).render(<VaultBulkFixture mobile={innerWidth < 768} />)
