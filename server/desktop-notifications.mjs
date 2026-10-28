import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync,mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createSystemNotifier} from '../src/systemNotifications.js';
import {conversationTasks} from '../src/model.js';

// The same reply reconciliation is shared with browser notifications. Only the
// presentation changes; dismissing a banner never marks its task as read.
export function createDesktopRegistry({publish=()=>{},open=()=>{}}={}){
  const active=new Map();let scheduled=false;
  const items=()=>[...active.values()].reverse().map(n=>({id:n.id,title:n.title,body:n.body,notice:n.data?.notice}));
  const changed=()=>{if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;publish(items());});}};
  const worker={
    getNotifications:async()=>[...active.values()],
    showNotification:async(title,options)=>{
      const notification={id:randomUUID(),title,body:options.body,tag:options.tag,data:options.data,
        close(){if(active.get(this.tag)===this){active.delete(this.tag);changed();}}};
      active.set(notification.tag,notification);changed();
    },
  };
  return {worker,items,clear(){active.clear();changed();},
    handle(message){
      if(!['open','dismiss'].includes(message.action))return;
      const item=[...active.values()].find(n=>n.id===message.id);
      if(!item)return;
      if(message.action==='open')open(item.data?.key);
      item.close();
    },
  };
}

export function createDesktopController({enabled=false,publish,open}={}){
  const registry=createDesktopRegistry({publish,open});
  const notify=createSystemNotifier({registration:async()=>registry.worker,enabled:()=>enabled});
  return {...registry,get enabled(){return enabled;},
    setEnabled(value){enabled=value;if(!value)registry.clear();},
    update(snapshot){return notify({...snapshot,threads:conversationTasks(snapshot.threads)});},
    async test(){if(enabled)await registry.worker.showNotification('Codex 工作台 · 测试提醒',{
      tag:'codex-workbench-test',body:'通知固定在屏幕右上角，托盘区域保持可点击。\n点击可打开工作台，也可单独关闭。',data:{},
    });},
  };
}

export function createDesktopApi({controller,hubPort,status=()=>({}),persist=()=>{}}){
  const port=hubPort+1;
  const origins=new Set([`http://127.0.0.1:${hubPort}`,`http://localhost:${hubPort}`,'http://127.0.0.1:5173','http://localhost:5173']);
  return createServer(async(req,res)=>{
    const origin=req.headers.origin;
    const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(origin&&origins.has(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{})});res.end(JSON.stringify(data));};
    if(!new Set([`127.0.0.1:${port}`,`localhost:${port}`]).has(req.headers.host)||origin&&!origins.has(origin))return reply(403,{error:'Forbidden'});
    if(req.method==='OPTIONS'){
      res.writeHead(204,{'Access-Control-Allow-Origin':origin??origins.values().next().value,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'});return res.end();
    }
    try{
      if(req.method==='GET'&&req.url==='/health')return reply(200,{service:'codex-desktop-notifications',version:1,hubPort,enabled:controller.enabled,...status()});
      if(req.method!=='POST'||!['/settings','/test'].includes(req.url))return reply(404,{error:'Not found'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'Content-Type required'});
      let text='';for await(const chunk of req){text+=chunk;if(text.length>1024)return reply(413,{error:'Too large'});}
      const body=JSON.parse(text);
      if(req.url==='/settings'){
        if(typeof body.enabled!=='boolean')return reply(400,{error:'Enabled must be boolean'});
        persist(body.enabled);controller.setEnabled(body.enabled);
      }else await controller.test();
      return reply(200,{ok:true,enabled:controller.enabled,...status()});
    }catch(error){return reply(400,{error:error.message});}
  });
}

