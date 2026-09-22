import {readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';
export function createStore(dir) {
  mkdirSync(dir,{recursive:true,mode:0o700}); const path=join(dir,'state.json');
  let state;
  try{state=JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={version:1,folders:[],meta:{},devices:[]};}
  return {get:()=>state,save(next){writeFileSync(path+'.tmp',JSON.stringify(next,null,2),{mode:0o600});renameSync(path+'.tmp',path);state=next;}};
}
