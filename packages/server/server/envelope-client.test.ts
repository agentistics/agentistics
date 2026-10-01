import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeamConnection } from '@agentistics/core'
import { __setTeamConnDirForTests } from './config'
import { __resetEnvelopeKeysForTests, loadOrCreateKeypair, pinPeerKey, pinnedKeyFor } from './envelope-keys'
import { generateMachineKeypair, seal } from './envelope-crypto'
import { encodeRestrictionMessage } from './envelope-message'
import {
  readInbox, writeInbox, mergeProposals, mergeKeyWarnings, recordOpened, hasOpened,
  MAX_PROPOSALS, MAX_OPENED_DIGESTS, type Proposal,
} from './envelope-inbox'
import * as inboxModule from './envelope-inbox'
import { sendRestriction, receiveEnvelopes, parsePeers } from './envelope-client'

const INSTANCE = 'inst-1'
const CONN_ID = 'c_aaaaaaaaaaaa'

const TOKEN = 'member-token'
const SELF = require('node:crypto').createHash('sha256').update(TOKEN).digest('hex') as string
const PEER = generateMachineKeypair()
const PEER_ID = 'peer-machine'

const dirs: string[] = []
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-envelope-client-'))
  dirs.push(dir)
  __setTeamConnDirForTests(dir)
  __resetEnvelopeKeysForTests()
})
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

function conn(over: Partial<TeamConnection> = {}): TeamConnection {
  return {
    id: 'c_aaaaaaaaaaaa',
    endpoint: 'https://central.example',
    org: 'default',
    user: 'me',
    token: TOKEN,
    deniedRepos: [],
    shareMode: 'denylist',
    sources: [{ type: 'repo', value: 'github.com/acme/api' }],
    ...over,
  }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A fake central: serves the peer directory, records deposits, serves an inbox. */
function fakeCentral(opts: { peers?: unknown[]; inbox?: unknown[] } = {}) {
  const deposited: { recipientMachineId: string; envelope: unknown }[] = []
  const acked: string[] = []
  const published: string[] = []
  const fetch = async (url: string, init: { method: string; body?: string }) => {
    if (url.endsWith('/api/team/keys') && init.method === 'POST') {
      published.push(JSON.parse(init.body!).publicKey)
      return jsonRes({ ok: true })
    }
    if (url.endsWith('/api/team/keys')) {
      return jsonRes({ ok: true, machineId: SELF, peers: opts.peers ?? [{ machineId: PEER_ID, machineName: 'laptop-b', publicKey: PEER.publicKey }] })
    }
    if (url.endsWith('/api/team/envelopes') && init.method === 'POST') {
      deposited.push(...JSON.parse(init.body!).envelopes)
      return jsonRes({ ok: true, stored: JSON.parse(init.body!).envelopes.length })
    }
    if (url.endsWith('/api/team/envelopes') && init.method === 'DELETE') {
      acked.push(...JSON.parse(init.body!).ids)
      return jsonRes({ ok: true, deleted: 1 })
    }
    if (url.endsWith('/api/team/envelopes')) return jsonRes({ ok: true, envelopes: opts.inbox ?? [] })
    return new Response('Not found', { status: 404 })
  }
  return { fetch, deposited, acked, published }
}

describe('parsePeers', () => {
  it('returns nothing for an older central or junk, never throws', () => {
    for (const junk of [null, undefined, {}, { peers: 'x' }, { peers: [null, { machineId: '' }, { machineId: 'm' }] }]) {
      expect(parsePeers(junk)).toEqual([])
    }
  })
})

describe('sendRestriction', () => {
  it('publishes only the PUBLIC key and seals the rules to each peer', async () => {
    const central = fakeCentral()
    const kp = await loadOrCreateKeypair()
    const res = await sendRestriction(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })

    expect(res.stored).toBe(1)
    expect(central.published).toEqual([kp.publicKey])
    expect(central.published[0]).not.toBe(kp.privateKey)
    expect(central.deposited).toHaveLength(1)
    expect(central.deposited[0]!.recipientMachineId).toBe(PEER_ID)
  })

  it('what the central receives is opaque — no repo name, no rule, no private key', async () => {
    const central = fakeCentral()
    const kp = await loadOrCreateKeypair()
    await sendRestriction(conn({ sources: [{ type: 'repo', value: 'github.com/acme/secret-repo' }] }), 'inst-1', { fetch: central.fetch, notify: () => {} })
    const wire = JSON.stringify(central.deposited)
    expect(wire).not.toContain('secret-repo')
    expect(wire).not.toContain('denylist')
    expect(wire).not.toContain(kp.privateKey)
  })

  it('skips a peer whose key changed — sealing to a substituted key would hand over the plaintext', async () => {
    await pinPeerKey(CONN_ID, PEER_ID, generateMachineKeypair().publicKey)
    const central = fakeCentral()
    const res = await sendRestriction(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.stored).toBe(0)
    expect(res.skipped).toBe(1)
    expect(central.deposited).toEqual([])
  })

  it('does nothing without a token or an instanceId', async () => {
    const central = fakeCentral()
    expect((await sendRestriction(conn({ token: '' }), INSTANCE, { fetch: central.fetch, notify: () => {} })).stored).toBe(0)
    expect((await sendRestriction(conn(), '', { fetch: central.fetch, notify: () => {} })).stored).toBe(0)
    expect(central.deposited).toEqual([])
  })

  it('an unreachable central is not an error', async () => {
    const dead = async () => { throw new Error('ECONNREFUSED') }
    expect((await sendRestriction(conn(), INSTANCE, { fetch: dead, notify: () => {} })).stored).toBe(0)
  })
})

