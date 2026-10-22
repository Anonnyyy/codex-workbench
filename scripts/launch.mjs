import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const port=Number(process.env.PORT||24319),url=`http://127.0.0.1:${port}`;
async function alive(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});return r.ok&&(await r.json()).ok===true;}catch{return false;}}
if(!await alive()){
 const dir=process.env.WORKBENCH_DATA||join(root,'.workbench');mkdirSync(dir,{recursive:true});
 const out=openSync(join(dir,'server.log'),'a'),err=openSync(join(dir,'server-error.log'),'a');
 const child=spawn(process.execPath,[join(root,'server/hub.mjs')],{cwd:root,detached:true,stdio:['ignore',out,err]});
 child.unref();closeSync(out);closeSync(err);
 for(let i=0;i<40&&!await alive();i++)await new Promise(r=>setTimeout(r,250));
 if(!await alive())throw new Error('Unable to start. Check '+join(dir,'server-error.log'));
}
console.log('Codex Workbench: '+url);
if(process.env.WORKBENCH_NO_OPEN!=='1'){
 const browser=spawn('xdg-open',[url],{detached:true,stdio:'ignore'});
 browser.on('error',()=>console.log('Open the address above in your browser.'));browser.unref();
}
