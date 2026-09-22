import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createCollector} from './collector.mjs';

const dir=resolve(process.env.WORKBENCH_DATA||'.workbench');mkdirSync(dir,{recursive:true,mode:0o700});
const tokenPath=join(dir,'agent-token');let token=process.env.WORKBENCH_TOKEN;
if(!token){try{token=readFileSync(tokenPath,'utf8').trim();}catch{token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token,{mode:0o600});}}
const collect=createCollector();let snapshot=null,pending=null;
async function refresh(){if(pending)return pending;pending=collect().then(s=>snapshot=s).finally(()=>pending=null);return pending;}
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
  const received=Buffer.from(req.headers.authorization??''), expected=Buffer.from('Bearer '+token);
  if(received.length!==expected.length||!timingSafeEqual(received,expected)||req.headers.origin){res.writeHead(401);return res.end('{"error":"Unauthorized"}');}
  if(req.method!=='GET'||req.url!=='/snapshot'){res.writeHead(404);return res.end('{}');}
  try{if(!snapshot||Date.now()-snapshot.observedAt>2000)await refresh();res.end(JSON.stringify(snapshot));}
  catch{res.writeHead(503);res.end('{"error":"Cannot read Codex local records"}');}
});
server.listen(Number(process.env.AGENT_PORT||4311),process.env.AGENT_HOST||'0.0.0.0',()=>console.log(`Collector ready on port ${process.env.AGENT_PORT||4311}. Pairing token file: ${tokenPath}`));