async function sealedFromPeer(
  plaintext: string,
  over: { senderKeys?: typeof PEER; senderId?: string; recipientMachineId?: string; instanceId?: string; createdAt?: string } = {},
) {
  const me = await loadOrCreateKeypair()
  const keys = over.senderKeys ?? PEER
  return seal({
    plaintext,
    senderMachineId: over.senderId ?? PEER_ID,
    senderPrivateKey: keys.privateKey,
    senderPublicKey: keys.publicKey,
    recipientMachineId: over.recipientMachineId ?? SELF,
    recipientPublicKey: me.publicKey,
    instanceId: over.instanceId ?? INSTANCE,
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  })
}

/** A sibling that hides something this machine does not — i.e. an announcement that actually asks
 *  a question. An announcement adding nothing is a different case, covered below. */
const RULES_MSG = encodeRestrictionMessage({
  kind: 'restriction',
  instanceId: INSTANCE,
  shareMode: 'denylist',
  sources: [{ type: 'repo', value: 'github.com/acme/api' }, { type: 'repo', value: 'github.com/acme/web' }],
  at: '2026-07-31T10:00:00.000Z',
})

/** Byte-for-byte what this machine already applies — what a sibling announces right after applying
 *  THIS machine's proposal. */
const ECHO_MSG = encodeRestrictionMessage({
  kind: 'restriction',
  instanceId: INSTANCE,
  shareMode: 'denylist',
  sources: [{ type: 'repo', value: 'github.com/acme/api' }],
  at: '2026-07-31T10:00:00.000Z',
})

