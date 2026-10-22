import React, {useMemo, useRef, useState} from 'react';
import {ChevronDown, ChevronRight, Folder, FolderOpen, Monitor, Server, GripVertical, CornerUpLeft, CornerDownRight} from 'lucide-react';
import {treeRows, visibleTreeRows, groupProjects, unreadSummary} from './model';
import {TaskList, UnreadLight} from './components';
import {displayCounts,validDisplayCount,useDisplayPreference} from './displayPreferences';

const storageKey='codex-workbench:project-expansion:v1';
function readExpansion(){try{return JSON.parse(localStorage.getItem(storageKey)||'{}')||{};}catch{return {};}}

export default function ProjectTree({groups,data,selected,onSelect,collapsed,onCollapse,onMove,onProjectMove,searching,activeOnly=false}) {
  const [expansion,setExpansion]=useState(readExpansion),[dragging,setDragging]=useState(null),[notice,setNotice]=useState('');
  const pointer=useRef(null);
  const [rowPreferences,setRowPreferences]=useDisplayPreference('codex-workbench:row-counts:v1',{default:3,projects:{}});
  const defaultCount=validDisplayCount(rowPreferences?.default);
  function setProjectCount(key,value){setRowPreferences(old=>({...old,projects:{...old?.projects,[key]:validDisplayCount(value)}}));}
  const allGroups=useMemo(()=>groupProjects(data.threads,data.devices,data.meta),[data]);
  const unreadSummaries=useMemo(()=>new Map(allGroups.flatMap(d=>[[d.key,unreadSummary(d.projects.flatMap(p=>p.threads),data.meta)],...d.projects.map(p=>[p.key,unreadSummary(p.threads,data.meta)])])),[allGroups,data.meta]);
  function expanded(group,isDevice=false){return Object.hasOwn(expansion,group.key)?expansion[group.key]:isDevice||searching||group.priority>0;}
  function saveExpansion(value){setExpansion(value);try{localStorage.setItem(storageKey,JSON.stringify(value));}catch{}}
  function toggle(group,isDevice=false){saveExpansion({...expansion,[group.key]:!expanded(group,isDevice)});}
  function toggleAll(open){const next={...expansion};for(const d of groups){next[d.key]=open;next[d.key+':history']=open;for(const p of d.projects){next[p.key]=open;next[p.key+':more']=open;}}saveExpansion(next);}
  function clearDrag(){pointer.current=null;setDragging(null);document.body.classList.remove('dragging');document.querySelectorAll('.project-drop-active').forEach(el=>el.classList.remove('project-drop-active'));}
  async function move(project,pinned){
    if(await onProjectMove(project.key,pinned))setNotice('已将 '+project.name+(pinned?' 移到外面，位置已保存':' 放回其他项目'));
  }
  function dropTarget(e,source){const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-project-drop]');return target?.dataset.deviceId===source?.deviceId?target:null;}
  function pointerStart(e,project,device){if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const source={...project,deviceId:device.id};pointer.current=source;setDragging(source);document.body.classList.add('dragging');}
  function pointerMove(e){if(!pointer.current)return;document.querySelectorAll('.project-drop-active').forEach(el=>el.classList.remove('project-drop-active'));dropTarget(e,pointer.current)?.classList.add('project-drop-active');}
  function pointerEnd(e){const source=pointer.current,target=dropTarget(e,source);clearDrag();if(source&&target)void move(source,target.dataset.projectDrop==='main');}
  function dropProps(device,placement){return {'data-project-drop':placement,'data-device-id':device.id,onDragOver:e=>{if(dragging?.deviceId===device.id){e.preventDefault();e.dataTransfer.dropEffect='move';e.currentTarget.classList.add('project-drop-active');}},onDragLeave:e=>e.currentTarget.classList.remove('project-drop-active'),onDrop:e=>{e.preventDefault();e.stopPropagation();if(dragging?.deviceId===device.id)void move(dragging,placement==='main');clearDrag();}};}
  function renderProject(project,device){
    const open=expanded(project),FolderIcon=open?FolderOpen:Folder,pinned=!!data.projectMeta?.[project.key]?.pinned;
    const allRows=open?treeRows(project.threads,data.meta,collapsed):[];
    const rowCount=validDisplayCount(rowPreferences?.projects?.[project.key]??defaultCount),showAll=rowCount===0;
    const shown=visibleTreeRows(allRows,rowCount),nextCount=Math.min(allRows.length,Math.max(rowCount,shown.length)+(defaultCount||10));
    const additional=visibleTreeRows(allRows,nextCount).length-shown.length;
    return <section className={'project-group '+(project.priority?'working':'')} key={project.key} data-project-path={project.path}>
      <div className="project-header" draggable onDragStart={e=>{e.dataTransfer.setData('application/x-codex-project',project.key);e.dataTransfer.effectAllowed='move';setDragging({...project,deviceId:device.id});}} onDragEnd={clearDrag}>
        <button className="project-grip" aria-label={'拖动项目 '+device.name+' '+project.path} title="拖到设备标题处，移出其他项目" onPointerDown={e=>pointerStart(e,project,device)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={clearDrag}><GripVertical size={16}/></button>
        <button className="project-heading" onClick={()=>toggle(project)} aria-expanded={open} aria-label={device.name+' 项目 '+project.path} title={project.path}>
          {open?<ChevronDown size={15}/>:<ChevronRight size={15}/>}<FolderIcon size={20}/>
          <span className="project-name"><span className="folder-title"><strong>{project.name}</strong><UnreadLight {...unreadSummaries.get(project.key)}/></span><small>{project.path}</small></span>
          <span className="project-summary">{!device.online?<span className="project-closed">设备离线</span>:Array.isArray(device.processes)&&project.processCount===0?<span className="project-closed">未打开{pinned?' · 已固定':''}</span>:project.running>0?<span className="project-running"><i className="dot"/>{project.running} 个生成中</span>:project.processCount>0?<span className="project-open">Codex 已打开</span>:<span className="project-closed">历史任务{pinned?' · 已固定':''}</span>}<small>{project.threads.length} 个任务</small></span>
        </button>
        {!project.priority&&<button className="project-placement" aria-label={(pinned?'放回其他项目 ':'移到外面 ')+project.path} title={pinned?'放回其他项目':'移到外面，单独显示'} onClick={()=>move(project,!pinned)}>{pinned?<CornerDownRight size={16}/>:<CornerUpLeft size={16}/>}</button>}
      </div>
      {open&&<div className="project-tasks">{project.threads.length?<>
        <div className="project-list-tools"><span>显示 {shown.length} / {allRows.length} 条会话</span><label>展示<select aria-label={device.name+' '+project.path+' 展示条数'} value={rowCount} onChange={e=>setProjectCount(project.key,e.target.value)}>{[...new Set([...displayCounts,rowCount])].sort((a,b)=>a===0?1:b===0?-1:a-b).map(n=><option key={n} value={n}>{n===0?'全部':n+' 条'}</option>)}</select></label></div>
        <TaskList rows={shown} grouped data={data} selected={selected} onSelect={onSelect} collapsed={collapsed} onCollapse={onCollapse} onMove={onMove}/>
      </>:<p className="project-empty">Codex 窗口已打开，等待此目录的任务记录。</p>}
        {!showAll&&additional>0&&<button className="more-tasks" onClick={()=>setProjectCount(project.key,nextCount)}>再显示 {additional} 条</button>}
        {(showAll||rowCount>defaultCount)&&defaultCount>0&&allRows.length>defaultCount&&<button className="more-tasks" onClick={()=>setProjectCount(project.key,defaultCount)}>收起为 {defaultCount} 条</button>}
      </div>}
    </section>;
  }
  return <section className="project-tree" aria-label="按设备和项目文件夹分组的任务">
    <div className="tree-toolbar"><span>设备 → 文件夹 → 任务 → 分叉</span><div className="tree-controls"><label className="default-count">每项目显示<select aria-label="每个项目默认展示条数" value={defaultCount} onChange={e=>setRowPreferences({default:validDisplayCount(e.target.value),projects:{}})}>{displayCounts.map(n=><option key={n} value={n}>{n===0?'全部':n+' 条'}</option>)}</select></label><button onClick={()=>toggleAll(true)}>全部展开</button><button onClick={()=>toggleAll(false)}>全部收起</button></div></div>
    {notice&&<p className="tree-notice" role="status">{notice}</p>}
    {!groups.length&&<div className="empty"><Folder size={30}/><h3>{activeOnly?'当前没有检测到正在工作的项目':'没有匹配的项目或任务'}</h3><p>{activeOnly?'打开 Codex 后会自动同步；历史任务可在“全部”中查看。':'试试其他筛选条件。'}</p></div>}
    {groups.map(device=>{
      const deviceOpen=expanded(device,true),DeviceIcon=device.platform==='linux'?Server:Monitor;
      const main=device.projects.filter(p=>p.priority||data.projectMeta?.[p.key]?.pinned),history=device.projects.filter(p=>!p.priority&&!data.projectMeta?.[p.key]?.pinned);
      const historyGroup={key:device.key+':history',priority:0},showHistory=expanded(historyGroup);
      const historyUnread=unreadSummary((allGroups.find(d=>d.id===device.id)?.projects??[]).filter(p=>!p.priority&&!data.projectMeta?.[p.key]?.pinned).flatMap(p=>p.threads),data.meta);
      return <section className="device-group" key={device.key} data-device-group={device.id}>
        <button className="device-heading" {...dropProps(device,'main')} onClick={()=>toggle(device,true)} aria-expanded={deviceOpen} aria-label={device.name+' 设备'}>
          {deviceOpen?<ChevronDown size={17}/>:<ChevronRight size={17}/>}<DeviceIcon size={19}/><strong>{device.name}</strong><UnreadLight {...unreadSummaries.get(device.key)}/>
          <span className="device-group-summary">{device.projects.length} 个项目 · {device.count} 个任务</span><span className="device-connection"><i className={'dot '+(!device.online?'offline':'')}/>{device.online?'在线':'离线'}</span>
        </button>
        {deviceOpen&&<div className="device-projects">
          {dragging?.deviceId===device.id&&<div className="project-drop-zone" {...dropProps(device,'main')}>松开鼠标，移到外面单独显示</div>}
          {main.map(p=>renderProject(p,device))}
          {(history.length>0||dragging?.deviceId===device.id)&&<section className="history-group">
            <button className="history-projects" {...dropProps(device,'history')} aria-expanded={showHistory} onClick={()=>toggle(historyGroup)} aria-label={device.name+' 其他项目'}>{showHistory?<ChevronDown size={15}/>:<ChevronRight size={15}/>}<Folder size={18}/><span>其他项目</span><UnreadLight {...historyUnread}/><small>{history.length} 个文件夹</small></button>
            {showHistory&&<div className="history-children">{history.map(p=>renderProject(p,device))}</div>}
          </section>}
        </div>}
      </section>;
    })}
  </section>;
}
