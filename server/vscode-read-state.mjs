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
  return {known,unread:new Set(ids),modifiedAt};
}

// Bootstrap already-read tasks once, then only infer reads on an actual
// unread -> read transition. Unrelated database writes cannot read a new reply.
export function createVscodeReadTracker() {
  const seen=new Set();let previous=new Set();
  return (snapshot,threads)=>{
    if(!snapshot)return;
    const counts=new Map();for(const t of threads)counts.set(t.id,(counts.get(t.id)??0)+1);
    for(const t of threads){
      if(counts.get(t.id)!==1||!snapshot.known.has(t.id))continue;
      const first=!seen.has(t.id),becameRead=previous.has(t.id)&&!snapshot.unread.has(t.id);
      seen.add(t.id);
      if((first||becameRead)&&!snapshot.unread.has(t.id)&&t.state==='completed'&&Date.parse(t.revision)<=snapshot.modifiedAt){
        if((t.nativeReadAt??0)<=snapshot.modifiedAt)Object.assign(t,{nativeUnread:false,nativeReadAt:snapshot.modifiedAt,nativeReadSource:'vscode-storage'});
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