describe('receiveEnvelopes', () => {
  it('decrypts a sibling proposal into the inbox and acknowledges it', async () => {
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const notes: string[] = []
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: n => notes.push(n.code) })

    expect(res.proposals).toBe(1)
    expect(res.keyWarnings).toBe(0)
    const inbox = await readInbox(CONN_ID)
    expect(inbox.proposals).toHaveLength(1)
    expect(inbox.proposals[0]!.fromMachineName).toBe('laptop-b')
    expect(inbox.proposals[0]!.sources).toEqual([
      { type: 'repo', value: 'github.com/acme/api' }, { type: 'repo', value: 'github.com/acme/web' },
    ])
    expect(central.acked).toEqual(['e1'])
    expect(notes).toEqual(['member.peer_pinned', 'member.rules_proposed'])
  })

  it('a machine that announces AGAIN still raises a notification, though it supersedes its own card', async () => {
    // Supersede-per-machine keeps the list one row long, so counting the LENGTH difference would
    // make the second announcement — the one that actually changed what the sibling hides —
    // silent. The user is told about the message, not about the row count.
    await writeInbox(CONN_ID, {
      proposals: [{
        id: 'e0', fromMachineId: PEER_ID, fromMachineName: 'laptop-b', shareMode: 'denylist',
        sources: [{ type: 'repo', value: 'github.com/acme/web' }], at: 'a', receivedAt: 'r',
      }],
      keyWarnings: [], openedDigests: [], siblingRules: [],
    })
    await pinPeerKey(CONN_ID, PEER_ID, PEER.publicKey)
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const notes: string[] = []
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: n => notes.push(n.code) })

    expect(res.proposals).toBe(1)
    expect(notes).toEqual(['member.rules_proposed'])
    const inbox = await readInbox(CONN_ID)
    expect(inbox.proposals.map(p => p.id)).toEqual(['e1'])
  })

  it('refuses a sender whose key changed, warns, and does NOT acknowledge the envelope', async () => {
    // The peer was pinned to a different key first; the directory now advertises a new one.
    await pinPeerKey(CONN_ID, PEER_ID, generateMachineKeypair().publicKey)
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const notes: string[] = []
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: n => notes.push(n.code) })

    expect(res.proposals).toBe(0)
    expect(res.keyWarnings).toBe(1)
    expect((await readInbox(CONN_ID)).proposals).toEqual([])
    // Left on the central so resolving the key does not cost the user the message.
    expect(central.acked).toEqual([])
    expect(notes).toEqual(['member.peer_key_changed'])
  })

  it('an impostor sealing under another machine\'s id is refused', async () => {
    const impostor = generateMachineKeypair()
    const envelope = await sealedFromPeer(RULES_MSG, { senderKeys: impostor })
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(res.keyWarnings).toBe(1)
  })

  it('acknowledges an undecryptable or unparseable envelope rather than looping on it forever', async () => {
    const envelope = await sealedFromPeer('not a restriction message')
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(central.acked).toEqual(['e1'])
  })

  it('pins a first-sight peer from the DIRECTORY, not from an envelope', async () => {
    const central = fakeCentral()
    await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(await pinnedKeyFor(CONN_ID, PEER_ID)).toBe(PEER.publicKey)
  })

  it('an older central (404 everywhere) is a quiet no-op', async () => {
    const old = async () => new Response('Not found', { status: 404 })
    expect(await receiveEnvelopes(conn(), INSTANCE, { fetch: old, notify: () => {} }))
      .toEqual({ proposals: 0, keyWarnings: 0, newPeers: 0, refused: 0 })
  })
})

describe('the inbox never applies anything', () => {
  it('exposes no function that could change local rules', () => {
    // A message that arrives must raise a proposal and stop. If someone adds an apply/enable/set
    // path to this module, this test fails — which is the point.
    const forbidden = Object.keys(inboxModule).filter(k => /^(apply|enable|set|patch|update|install)/i.test(k))
    expect(forbidden).toEqual([])
  })

  it('receiving writes only to the inbox store — never to preferences', async () => {
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    // The proposal is stored as a PROPOSAL, carrying the sender — not merged into any rule set.
    const inbox = await readInbox(CONN_ID)
    expect(inbox.proposals[0]!.fromMachineId).toBe(PEER_ID)
    // The exact key list is the review gate: a new field here is a new thing a received message
    // writes on this machine, and it has to be a deliberate edit. `siblingRules` is the sender's
    // announced rules kept as a FACT — still nothing this machine acts on by itself.
    expect(Object.keys(inbox).sort()).toEqual(['keyWarnings', 'openedDigests', 'proposals', 'siblingRules'])
    // And the local rules are untouched: the fact records what the SENDER does, never what we do.
    expect(inbox.siblingRules[0]!.machineId).toBe(PEER_ID)
  })
})

