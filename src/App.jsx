import React, {useEffect, useMemo, useState} from 'react';
import {useWorkbench} from './useWorkbench';
import {unread, groupProjects, projectIsActive} from './model';
import {Sidebar, Inspector, Modal, DeviceDialog, Search, Monitor, Trash2} from './components';
import ProjectTree from './ProjectTree';
import RecentTimeline from './RecentTimeline';
import {CapacityRetryUpgradeNotice} from './CapacityRetrySettings';
import MessageQueues,{queuedMessageCount} from './MessageQueues';

export default function App() {
  const {data, connected, toast, action, notifications, notificationsEnabled, reminderToOpen, clearReminderToOpen} = useWorkbench();
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('active');
  const [selected, setSelected] = useState(null);
  const [requestedTask,setRequestedTask]=useState(()=>new URLSearchParams(location.search).get('openTask'));
  const [timelineOpen,setTimelineOpen]=useState(false);
  const [modal, setModal] = useState(()=>new URLSearchParams(location.search).get('panel')==='queue'?'queues':null);
  const [collapsed, setCollapsed] = useState(new Set());
  const folder = data.folders.find(f => f.id === view);
  const title = folder?.name ?? ({all:'全部任务', unread:'未读', running:'生成中', attention:'需要处理', unfiled:'未分类'}[view])
    ?? data.devices.find(d => 'device:' + d.id === view)?.name ?? '全部任务';
  const groups = useMemo(() => {
    const list = data.threads.filter(t => {
      const match = v => v === 'all' || v === 'active' || v === 'unread' && unread(t, data.meta)
        || v === 'running' && t.online && t.state === 'running'
        || v === 'attention' && t.online && ['attention', 'interrupted'].includes(t.state);
      const scope = folder ? data.meta[t.key]?.folderId === view : view === 'unfiled' ? !data.meta[t.key]?.folderId
        : view.startsWith('device:') ? 'device:' + t.deviceId === view : match(view);
      return scope && match(tab) && `${t.title} ${t.cwd} ${t.deviceName}`.toLowerCase().includes(query.toLowerCase());
    });
    const devices=view.startsWith('device:')?data.devices.filter(d=>'device:'+d.id===view):data.devices;
    const grouped=groupProjects(list,devices,data.meta,{includeOpenProjects:(view==='all'||view.startsWith('device:'))&&['all','active'].includes(tab)});
    return grouped.map(d=>{
      const projects=d.projects.filter(p=>(tab!=='active'||projectIsActive(p,d))&&(p.threads.length||!query.trim()||p.path.toLowerCase().includes(query.toLowerCase())));
      return {...d,projects,count:projects.reduce((n,p)=>n+p.threads.length,0)};
    }).filter(d=>d.projects.length);
  }, [data, view, tab, query, folder]);
  const task = data.threads.find(t => t.key === selected);
  function toggleBranch(key) {
    setCollapsed(old => {const next = new Set(old); next.has(key) ? next.delete(key) : next.add(key); return next;});
  }
  function openTask(key){
    setSelected(key);const current=data.threads.find(t=>t.key===key);
    if(current&&unread(current,data.meta))void action('meta',{key,read:true,revision:current.revision});
  }
  useEffect(()=>{
    if(reminderToOpen&&data.threads.some(t=>t.key===reminderToOpen)){
      openTask(reminderToOpen);clearReminderToOpen();
    }
  },[reminderToOpen,data]);
  useEffect(()=>{
    if(requestedTask&&data.threads.some(t=>t.key===requestedTask)){
      openTask(requestedTask);setRequestedTask(null);
      const url=new URL(location.href);url.searchParams.delete('openTask');history.replaceState(null,'',url);
    }
  },[requestedTask,data]);

  return <div className={'app ' + (task ? 'detail-open' : '')+(timelineOpen&&!task?' timeline-open':'')}>
    <Sidebar data={data} view={view} setView={v => {setView(v); setTab(v==='all'||v.startsWith('device:')?'active':'all');setSelected(null);}} action={action}
      onFolder={() => setModal('folder')} onDevices={() => setModal('device')} notifications={notifications} notificationsEnabled={notificationsEnabled}/>
    <main>
      {!connected&&<div className="sync-warning" role="alert">同步已中断，正在重连。当前显示最后快照，设备状态暂不可确认。<button onClick={()=>location.reload()}>重新加载</button></div>}
      {connected&&<CapacityRetryUpgradeNotice data={data} onDevices={()=>setModal('device')}/>}
      <header>
        <div><h1>{title}</h1><p>按设备与项目文件夹整理，正在工作的项目优先</p></div>
        <div className="header-actions">
          <label className="search"><Search size={17}/><input aria-label="搜索任务" placeholder="搜索项目或任务…" value={query} onChange={e => setQuery(e.target.value)}/></label>
          <button className="primary" onClick={() => setModal('device')}><Monitor size={17}/>添加设备</button>
          <button className="recent-toggle" onClick={()=>{setSelected(null);setTimelineOpen(true);}}>最近会话</button>
          <button className="queue-entry" onClick={()=>setModal('queues')}>消息队列{queuedMessageCount(data)>0?`（${queuedMessageCount(data)}）`:''}</button>
        </div>
      </header>
      <div className="tabs">
        {[['active','正在工作'],['all','全部（含历史）'],['unread','未读'],['running','生成中']].map(([id,name]) => <button key={id} className={tab === id ? 'chosen' : ''} onClick={() => {setTab(id);setSelected(null);}}>{name}</button>)}
        <button className="bulk-read" onClick={()=>action('read-completed',{})}>已完成标为已读</button>
        {folder && <button className="delete-folder" aria-label="删除当前文件夹" onClick={() => setModal('delete-folder')}><Trash2 size={16}/></button>}
      </div>
      {tab==='active'&&<p className="live-view-hint">打开的项目自动出现，关闭后自动移出；历史任务在“全部”中保留。</p>}
      <ProjectTree groups={groups} data={data} selected={selected} onSelect={openTask} searching={!!query.trim()}
        activeOnly={tab==='active'}
        collapsed={collapsed} onCollapse={toggleBranch} onMove={(key,folderId) => action('meta',{key,folderId})}
        onProjectMove={(key,pinned)=>action('project',{key,pinned})}/>
    </main>
    {task?<Inspector task={task} data={data} action={action} onClose={() => setSelected(null)}/>:<RecentTimeline data={data} onSelect={openTask} onClose={()=>setTimelineOpen(false)}/>}
    <footer>
      <span><i className={'dot ' + (!connected ? 'offline' : '')}/>{connected ? '工作台已连接' : '正在重连工作台…'}<b/>{data.devices.filter(d => d.online).length} 台设备在线</span>
      <span>每台最近 300 条 · 每 2–3 秒同步{data.updatedAt && ' · ' + new Date(data.updatedAt).toLocaleTimeString('zh-CN')}</span>
    </footer>
    {toast && <div className="toast" role="status">{toast}</div>}
    {modal === 'folder' && <Modal title="新建文件夹" onClose={() => setModal(null)}>
      <form onSubmit={async e => {e.preventDefault(); const name = new FormData(e.currentTarget).get('name'); if (await action('folders',{name})) setModal(null);}}>
        <label>文件夹名称<input autoFocus name="name" required maxLength={60} placeholder="例如：应用开发"/></label>
        <button className="primary">创建文件夹</button>
      </form>
    </Modal>}
    {modal === 'device' && <DeviceDialog data={data} action={action} onClose={() => setModal(null)}/>}
    {modal === 'queues' && <Modal title="消息队列" onClose={()=>setModal(null)}><MessageQueues data={data} action={action} onSelect={key=>{setModal(null);openTask(key);}} onDevices={()=>setModal('device')}/></Modal>}
    {modal === 'delete-folder' && <Modal title="删除文件夹" onClose={() => setModal(null)}>
      <p>删除“{folder?.name}”后，其中任务会回到未分类。</p>
      <button className="primary" onClick={async () => {if (await action('folder/delete',{id:folder.id})) {setModal(null); setView('all');}}}>删除文件夹</button>
    </Modal>}
  </div>;
}
