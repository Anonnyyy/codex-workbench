import {DatabaseSync} from 'node:sqlite';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';

export function vscodeReadSnapshot(value, modifiedAt) {
  const atoms=value?.['persisted-atom-state'];
  const ids=atoms?.['unread-thread-ids-by-host-v1']?.local;
  if(!Array.isArray(ids)||!ids.every(id=>typeof id==='string'))return null;
  const known=new Set(Object.keys(value['thread-project-assignments']??{}));
  for(const key of Object.keys(atoms))if(key.startsWith('thread-reference-capability:'))known.add(key.slice('thread-reference-capability:'.length));
  for(const id of ids)known.add(id);
  const activityAt=new Map();
  for(const [key,time] of Object.entries(atoms['thread-user-activity-times-v1']??{})){
    let address;
    try{address=JSON.parse(key);}catch{continue;}
    if(Array.isArray(address)&&address.length===2&&address[0]==='local'&&typeof address[1]==='string'&&Number.isFinite(time)){
      activityAt.set(address[1],time);
    }
  }
  return {known,unread:new Set(ids),activityAt,modifiedAt};
}

// A thread can remain open while a new reply arrives, so its unread flag may
// never transition. Per-thread activity after that reply is also a read signal.
// Database-wide modification time alone is not a read signal for later replies.
export function createVscodeReadTracker({sharedUi=false}={}) {
  const seen=new Set();let previous=new Set();
  return (snapshot,threads)=>{
    if(!snapshot)return;
    const counts=new Map();for(const t of threads)counts.set(t.id,(counts.get(t.id)??0)+1);
    for(const t of threads){
      // The Windows extension stores SSH webview state in this same database:
      // its logical host "local" is not the Workbench's physical local device.
      // Join only a known, unique thread UUID, never titles or project paths.
      if((!sharedUi&&t.deviceId!=='local')||counts.get(t.id)!==1||!snapshot.known.has(t.id))continue;
      const first=!seen.has(t.id),becameRead=previous.has(t.id)&&!snapshot.unread.has(t.id);
      seen.add(t.id);
      const replyAt=Date.parse(t.revision),activityAt=snapshot.activityAt.get(t.id);
      const readAt=(first||becameRead)?snapshot.modifiedAt:activityAt;
      if(!snapshot.unread.has(t.id)&&t.state==='completed'&&Number.isFinite(replyAt)&&Number.isFinite(readAt)&&replyAt<=readAt){
        if((t.nativeReadAt??0)<=readAt)Object.assign(t,{nativeUnread:false,nativeReadAt:readAt,nativeReadSource:'vscode-storage'});
      }
    }
    previous=snapshot.unread;
  };
}

export async function readVscodeState(base=process.env.APPDATA?join(process.env.APPDATA,'Code/User'):join(homedir(),'.config/Code/User')) {
  const path=join(base,'globalStorage/state.vscdb');let db;
  try{
    const stamps=await Promise.all([path,path+'-wal'].map(p=>stat(p).then(s=>s.mtimeMs).catch(()=>0)));
    db=new DatabaseSync(path,{readOnly:true});
    const row=db.prepare("SELECT value FROM ItemTable WHERE key = 'openai.chatgpt'").get();
    return row?vscodeReadSnapshot(JSON.parse(row.value),Math.max(...stamps)):null;
  }catch{return null;}finally{db?.close();}
}
