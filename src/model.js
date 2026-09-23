export const labels={running:'生成中',completed:'已完成',attention:'需要处理',interrupted:'已中断',error:'出错',unknown:'待确认'};
const capacityError=/\b(?:model\s+at\s+capacity|at\s+capacity|rate[\s_-]*limit(?:ed)?|quota\s+(?:exceeded|exhausted)|(?:service|server)\s+unavailable|overloaded)\b/i;
const ideContextMarker='# Context from my IDE setup:';
const reviewHistoryPrefix='the following is the codex agent history whose request action you are assessing';

export function isReviewHistoryThread(threadOrTitle){
  const raw=typeof threadOrTitle==='string'?threadOrTitle:threadOrTitle?.title;
  return String(raw??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase().startsWith(reviewHistoryPrefix);
}

export function automaticTitle(rawTitle){
  const raw=String(rawTitle??'').replace(/\r\n/g,'\n').trim();
  if(!raw)return '未命名任务';
  const request=raw.match(/##\s*My request\s*:\s*/i);
  let candidate=request?raw.slice(request.index+request[0].length):raw;
  if(!request&&candidate.startsWith(ideContextMarker))candidate=candidate.slice(ideContextMarker.length);
  candidate=candidate.replace(/^#+\s*/,'').replace(/\s+/g,' ').trim();
  const sentence=candidate.match(/^(.+?)(?:[。！？!?；;，,]|\s+在(?=\/?[~A-Za-z0-9]))/)?.[1]??candidate;
  return sentence.length>80?sentence.slice(0,79).trimEnd()+'…':sentence||'未命名任务';
}

export function displayTitle(thread,meta={}){
  const custom=String(meta?.[thread?.key]?.title??'').replace(/\s+/g,' ').trim();
  return custom||automaticTitle(thread?.title);
}

function errorSignature(thread){
  if(thread?.error)return String(thread.error);
  for(const message of thread?.messages??[])if(message?.phase==='error'||capacityError.test(String(message?.text??'')))return String(message.text);
  return '';
}
export function notificationReason(previous,current){
  if(!previous||!current||!current.online)return null;
  const error=errorSignature(current),oldError=errorSignature(previous);
  if(error&&error!==oldError)return {kind:'error',label:'出错',detail:error.slice(0,180)};
  if(current.state==='completed'&&previous.state!=='completed')return {kind:'completed',label:'已完成'};
  if(current.state==='unknown'&&previous.state==='running')return {kind:'stuck',label:'长时间无响应'};
  return null;
}
export function invocationTime(thread){return Date.parse(thread.lastUserAt)||Math.max(Number(thread.updatedAt)||0,Date.parse(thread.lastAt)||0);}
export function recentConversations(threads){return [...threads].sort((a,b)=>invocationTime(b)-invocationTime(a)||String(a.key).localeCompare(String(b.key)));}
export function projectIsActive(project,device){
  if(!device.online)return false;
  // On devices with process telemetry, a stale JSONL "running" event and a
  // manual pin must never keep a closed window in the live view.
  return Array.isArray(device.processes)?project.processCount>0:project.running>0;
}
export function unread(t,meta){
 const m=meta[t.key];
 // A manual unread marker belongs to the reply the user marked, not every
 // future reply in this conversation. Legacy markers remain explicit overrides.
 if(m?.forceUnread&&(!Object.hasOwn(m,'forceUnreadRevision')||m.forceUnreadRevision===t.revision))return true;
 if(!t.revision||m?.readRevision===t.revision||m?.nativeReadRevision===t.revision)return false;
 if(t.state==='completed'&&t.nativeUnread===false&&t.nativeReadAt>=Date.parse(t.revision))return false;
 return true;
}
export function markCompletedRead(threads,meta){
 let count=0;for(const t of threads){if(t.state!=='completed'||!t.online)continue;if(unread(t,meta))count++;meta[t.key]={...meta[t.key],readRevision:t.revision,forceUnread:false};}return count;
}
export function markReadBefore(threads, meta, before) {
  let count=0;
  for (const t of threads) {
    const latest=Math.max(Number(t.updatedAt)||0,Date.parse(t.lastAt)||0,Date.parse(t.revision)||0);
    if (!latest || latest>=before) continue;
    meta[t.key]={...meta[t.key],readRevision:t.revision,forceUnread:false};
    count++;
  }
  return count;
}
export function parentOf(t,meta){return Object.hasOwn(meta[t.key]??{},'parentKey')?meta[t.key].parentKey:t.parentKey;}
export function treeRows(threads,meta,collapsed=new Set()){
  const keys=new Set(threads.map(t=>t.key)), children=new Map(),roots=[];
  for(const t of threads){const p=parentOf(t,meta);if(p&&keys.has(p)&&p!==t.key){if(!children.has(p))children.set(p,[]);children.get(p).push(t);}else roots.push(t);}
  const rows=[],seen=new Set();
  function add(t,depth){if(seen.has(t.key))return;seen.add(t.key);rows.push({...t,depth,hasChildren:children.has(t.key)});if(!collapsed.has(t.key))for(const c of children.get(t.key)??[])add(c,depth+1);else {function hide(key){if(seen.has(key))return;seen.add(key);for(const c of children.get(key)??[])hide(c.key);}for(const c of children.get(t.key)??[])hide(c.key);}}
  for(const t of roots)add(t,0);for(const t of threads)if(!seen.has(t.key))add(t,0);return rows;
}

export function projectLocation(cwd) {
  let path = String(cwd || '').replace(/\\/g, '/').replace(/^\/+\?\/+/, '');
  const windows = /^[a-z]:\//i.test(path) || path.startsWith('//');
  const unc = path.startsWith('//');
  path = path.replace(/\/+/g, '/').replace(/\/$/, '');
  if (unc) path = '/' + path;
  if (!path) return {path: '', identity: '', name: '未提供目录'};
  return {path, identity: windows ? path.toLowerCase() : path, name: path.split('/').filter(Boolean).at(-1) || path};
}

export function groupProjects(threads, devices = [], meta = {}, {includeOpenProjects=true} = {}) {
  const deviceMap = new Map();
  for (const thread of threads) {
    const info = devices.find(d => d.id === thread.deviceId) || {};
    if (!deviceMap.has(thread.deviceId)) deviceMap.set(thread.deviceId, {
      ...info, id: thread.deviceId, name: thread.deviceName || info.name,
      key: 'device:' + thread.deviceId, projects: new Map(),
    });
    const device = deviceMap.get(thread.deviceId), location = projectLocation(thread.cwd);
    if (!device.projects.has(location.identity)) device.projects.set(location.identity, {
      ...location, key: 'project:' + thread.deviceId + ':' + location.identity,
      threads: [], running: 0, unread: 0, updatedAt: 0, processCount: 0,
    });
    const project = device.projects.get(location.identity);
    project.threads.push(thread);
    if (thread.online && thread.state === 'running') project.running++;
    if (unread(thread, meta)) project.unread++;
    project.updatedAt = Math.max(project.updatedAt, Date.parse(thread.lastAt) || thread.updatedAt || 0);
  }
  // A newly opened editor can exist before it has any saved Codex thread.
  if(includeOpenProjects)for(const info of devices){
    if(!info.online)continue;
    for(const process of info.processes??[]){
      if(process.cwdSource!=='vscode-workspace'||!process.cwd)continue;
      if(!deviceMap.has(info.id))deviceMap.set(info.id,{...info,key:'device:'+info.id,projects:new Map()});
      const device=deviceMap.get(info.id),location=projectLocation(process.cwd);
      if(!device.projects.has(location.identity))device.projects.set(location.identity,{
        ...location,key:'project:'+info.id+':'+location.identity,threads:[],running:0,unread:0,updatedAt:0,processCount:0,
      });
    }
  }
  // Do not shuffle two active folders on every token update; only activity-tier changes promote them.
  const rank = (a,b) => b.priority-a.priority || (a.priority ? a.name.localeCompare(b.name) : b.updatedAt-a.updatedAt) || a.name.localeCompare(b.name);
  return [...deviceMap.values()].map(device => {
    const projects = [...device.projects.values()];
    if (device.online) for (const process of device.processes || []) {
      if (!process.cwd) continue;
      const cwd = projectLocation(process.cwd).identity;
      // A process in a child project must not promote its parent directory too.
      const match = projects.filter(p => p.identity && (cwd === p.identity || cwd.startsWith(p.identity + '/')))
        .sort((a,b) => b.identity.length-a.identity.length)[0];
      if (match) match.processCount++;
    }
    for (const project of projects) {
      project.priority = project.running ? 2 : project.processCount ? 1 : 0;
      project.threads.sort((a,b) => Number(b.online && b.state === 'running')-Number(a.online && a.state === 'running')
        || (Date.parse(b.lastAt)||b.updatedAt)-(Date.parse(a.lastAt)||a.updatedAt));
    }
    return {...device, projects: projects.sort(rank), priority: Math.max(0,...projects.map(p=>p.priority)),
      running: projects.reduce((n,p)=>n+p.running,0), count: projects.reduce((n,p)=>n+p.threads.length,0),
      updatedAt: Math.max(0,...projects.map(p=>p.updatedAt))};
  }).sort(rank);
}