describe('inbox merging', () => {
  const p = (id: string): Proposal => ({
    id, fromMachineId: 'm', fromMachineName: 'm', shareMode: 'denylist', sources: [], at: 'a', receivedAt: 'r',
  })
  const from = (id: string, machineId: string): Proposal => ({ ...p(id), fromMachineId: machineId })

  it('supersedes an older proposal from the SAME machine — each message is a full snapshot', () => {
    // The owner's screenshot: two cards titled "Alienware restricted repositories for this
    // central". A machine's announcement is its WHOLE rule set, so the moment a newer one arrives
    // the older one is not a second decision, it is a stale copy of the same one.
    const merged = mergeProposals([from('old', 'alienware')], [from('new', 'alienware')])
    expect(merged.map(x => x.id)).toEqual(['new'])
  })

  it('supersedes across a re-read of the store too, not only within one fetch', () => {
    const merged = mergeProposals(
      [from('newer', 'alienware'), from('older', 'alienware')],
      [],
    )
    expect(merged.map(x => x.id)).toEqual(['newer'])
  })

  it('never collapses proposals from DIFFERENT machines', () => {
    const merged = mergeProposals([from('a', 'm1')], [from('b', 'm2')])
    expect(merged.map(x => x.id).sort()).toEqual(['a', 'b'])
  })

  it('deduplicates a proposal that is still in the list', () => {
    // NOTE: this is the "still present" case only. The DISMISSAL case cannot be expressed here —
    // once dismissed the id is gone from the list, so this merge would re-insert it. That property
    // belongs to the opened-digest memory and is asserted at the client level below.
    expect(mergeProposals([p('a')], [p('a')]).map(x => x.id)).toEqual(['a'])
  })

  it('puts fresh proposals first and caps the list', () => {
    // One machine per row: with supersede-per-machine in force, a list this long can only be built
    // by that many DISTINCT siblings, and the cap is the backstop behind that.
    const existing = Array.from({ length: MAX_PROPOSALS }, (_, i) => from(`old${i}`, `m${i}`))
    const merged = mergeProposals(existing, [from('new', 'fresh')])
    expect(merged[0]!.id).toBe('new')
    expect(merged).toHaveLength(MAX_PROPOSALS)
  })

  it('keeps one key warning per machine', () => {
    const w = { machineId: 'm1', machineName: 'a', at: 't1' }
    expect(mergeKeyWarnings([w], [{ ...w, at: 't2' }])).toEqual([w])
  })
})

// --- what a HOSTILE central can try -----------------------------------------------------------
//
// Everything above assumes the central relays honestly. These do not. The central chooses the
// directory, the routing fields beside each envelope, the envelope ids, and when to deliver.

