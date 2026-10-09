import { chromium } from 'playwright'
const O=process.env.SHOTS_DIR, base='http://localhost:48712'
const b = await chromium.launch()
for (const [name,w,h] of [['desktop',1280,800],['mobile',390,844]]) {
  const ctx = await b.newContext({ viewport:{width:w,height:h}, hasTouch: name==='mobile' })
  const p = await ctx.newPage()
  for (const [sid] of [['agentop-aaaaaaaaaa']]) {
    await p.goto(base+'/sessions/'+sid, {waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000)
    for (let k=0;k<4;k++){ for (const n of [/Don.t show again/i,/^Not now$/i,/^Close$/i]) { const bt=p.getByRole('button',{name:n}).first(); if (await bt.count()) { await bt.click({timeout:2000}).catch(()=>{}); await p.waitForTimeout(500) } } }
    await p.screenshot({path:O+'/'+name+'-closed.png'})
    const i = p.getByTestId('session-link-info').first()
    console.log(name,'icon count', await p.getByTestId('session-link-info').count())
    await i.click(); await p.waitForTimeout(400)
    await p.screenshot({path:O+'/'+name+'-popover.png'})
    await p.keyboard.press('Escape')
    const a = p.locator('a[href="https://example.com/docs"]').first()
    console.log(name,'link count', await p.locator('a[href="https://example.com/docs"]').count())
    if (name==='desktop') await a.click({button:'right'})
    else { const bx=await a.boundingBox(); const c=await ctx.newCDPSession(p); const pt=[{x:bx.x+8,y:bx.y+bx.height/2,id:1}]
      await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:pt}); await p.waitForTimeout(900); await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}) }
    await p.waitForTimeout(400)
    await p.screenshot({path:O+'/'+name+'-linkmenu.png'})
    console.log(name,'menu items', await p.locator('[role=menuitem]').allInnerTexts())
  }
  await ctx.close()
}
await b.close()
