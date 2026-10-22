import React,{useMemo,useState} from 'react';
import {Clock3,ChevronDown,X} from 'lucide-react';
import {recentConversations,invocationTime,projectLocation,unreadTone,displayTitle} from './model';
import {Status,UnreadLight,InspectorResizeHandle} from './components';
import {CapacityRetryBadge} from './CapacityRetrySettings';
import {MessageQueueBadge} from './MessageQueuePanel';
import {useDisplayPreference,validDisplayCount,displayCounts} from './displayPreferences';

function dateKey(time){if(!time)return '时间未知';return new Date(time).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});}
function dateLabel(key){const now=new Date(),yesterday=new Date(now);yesterday.setDate(now.getDate()-1);return key===dateKey(now.getTime())?'今天':key===dateKey(yesterday.getTime())?'昨天':key;}

export default function RecentTimeline({data,onSelect,onClose,inspectorWidth,onResize}){
  const [preference,setPreference]=useDisplayPreference('codex-workbench:timeline-count:v1',20);
  const count=validDisplayCount(preference,20),[extra,setExtra]=useState(0);
  const sorted=useMemo(()=>recentConversations(data.threads),[data.threads]);
  const visible=count===0?sorted:sorted.slice(0,count+extra),days=[];
  for(const thread of visible){const at=invocationTime(thread),key=dateKey(at);let day=days.at(-1);if(day?.key!==key){day={key,threads:[]};days.push(day);}day.threads.push({thread,at});}
  return <aside className="inspector recent-inspector" aria-label="最近会话时间线">
    <InspectorResizeHandle width={inspectorWidth} onResize={onResize}/>
    <div className="recent-heading"><Clock3 size={23}/><h2>最近会话</h2><button className="icon-button recent-close" aria-label="关闭最近会话" onClick={onClose}><X size={18}/></button></div>
    <p className="recent-caption">所有设备 · 按最近调用时间排列</p>
    <div className="recent-controls"><span>{sorted.length} 个会话</span><label>显示<select aria-label="时间线展示条数" value={count} onChange={e=>{setPreference(validDisplayCount(e.target.value,20));setExtra(0);}}>{displayCounts.map(n=><option key={n} value={n}>{n===0?'全部':n+' 条'}</option>)}</select></label></div>
    <div className="recent-days">{days.map(day=><section className="recent-day" key={day.key} aria-label={dateLabel(day.key)+'的会话'}><h3>{dateLabel(day.key)}</h3><ol>{day.threads.map(({thread,at})=><li key={thread.key} data-recent-key={thread.key}>
      {unreadTone(thread,data.meta)&&<span className={'recent-marker '+unreadTone(thread,data.meta)}/>}
      <button className="recent-entry" aria-label={'查看最近会话 '+thread.deviceName+' '+displayTitle(thread,data.meta)} onClick={()=>onSelect(thread.key)}>
        <span className="recent-entry-time"><time dateTime={at?new Date(at).toISOString():undefined}>{at?new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'—'}</time><span className="recent-location" title={thread.deviceName+' · '+thread.cwd}>{thread.deviceName} · {projectLocation(thread.cwd).name}</span></span>
        <span className="recent-entry-title"><strong>{displayTitle(thread,data.meta)}</strong><UnreadLight tone={unreadTone(thread,data.meta)}/></span>
        <span className="recent-entry-status"><Status state={thread.state} online={thread.online}/><CapacityRetryBadge task={thread} data={data}/><MessageQueueBadge task={thread} data={data}/></span>
      </button>
    </li>)}</ol></section>)}</div>
    {!sorted.length&&<p className="recent-empty">同步后的会话会按时间显示在这里。</p>}
    {visible.length<sorted.length&&<button className="recent-more" onClick={()=>setExtra(n=>n+(count||20))}><ChevronDown size={16}/>显示更早的会话（{sorted.length-visible.length}）</button>}
    <p className="recent-footnote">每个会话显示一次；缺少调用时间时按最近更新时间排列。每台同步最近 300 条。</p>
  </aside>;
}