describe('receiveEnvelopes — a hostile central', () => {
  it('refuses a genuine envelope relayed under a machine id the central invented', async () => {
    // The attack the AAD alone does not stop: the central publishes {machineId:'zzz', name:'Laptop
    // A', publicKey:<A's REAL key>}, B pins zzz→A.pub, and A's genuine bytes are served as
    // senderMachineId:'zzz'. The pin matches and GCM verifies; only comparing the wrapper against
    // the sealed header catches it.
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({
      peers: [{ machineId: 'zzz', machineName: 'Laptop A', publicKey: PEER.publicKey }],
      inbox: [{ id: 'e1', senderMachineId: 'zzz', envelope }],
    })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
    expect((await readInbox(CONN_ID)).proposals).toEqual([])
  })

  it('refuses an envelope addressed to a different machine', async () => {
    const envelope = await sealedFromPeer(RULES_MSG, { recipientMachineId: 'someone-else' })
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
  })

  it('refuses an envelope sealed for a DIFFERENT central replayed onto this one', async () => {
    // The keypair is machine-wide, so without the instance check central-2 could transplant
    // central-1's (typically far more permissive) rule set into this machine's card.
    const envelope = await sealedFromPeer(RULES_MSG, { instanceId: 'other-central' })
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
  })

  it('refuses a payload whose named central disagrees with the connection it arrived on', async () => {
    const mismatched = encodeRestrictionMessage({
      kind: 'restriction', instanceId: 'other-central', shareMode: 'denylist', sources: [], at: '2026-07-31T10:00:00.000Z',
    })
    const envelope = await sealedFromPeer(mismatched)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
  })

  it('refuses an envelope withheld and delivered long after it was sealed', async () => {
    const envelope = await sealedFromPeer(RULES_MSG, { createdAt: '2026-06-01T10:00:00.000Z' })
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, {
      fetch: central.fetch, notify: () => {}, now: () => new Date('2026-07-31T10:00:00.000Z'),
    })
    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
  })

  it('opens the same envelope only once, however the central re-labels it', async () => {
    const envelope = await sealedFromPeer(RULES_MSG)
    const first = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    expect((await receiveEnvelopes(conn(), INSTANCE, { fetch: first.fetch, notify: () => {} })).proposals).toBe(1)

    // Same bytes, brand-new envelope id. Replay memory is keyed on the ciphertext, not the id.
    const again = fakeCentral({ inbox: [{ id: 'DIFFERENT-ID', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: again.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
    expect((await readInbox(CONN_ID)).proposals).toHaveLength(1)
  })

  it('a DISMISSED proposal cannot be resurrected by re-sending it', async () => {
    // The downgrade attack: replay a pre-restriction envelope ("shares everything") after the user
    // has already looked at it and said no.
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    const { dismissProposal } = await import('./envelope-inbox')
    expect(await dismissProposal(CONN_ID, 'e1')).toBe(true)
    expect((await readInbox(CONN_ID)).proposals).toEqual([])

    const replay = fakeCentral({ inbox: [{ id: 'e2', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: replay.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect((await readInbox(CONN_ID)).proposals).toEqual([])
  })

  it('announces every peer pinned for the first time — a fabricated machine is never silent', async () => {
    // A central need not SUBSTITUTE a key: it can invent a machine under a key it holds, and TOFU
    // accepts it. Nothing can refuse it automatically, so it must be impossible to do quietly.
    const central = fakeCentral({
      peers: [{ machineId: 'fabricated', machineName: 'Definitely Your Laptop', publicKey: generateMachineKeypair().publicKey }],
    })
    const notes: { code: string; meta?: Record<string, unknown> }[] = []
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: n => notes.push(n) })
    expect(res.newPeers).toBe(1)
    expect(notes.map(n => n.code)).toEqual(['member.peer_pinned'])
    expect(String(notes[0]!.meta!.name)).toContain('Definitely Your Laptop')
  })
})

describe('sendRestriction — a hostile or broken directory', () => {
  it('announces a newly pinned peer before it starts receiving the rules', async () => {
    const central = fakeCentral()
    const notes: string[] = []
    const res = await sendRestriction(conn(), INSTANCE, { fetch: central.fetch, notify: n => notes.push(n.code) })
    expect(res.newPeers.map(p => p.machineName)).toEqual(['laptop-b'])
    expect(notes).toEqual(['member.peer_pinned'])
  })

  it('one junk key in the directory does not stop every OTHER sibling being told', async () => {
    // A single unusable publicKey used to throw inside the peer loop, inside a fire-and-forget
    // caller — a free, silent off-switch for the whole channel.
    const central = fakeCentral({
      peers: [
        { machineId: 'broken', machineName: 'junk', publicKey: 'not-a-key' },
        { machineId: PEER_ID, machineName: 'laptop-b', publicKey: PEER.publicKey },
      ],
    })
    const res = await sendRestriction(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.stored).toBe(1)
    expect(res.skipped).toBe(1)
    expect(central.deposited.map(d => d.recipientMachineId)).toEqual([PEER_ID])
  })
})

describe('replay memory', () => {
  it('remembers newest-first and stays bounded', () => {
    const many = Array.from({ length: MAX_OPENED_DIGESTS }, (_, i) => `d${i}`)
    const next = recordOpened(many, ['fresh'])
    expect(next[0]).toBe('fresh')
    expect(next).toHaveLength(MAX_OPENED_DIGESTS)
  })

  it('does not re-add a digest it already holds', () => {
    expect(recordOpened(['a'], ['a'])).toEqual(['a'])
  })

  it('survives a write/read round-trip, which is what makes a dismissal permanent', async () => {
    await writeInbox(CONN_ID, { proposals: [], keyWarnings: [], openedDigests: ['abc'], siblingRules: [] })
    expect(hasOpened(await readInbox(CONN_ID), 'abc')).toBe(true)
    expect(hasOpened(await readInbox(CONN_ID), 'other')).toBe(false)
  })
})

describe('receiveEnvelopes — a sender the directory never listed', () => {
  it('refuses a ghost machine: omitted from the directory, injected as the sender', async () => {
    // The cheaper twin of the fabricated-peer attack. Rather than publishing a peer (which C2 now
    // announces), the central publishes NOTHING and seals under its own keypair as a machine id it
    // invented. No pin is ever taken, so `pinnedKeyFor` is null, `open` skips the pin comparison —
    // and member.peer_pinned never fires, because there is nothing to pin.
    const ghost = generateMachineKeypair()
    const envelope = await sealedFromPeer(RULES_MSG, { senderKeys: ghost, senderId: 'ghost-machine' })
    const central = fakeCentral({ peers: [], inbox: [{ id: 'e1', senderMachineId: 'ghost-machine', envelope }] })
    const notes: string[] = []
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: n => notes.push(n.code) })

    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
    expect((await readInbox(CONN_ID)).proposals).toEqual([])
    expect(notes).toEqual([])
  })

  it('refuses an unpinned sender even when the directory lists OTHER machines', async () => {
    const ghost = generateMachineKeypair()
    const envelope = await sealedFromPeer(RULES_MSG, { senderKeys: ghost, senderId: 'ghost-machine' })
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: 'ghost-machine', envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(0)
    expect(res.refused).toBe(1)
  })

  it('still accepts a genuine first-sight sender, which the directory always lists', async () => {
    // No legitimate race: publishAndFetchPeers publishes the sender's key before it deposits, so a
    // real sender is in the directory the receiver just read.
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(1)
    expect(res.refused).toBe(0)
  })
})

// --- the FACT, kept apart from the PROPOSAL ------------------------------------------------------
//
// One envelope produces two things with different lifetimes. The PROPOSAL is an offer ("apply this
// here too") and dies when the user dismisses it. The FACT is knowledge ("that machine withholds
// this repository") and must outlive that dismissal, because it is the only evidence the reverse
// warning can be built from — the central has none, by design.

describe('sibling rule facts', () => {
  it('records the sender\'s announced rules as a fact beside the proposal', async () => {
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })

    const inbox = await readInbox(CONN_ID)
    expect(inbox.siblingRules).toHaveLength(1)
    const fact = inbox.siblingRules[0]!
    expect(fact.machineId).toBe(PEER_ID)
    expect(fact.machineName).toBe('laptop-b')
    expect(fact.shareMode).toBe('denylist')
    expect(fact.sources).toEqual([
      { type: 'repo', value: 'github.com/acme/api' }, { type: 'repo', value: 'github.com/acme/web' },
    ])
    expect(fact.at).toBe('2026-07-31T10:00:00.000Z')
    expect(fact.receivedAt).not.toBe('')
  })

  it('DISMISSING the proposal does not erase the fact — they are different statements', async () => {
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect((await readInbox(CONN_ID)).proposals).toHaveLength(1)

    const { dismissProposal } = await import('./envelope-inbox')
    expect(await dismissProposal(CONN_ID, 'e1')).toBe(true)

    const after = await readInbox(CONN_ID)
    expect(after.proposals).toEqual([])
    expect(after.siblingRules).toHaveLength(1)
    expect(after.siblingRules[0]!.sources).toEqual([
      { type: 'repo', value: 'github.com/acme/api' }, { type: 'repo', value: 'github.com/acme/web' },
    ])
  })

  it('a later announcement from the same machine SUPERSEDES the earlier fact', async () => {
    const first = await sealedFromPeer(RULES_MSG)
    await receiveEnvelopes(conn(), INSTANCE, {
      fetch: fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope: first }] }).fetch,
      notify: () => {},
    })
    const lifted = await sealedFromPeer(encodeRestrictionMessage({
      kind: 'restriction', instanceId: INSTANCE, shareMode: 'denylist', sources: [],
      at: '2026-08-01T10:00:00.000Z',
    }))
    await receiveEnvelopes(conn(), INSTANCE, {
      fetch: fakeCentral({ inbox: [{ id: 'e2', senderMachineId: PEER_ID, envelope: lifted }] }).fetch,
      notify: () => {},
    })

    const inbox = await readInbox(CONN_ID)
    expect(inbox.siblingRules).toHaveLength(1)
    // The sibling lifted its restriction, so the fact must retract — not accumulate beside the old one.
    expect(inbox.siblingRules[0]!.sources).toEqual([])
    expect(inbox.siblingRules[0]!.at).toBe('2026-08-01T10:00:00.000Z')
  })

  it('a refused envelope contributes no fact — testimony this machine could not verify is not knowledge', async () => {
    const mismatched = encodeRestrictionMessage({
      kind: 'restriction', instanceId: 'other-central', shareMode: 'allowlist', sources: [], at: '2026-07-31T10:00:00.000Z',
    })
    const envelope = await sealedFromPeer(mismatched)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect((await readInbox(CONN_ID)).siblingRules).toEqual([])
  })

  it('an inbox written before this field existed reads as no facts, never as a crash', async () => {
    await writeInbox(CONN_ID, { proposals: [], keyWarnings: [], openedDigests: [] } as never)
    expect((await readInbox(CONN_ID)).siblingRules).toEqual([])
  })
})

