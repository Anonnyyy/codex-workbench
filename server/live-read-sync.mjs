// Upgrade an already-running hub without dropping its password-only SSH link.
// A restarted hub has this logic built in and retires this temporary bridge.
import {readVscodeState,createVscodeReadTracker} from './vscode-read-state.mjs';
import {observeVscodeReads} from './vscode-read-events.mjs';
import {unread} from '../src/model.js';
import {pathToFileURL} from 'node:url';

export function readUpdates(snapshot){
  return snapshot.threads.filter(t=>{
    const m=snapshot.meta[t.key],forced=m?.forceUnread&&(!Object.hasOwn(m,'forceUnreadRevision')||m.forceUnreadRevision===t.revision);
    return t.online&&t.state==='completed'&&t.nativeUnread===false&&t.nativeReadAt>=Date.parse(t.revision)&&!forced&&unread({...t,nativeUnread:undefined},snapshot.meta);
  });
}

export async function runReadSync(base='http://127.0.0.1:24319'){
  const origin=new URL(base);
  if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:')throw Error('Local Workbench URL required');
  const track=createVscodeReadTracker({sharedUi:true}),events=observeVscodeReads();
  let stopped=false,busy=false;
  const stop=()=>{stopped=true;clearInterval(timer);events.close();};
  const tick=async()=>{
    if(stopped||busy)return;busy=true;
    try{
      const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      if(health.readSyncVersion>=2){stop();return;}
      const snapshot=await fetch(base+'/api/state',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      track(await readVscodeState(),snapshot.threads);events.apply(snapshot.threads);
      for(const t of readUpdates(snapshot)){
        const result=await fetch(base+'/api/meta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:t.key,revision:t.revision,read:true}),signal:AbortSignal.timeout(3000)});
        if(result.ok)console.log(JSON.stringify({read:t.key,revision:t.revision,source:t.nativeReadSource}));
      }
    }catch(error){console.error('Read synchronization: '+error.message);}finally{busy=false;}
  };
  const timer=setInterval(tick,2000);await tick();return stop;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runReadSync(process.argv[2]);
