import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

// Only consume the explicit local host mapping from the desktop app's v1
// state. Unknown formats, other identities and CLI-only threads remain unknown.
export function nativeReadSnapshot(state,modifiedAt){
  const read=state?.['electron-thread-read-state-v1'],identities=read?.unreadByIdentity;
  if(read?.version!==1||!identities||Object.keys(identities).length!==1)return null;
  const migration=read.legacyMigration,host=migration?.adoptedHostIds?.local;
  const ids=identities[migration?.identityKey]?.[host];
  if(!host?.startsWith('local:')||!Array.isArray(ids))return null;
  const known=new Set([...(state['projectless-thread-ids']??[]),...Object.keys(state['thread-project-assignments']??{}),...Object.keys(state['thread-workspace-root-hints']??{})]);
  const atoms=state['electron-persisted-atom-state']??{};
  for(const key of Object.keys(atoms)){const prefix='thread-client-id-v1:local%3A';if(key.startsWith(prefix))known.add(key.slice(prefix.length));}
  return {known,unread:new Set(ids),modifiedAt};
}
export async function readNativeState(home){
  try{const path=join(home,'.codex-global-state.json');const [info,text]=await Promise.all([stat(path),readFile(path,'utf8')]);return nativeReadSnapshot(JSON.parse(text),info.mtimeMs);}catch{return null;}
}