describe('an announcement that adds nothing is not a proposal — the apply ping-pong', () => {
  it('raises no card and no notification when the sibling announces rules this machine already has', async () => {
    // Applying a proposal changes this machine's rules, which announces them back to the sibling,
    // which could apply them, which announces again — forever. The announcement is right; turning
    // it into a DECISION when there is nothing to decide is what loops.
    const envelope = await sealedFromPeer(ECHO_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const notes: string[] = []
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: n => notes.push(n.code) })

    expect(res.proposals).toBe(0)
    expect((await readInbox(CONN_ID)).proposals).toEqual([])
    expect(notes).not.toContain('member.rules_proposed')
    // Still dealt with: acknowledged and remembered, never re-offered as new.
    expect(central.acked).toEqual(['e1'])
  })

  it('KEEPS the fact, so the reverse warning still knows the sibling withholds that repository', async () => {
    const envelope = await sealedFromPeer(ECHO_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })

    const facts = (await readInbox(CONN_ID)).siblingRules
    expect(facts).toHaveLength(1)
    expect(facts[0]!.machineId).toBe(PEER_ID)
    expect(facts[0]!.sources).toEqual([{ type: 'repo', value: 'github.com/acme/api' }])
  })

  it('still raises the card when the sibling restricts something new', async () => {
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({ inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }] })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(1)
  })
})

