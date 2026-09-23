import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createCollector} from './collector.mjs';
import {createStore} from './store.mjs';
import {connectSsh} from './ssh.mjs';
import {markReadBefore,markCompletedRead,groupProjects,isReviewHistoryThread} from '../src/model.js';
import {createEventFeed} from './event-feed.mjs';
import {resolveWorkspaces} from './vscode-workspaces.mjs';
import {readVscodeState,createVscodeReadTracker} from './vscode-read-state.mjs';
const trackVscodeReads=createVscodeReadTracker();

const root=resolve(fileURLToPath(new URL('..',import.meta.url))), port=Number(process.env.PORT||4310);
const store=createStore(resolve(process.env.WORKBENCH_DATA||join(root,'.workbench'))), collect=createCollector();
const cache=new Map(),sshConnections=new Map(),sshErrors=new Map();let current={threads:[],devices:[],updatedAt:null},polling=false;
const feed=createEventFeed(publicState);
function startSsh(d,password){
  sshConnections.get(d.id)?.close();sshErrors.set(d.id,'正在连接 SSH');
  const conn=connectSsh(d,password,snapshot=>{cache.set(d.id,snapshot);sshErrors.delete(d.id);void poll();},error=>{sshErrors.set(d.id,error);void poll();},fingerprint=>{const s=structuredClone(store.get());const saved=s.devices.find(x=>x.id===d.id);if(saved){saved.fingerprint=fingerprint;store.save(s);}});
  sshConnections.set(d.id,conn);
}
function publicState(){const s=store.get();return {...current,folders:s.folders,meta:s.meta,projectMeta:s.projectMeta??{}};}
function broadcast(){feed.broadcast();}
async function poll(){
  if(polling)return;polling=true;
  try{
    const sources=[{id:'local',name:'本机'},...store.get().devices];
    const results=await Promise.all(sources.map(async d=>{
      try{
        let snapshot;
        if(d.id==='local')snapshot=await collect();
        else if(d.type==='ssh'){snapshot=cache.get(d.id);if(sshErrors.has(d.id)||!snapshot||Date.now()-snapshot.observedAt>15000)throw new Error(sshErrors.get(d.id)||'请提供密码连接 SSH');}
        else {const r=await fetch(d.url+'/snapshot',{headers:{Authorization:'Bearer '+d.token},signal:AbortSignal.timeout(3500),redirect:'error'});if(!r.ok)throw new Error(r.status===401?'配对密钥不正确':'采集端暂不可用');snapshot=await r.json();if(!Array.isArray(snapshot.threads)||snapshot.threads.length>1000)throw new Error('设备数据格式错误');}
        if(d.type==='ssh')snapshot={...snapshot,processes:await resolveWorkspaces(d,snapshot.processes)};
        cache.set(d.id,snapshot);return {d,snapshot,online:true};
      }catch(e){return {d,snapshot:cache.get(d.id),online:false,error:d.id==='local'?'无法读取本机 Codex 记录':e.message};}
    }));
    current={updatedAt:Date.now(),threads:results.flatMap(({d,snapshot,online})=>(snapshot?.threads??[]).filter(t=>!isReviewHistoryThread(t)).map(t=>({...t,key:d.id+':'+t.id,deviceId:d.id,deviceName:d.name,online,parentKey:t.parentId?d.id+':'+t.parentId:null}))),devices:results.map(({d,snapshot,online,error})=>({id:d.id,name:d.name,type:d.type,host:d.host,username:d.username,online,error,platform:snapshot?.platform,processes:snapshot?.processes,observedAt:snapshot?.observedAt,url:d.url,fingerprint:d.fingerprint}))};
    trackVscodeReads(await readVscodeState(),current.threads);
    const saved=structuredClone(store.get());let readsChanged=false;
    for(const t of current.threads){
      if(t.online&&t.state==='completed'&&t.revision&&t.nativeUnread===false&&t.nativeReadAt>=Date.parse(t.revision)&&saved.meta[t.key]?.nativeReadRevision!==t.revision){
        saved.meta[t.key]={...saved.meta[t.key],nativeReadRevision:t.revision};readsChanged=true;
      }
    }
    if(readsChanged)store.save(saved);
    for(const {d,snapshot} of results){const device=current.devices.find(x=>x.id===d.id);if(device)device.readSyncConnected=snapshot?.readSyncConnected;}
    broadcast();
  }finally{polling=false;}
}
function json(res,code,value){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>65536)throw new Error('请求过大');}return JSON.parse(text);}
function validEndpoint(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('请输入设备地址，例如 http://192.168.1.20:4311');return u.origin;}
const server=createServer(async(req,res)=>{
  const host=req.headers.host??'';
  if(!new Set([`127.0.0.1:${port}`,`localhost:${port}`]).has(host)){res.writeHead(403);return res.end();}
  if(req.headers.origin&&!new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`,'http://127.0.0.1:5173','http://localhost:5173']).has(req.headers.origin)){res.writeHead(403);return res.end();}
  try{
    if(req.method==='GET'&&req.url==='/api/state')return json(res,200,publicState());
    if(req.method==='GET'&&req.url==='/api/health')return json(res,200,{ok:true,uptime:process.uptime(),heapUsed:process.memoryUsage().heapUsed,...feed.stats()});
    if(req.method==='GET'&&req.url==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});feed.add(res);return;}
    if(req.method==='POST'&&req.url?.startsWith('/api/')){
      if(req.headers['content-type']!=='application/json')return json(res,415,{error:'Content-Type required'});
      const b=await body(req),s=structuredClone(store.get());
      if(req.url==='/api/folders'){
        const name=String(b.name??'').trim();if(!name||name.length>60)throw new Error('文件夹名称应为 1–60 个字符');s.folders.push({id:randomUUID(),name});
      }else if(req.url==='/api/folder/delete'){
        s.folders=s.folders.filter(f=>f.id!==b.id);for(const m of Object.values(s.meta))if(m.folderId===b.id)m.folderId=null;
      }else if(req.url==='/api/read-completed'){
        const count=markCompletedRead(current.threads,s.meta);store.save(s);broadcast();return json(res,200,{ok:true,count,message:'已将 '+count+' 个已完成会话标为已读'});
      }else if(req.url==='/api/read-before'){
        const before=Date.parse(b.before);
        if(!Number.isFinite(before)||before>Date.now())throw new Error('已读截止时间无效');
        const count=markReadBefore(current.threads,s.meta,before);
        store.save(s);broadcast();return json(res,200,{ok:true,count});
      }else if(req.url==='/api/project'){
        if(typeof b.pinned!=='boolean'||!groupProjects(current.threads,current.devices,s.meta).some(d=>d.projects.some(p=>p.key===b.key)))throw new Error('找不到项目或位置无效');
        s.projectMeta??={};s.projectMeta[b.key]={...s.projectMeta[b.key],pinned:b.pinned};
      }else if(req.url==='/api/meta'){
        if(!current.threads.some(t=>t.key===b.key))throw new Error('找不到任务');
        const patch={};
        if('folderId'in b){if(b.folderId&&!s.folders.some(f=>f.id===b.folderId))throw new Error('找不到文件夹');patch.folderId=b.folderId||null;}
        if('parentKey'in b){
          if(b.parentKey&&!current.threads.some(t=>t.key===b.parentKey))throw new Error('找不到主任务');
          let p=b.parentKey;const seen=new Set([b.key]);while(p){if(seen.has(p))throw new Error('主任务关联不能形成循环');seen.add(p);p=Object.hasOwn(s.meta[p]??{},'parentKey')?s.meta[p].parentKey:current.threads.find(t=>t.key===p)?.parentKey;}
          patch.parentKey=b.parentKey||null;
        }
        if('read'in b){const t=current.threads.find(t=>t.key===b.key);if('revision'in b&&b.revision!==t.revision)return json(res,409,{error:'收到新回复，请查看最新内容后再修改已读状态'});patch.readRevision=b.read?t.revision:null;patch.forceUnread=!b.read;patch.forceUnreadRevision=b.read?null:t.revision;}
        if('title'in b){
          if(b.title!==null&&typeof b.title!=='string')throw new Error('任务标题格式无效');
          const title=String(b.title??'').replace(/\s+/g,' ').trim();
          if(title.length>100)throw new Error('任务标题应不超过 100 个字符');
          patch.title=title||null;
        }
        s.meta[b.key]={...s.meta[b.key],...patch};
      }else if(req.url==='/api/devices'){
        const name=String(b.name??'').trim(),token=String(b.token??'');if(!name||name.length>60||token.length<24)throw new Error('请填写设备名称与完整配对密钥');
        const url=validEndpoint(b.url);if(s.devices.some(d=>d.url===url))throw new Error('设备地址已添加');
        s.devices.push({id:randomUUID(),name,url,token});
      }else if(req.url==='/api/ssh'){
        if(!/^[a-zA-Z0-9._-]+$/.test(b.host??'')||!b.username||!b.password||!b.name)throw new Error('请填写设备名称、地址、用户名和密码');
        const sshPort=Number(b.port||22);if(!Number.isInteger(sshPort)||sshPort<1||sshPort>65535)throw new Error('SSH 端口无效');
        if(s.devices.some(d=>d.type==='ssh'&&d.host===b.host&&d.username===b.username&&d.port===sshPort))throw new Error('SSH 设备已添加，请使用重新连接');
        const d={id:randomUUID(),type:'ssh',name:String(b.name).slice(0,60),host:b.host,username:b.username,port:sshPort};s.devices.push(d);store.save(s);startSsh(d,b.password);return json(res,200,{ok:true,id:d.id});
      }else if(req.url==='/api/ssh/reconnect'){
        const d=s.devices.find(d=>d.id===b.id&&d.type==='ssh');if(!d||!b.password)throw new Error('请选择设备并填写密码');startSsh(d,b.password);return json(res,200,{ok:true});
      }else if(req.url==='/api/device/delete'){sshConnections.get(b.id)?.close();sshConnections.delete(b.id);sshErrors.delete(b.id);s.devices=s.devices.filter(d=>d.id!==b.id);cache.delete(b.id);}
      else return json(res,404,{error:'Unknown action'});
      store.save(s);broadcast();if(req.url.includes('device'))void poll();return json(res,200,{ok:true});
    }
    if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
    const url=new URL(req.url,'http://localhost'), path=resolve(root,'dist','.'+decodeURIComponent(url.pathname));
    const dist=resolve(root,'dist');if(path!==dist&&!path.startsWith(dist+ '\\')&&!path.startsWith(dist+'/'))return json(res,403,{});
    const file=url.pathname==='/'?join(dist,'index.html'):path;
    try{const data=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':extname(file)==='.html'?'no-store':'no-cache'});res.end(data);}catch{return json(res,404,{error:'请先执行 npm run build'});}
  }catch(e){json(res,400,{error:e.message});}
});
server.listen(port,'127.0.0.1',()=>{console.log(`Codex 工作台 http://127.0.0.1:${port}`);void poll();});
setInterval(()=>void poll(),2000).unref();
setInterval(()=>feed.heartbeat(),15000).unref();
