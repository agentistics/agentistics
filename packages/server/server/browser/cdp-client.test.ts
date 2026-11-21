import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { CdpClient, NulFramer } from './cdp-client'

describe('NulFramer', () => {
  test('splits, keeps a partial tail, joins across chunks', () => {
    const f = new NulFramer()
    expect(f.push(Buffer.from('{"a":1}\0{"b"'))).toEqual(['{"a":1}'])
    expect(f.push(Buffer.from(':2}\0\0'))).toEqual(['{"b":2}', ''])
  })
  test('a multi-byte character split across chunks survives', () => {
    const f = new NulFramer()
    const bytes = Buffer.from('{"t":"ação"}\0')
    const cut = bytes.indexOf(0xc3) + 1
    expect(f.push(bytes.subarray(0, cut))).toEqual([])
    expect(f.push(bytes.subarray(cut))).toEqual(['{"t":"ação"}'])
  })
  test('a runaway message is refused', () => {
    const f = new NulFramer(8)
    expect(() => f.push(Buffer.from('0123456789'))).toThrow()
  })
})

function pair() {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  const written: any[] = []
  toBrowser.on('data', (d: Buffer) => { for (const s of d.toString().split('\0').filter(Boolean)) written.push(JSON.parse(s)) })
  return { client: new CdpClient(toBrowser, fromBrowser, 200), fromBrowser, written }
}

describe('CdpClient', () => {
  test('request/response by id, NUL-framed', async () => {
    const { client, fromBrowser, written } = pair()
    const p = client.send('Browser.getVersion')
    await Bun.sleep(5)
    expect(written[0]).toEqual({ id: 1, method: 'Browser.getVersion', params: {} })
    fromBrowser.write('{"id":1,"result":{"product":"X"}}\0')
    expect(await p).toEqual({ product: 'X' })
  })
  test('errors reject with the method name', async () => {
    const { client, fromBrowser } = pair()
    const p = client.send('Page.navigate', { url: 'x' }, 'S1')
    fromBrowser.write('{"id":1,"error":{"code":-32000,"message":"bad"}}\0')
    await expect(p).rejects.toThrow('Page.navigate: bad')
  })
  test('events go to listeners with their sessionId', async () => {
    const { client, fromBrowser } = pair()
    const seen: any[] = []
    client.on((e) => seen.push(e))
    fromBrowser.write('{"method":"Page.loadEventFired","params":{"t":1},"sessionId":"S"}\0')
    await Bun.sleep(5)
    expect(seen).toEqual([{ method: 'Page.loadEventFired', params: { t: 1 }, sessionId: 'S' }])
  })
  test('a timeout rejects', async () => {
    const { client } = pair()
    await expect(client.send('Slow.thing')).rejects.toThrow('timed out')
  })
  test('the pipe closing rejects every pending command and refuses new ones', async () => {
    const { client, fromBrowser } = pair()
    let why = ''
    client.onClose((w) => { why = w })
    const p = client.send('A.b', {}, undefined, 10_000)
    fromBrowser.end()
    await expect(p).rejects.toThrow('closed')
    expect(why).toBe('pipe closed')
    expect(client.closed).toBe(true)
    await expect(client.send('C.d')).rejects.toThrow('closed')
  })
})