describe('a machine id is never dressed up as a machine name', () => {
  it('parsePeers leaves an unnamed peer unnamed rather than naming it after its id', () => {
    // `machineId` is sha256(token). Defaulting the NAME to it put a credential-derived string on
    // the connection card — meaningless to a person, and another machine's internals. An unnamed
    // machine is a fact; the UI says so in words.
    const peers = parsePeers({ peers: [{ machineId: 'a'.repeat(64), publicKey: 'k' }] })
    expect(peers).toHaveLength(1)
    expect(peers[0]!.machineName).toBe('')
  })

  it('a proposal and its fact from an unnamed sender carry no id in the name field', async () => {
    const envelope = await sealedFromPeer(RULES_MSG)
    const central = fakeCentral({
      peers: [{ machineId: PEER_ID, publicKey: PEER.publicKey }],
      inbox: [{ id: 'e1', senderMachineId: PEER_ID, envelope }],
    })
    const res = await receiveEnvelopes(conn(), INSTANCE, { fetch: central.fetch, notify: () => {} })
    expect(res.proposals).toBe(1)
    const inbox = await readInbox(CONN_ID)
    expect(inbox.proposals[0]!.fromMachineName).toBe('')
    expect(inbox.siblingRules[0]!.machineName).toBe('')
  })
})