async function main(){
  if(process.platform!=='win32')throw new Error('Desktop reminder windows require Windows.');
  const root=fileURLToPath(new URL('..',import.meta.url)),hubPort=Number(process.env.PORT||24319);
  if(!Number.isInteger(hubPort)||hubPort<1||hubPort>=65535)throw new Error('Invalid workbench port.');
  const base=`http://127.0.0.1:${hubPort}`,settingsFile=join(process.env.WORKBENCH_DATA||join(root,'.workbench'),'desktop-notifications.json');
  let enabled=false;try{enabled=JSON.parse(readFileSync(settingsFile,'utf8')).enabled===true;}catch{}
  const persist=value=>{mkdirSync(dirname(settingsFile),{recursive:true});const temp=settingsFile+'.tmp';writeFileSync(temp,JSON.stringify({enabled:value})+'\n');renameSync(temp,settingsFile);};
  if(process.argv.includes('--enable')){enabled=true;persist(true);}
  let host,compiler,ready=false,connected=false,closing=false,error=null,layout=null,failures=0,pollTimer,restartTimer;
  const publish=items=>{if(ready&&host?.stdin.writable)host.stdin.write(JSON.stringify({items})+'\n');};
  const open=key=>{
    const url=base+'/' +(key?'?openTask='+encodeURIComponent(key):'');
    const edge=join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');
    const child=spawn(edge,['--app='+url],{windowsHide:true,detached:true,stdio:'ignore'});
    child.on('error',e=>{error='无法打开工作台：'+e.message;});child.unref();
  };
  const controller=createDesktopController({enabled,publish,open});
  const api=createDesktopApi({controller,hubPort,persist,status:()=>({ready,connected,error,position:'top-right',layout})});
  // Claim the port before starting a window host, so duplicate launchers are harmless.
  await new Promise((resolve,reject)=>{api.once('error',reject);api.listen(hubPort+1,'127.0.0.1',resolve);});
  async function startHost(){
    if(closing)return;
    const powershell=join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const source=readFileSync(join(root,'server/desktop-notification-window.cs'));
    const hash=createHash('sha256').update(source).update(readFileSync(join(root,'server/desktop-notification-window.ps1'))).digest('hex').slice(0,16);
    const executable=join(dirname(settingsFile),'native','workbench-reminders-'+hash+'.exe');
    try{
      if(!existsSync(executable)){
        mkdirSync(dirname(executable),{recursive:true});
        await new Promise((resolve,reject)=>{
          compiler=spawn(powershell,['-NoProfile','-NonInteractive','-File',join(root,'server/desktop-notification-window.ps1'),'-OutputPath',executable],{windowsHide:true,stdio:['ignore','ignore','pipe']});
          let details='';compiler.stderr.on('data',chunk=>{details+=chunk;});
          compiler.on('error',reject);compiler.on('exit',code=>code===0?resolve():reject(new Error(details||'Unable to compile reminder window')));
        });
      }
    }catch(e){error=e.message;console.error(error);if(!closing)restartTimer=setTimeout(startHost,10000);return;}
    if(closing)return;
    host=spawn(executable,['--art',join(root,'public/assets/tairitsu-notification.png')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    host.stdin.on('error',()=>{});
    host.stderr.on('data',chunk=>{error=String(chunk).trim();console.error(error);});
    createInterface({input:host.stdout}).on('line',line=>{
      try{const message=JSON.parse(line);
        if(message.action==='ready'){ready=true;error=null;publish(controller.items());}
        else if(message.action==='layout')layout=message;
        else controller.handle(message);
      }catch{}
    });
    host.on('error',e=>{error=e.message;});
    host.on('exit',()=>{ready=false;if(!closing){error??='桌面提醒窗口正在重启';restartTimer=setTimeout(startHost,5000);}});
  }
  void startHost();
  async function poll(){
    if(closing)return;
    try{
      const response=await fetch(base+'/api/state',{signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error('Workbench unavailable');
      const snapshot=await response.json();if(!Array.isArray(snapshot.threads)||!Array.isArray(snapshot.devices))throw new Error('Invalid snapshot');
      connected=true;failures=0;await controller.update(snapshot);
    }catch{connected=false;if(++failures>=30){stop();return;}}
    pollTimer=setTimeout(poll,2000);
  }
  function stop(){
    if(closing)return;closing=true;clearTimeout(pollTimer);clearTimeout(restartTimer);
    api.close();compiler?.kill();host?.stdin.end();setTimeout(()=>{host?.kill();process.exit(0);},1500).unref();
  }
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  console.log('Desktop reminders: '+base+' (top-right)');void poll();
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
