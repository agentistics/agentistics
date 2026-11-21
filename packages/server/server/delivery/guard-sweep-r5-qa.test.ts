import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorld, shot, T } from './evidence-world.testing'
import { createTaskStore } from '../sessions/task-store'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createGuardsStore } from './guards-store'
import { execGit } from './classify-host'

test('QA acceptance group with real evidence records every accepted member', async () => {
 const root=mkdtempSync(join(tmpdir(),'qa-r4-accept-'))
 try {
  const w=makeWorld(root)
  const tasks=createTaskStore(join(root,'tasks.json'),{guard:{deps:{sessions:async()=>w.sessions,git:execGit},now:()=>T}})
  const at=new Date(T).toISOString()
  const def=(id:string,stage:string,order:number)=>({id,label:id,stage,order,color:'#112233',protected:true}) as never
  await tasks.seedStatuses([def('todo','queue',0),def('in_progress','running',1),def('done','published',2),def('blocked','blocked',3),def('in_review','leader',4)])
  await tasks.upsertTask({id:'t1',title:'t1',status:'in_progress',createdAt:at,updatedAt:at} as never)
  const sub=(id:string,status:string,extra:any={})=>({id,taskId:'t1',title:id,status,done:status==='done',createdAt:at,updatedAt:at,...extra}) as never
  await tasks.upsertSubtask(sub('p1','in_progress',{isGroup:true}))
  await tasks.upsertSubtask(sub('m1','done',{parentGroupId:'p1'}))
  await tasks.upsertSubtask(sub('m2','in_progress',{parentGroupId:'p1'}))
  const g=createGuaranteesStore(join(root,'guarantees.json'))
  const check=async()=>({ok:true as const,via:'legacy-browser' as const})
  const facts=(n:number): ActivationFacts=>({now:new Date(n).toISOString(),build:'qa',capabilities:['S0','S1','S2','S3'],migrated:['a'],unexplainedWouldRefuse:0})
  expect(await g.setState('a','shadow',{check,facts:facts(T-25*3600_000)})).toEqual({ok:true})
  expect(await g.setState('a','on',{check,facts:facts(T)})).toEqual({ok:true})
  expect(await w.svc.ensure('p1')).toHaveProperty('subtaskId','p1')
  for(const input of [shot(1280,1),shot(390,2),{kind:'probe',probe:{kind:'bundle',literal:'qa-group-evidence-literal'}}]) {
   const r=await w.svc.evidenceAdd('p1',input as never,'worker');expect(r.ok,JSON.stringify(r)).toBe(true)
  }
  const m2=(await tasks.read()).subtasks.find(s=>s.id==='m2')!
  await tasks.upsertSubtask({...m2,status:'done',done:true},{principal:{kind:'session',id:'worker',via:'token'}} as never)
  const cp=(await createGuardsStore(join(root,'guards.json')).read()).checkpoints.p1!
  console.log('ACCEPTANCE',JSON.stringify({rank:cp.rank,boardStatus:cp.boardStatus,auth:cp.auth,members:cp.members}))
  expect(cp.auth.some(a=>a.kind==='evidence')).toBe(true)
  expect(cp.members).toEqual({m1:{status:'done',at},m2:{status:'done',at}})
 } finally {rmSync(root,{recursive:true,force:true})}
},60000)


import { planSweep,emptyMemory } from './sweep-plan'
import { guardSweep, type SweepDeps } from './sweep'
const boundaryAt='2026-11-13T10:00:00.000Z'
const statuses:any=[{id:'in_progress',stage:'running'},{id:'in_review',stage:'leader'},{id:'done',stage:'published'}]
test('QA boundary recorded board equal current rank does not catch up',()=>{
 const p:any={key:'p',taskId:'t',boardStatus:'in_progress',boardRank:0,ciRank:0,record:{phase:'revisao_lider',revision:1,evidence:[],history:[]}}
 const cp:any={key:'p',rank:1,boardStatus:'in_progress',phase:'revisao_lider',auth:[{kind:'grandfathered',at:boundaryAt}],by:{kind:'flow'},at:boundaryAt}
 expect(planSweep({pieces:[p],checkpoints:{p:cp},statuses,memory:emptyMemory(),now:Date.parse(boundaryAt)}).catchUps).toEqual([])
})
test('QA boundary exactly 100 checkpointed repairs run',async()=>{
 let doc:any={intents:{},migrations:{a:{version:1,at:boundaryAt}},checkpoints:{}}
 const subs:any[]=Array.from({length:100},(_,i)=>({id:'p'+i,taskId:'t',status:'done'}))
 for(const s of subs)doc.checkpoints[s.id]={key:s.id,rank:0,boardStatus:'in_progress',phase:null,auth:[],by:{kind:'flow'},at:boundaryAt}
 const actions:string[]=[]
 const deps: SweepDeps = {
  rule: async () => 'on', envelope: async fn => fn(),
  guards: { read: async () => doc, write: async d => { doc = d } },
  tasks: {
   read: async () => ({ tasks: [], subtasks: structuredClone(subs), statuses }),
   applyBoardReverts: async b => { for (const r of b.reverts) subs.find(s => s.id === r.key).status = r.to },
  },
  store: { read: async () => ({ deliveries: {} }), update: async () => {} },
  statusStages: async () => undefined, guard: {},
  ids: { comment: () => Math.random().toString(), event: () => Math.random().toString() },
  effective: s => s, now: () => Date.parse(boundaryAt),
 }
 await guardSweep(deps, actions)
 expect(actions.filter(a=>a.startsWith('sweep-revert'))).toHaveLength(100)
 expect(subs.every(s=>s.status==='in_progress')).toBe(true)
})
