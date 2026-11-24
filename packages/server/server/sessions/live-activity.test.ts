import { test, expect } from 'bun:test'
import { toControlSession } from './control-session'
import { cliStrings } from '../cli-i18n'
import { liveAge } from '../../../web/src/lib/asideTabs'
import { joinLive } from '../../../web/src/components/tasks/liveDeliveryModel'
import { cardStateWord } from '../../../web/src/components/tasks/liveCardModel'

for (const signal of ['tool', 'heavy-lock', 'output']) test(`QA Live consumes the same ${signal} evidence as the sidebar`, () => {
  const v: any = { id:'w', cwd:'/tmp/qa', harness:'claude', status:'running', activity:'waiting', attached:false, approvalDetection:false, searchFields:{name:'',folder:'',harness:'',note:'',task:'',prompt:''},
    ...(signal === 'tool' ? {chatTurns:[{role:'assistant',text:'Running Bash',pending:true}]} : signal === 'heavy-lock' ? {heavyLock:'waiting'} : {outputMoved:true}) }
  const c = toControlSession(v, cliStrings('pt'))
  expect(c.activeSignal).toBe(signal as any)
  const d: any = {key:'t/s',taskId:'t',taskTitle:'T',subtaskId:'s',title:'S',status:'in_progress',stage:'running',stageSinceMs:0,startedAtMs:0,sessionIds:['w'],blockedReason:null}
  const card = joinLive([d], [c] as any)[0]!
  console.log(`QA ${signal}: sidebar=${liveAge(c,Date.now(),true)}; fleet.state=${c.state}; Live=${cardStateWord(card,true)}; liveState=${card.liveState}`)
  expect(cardStateWord(card,true)).toBe(signal === 'heavy-lock' ? 'na fila' : 'trabalhando')
})
