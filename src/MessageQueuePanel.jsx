import React,{useState,useRef} from 'react';
import './message-queue.css';
import {QUEUE_LIMIT,QUEUE_TEXT_LIMIT,normalCompletion} from './messageQueue';
import {isCapacityError} from './capacityRetry';

const statusLabels={queued:'待发送',sending:'正在发送',sent:'已发送，等待运行',running:'执行中',uncertain:'发送结果待确认'};
const dateLabel=value=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

export function MessageQueueBadge({task,data}){
  const queue=data.messageQueues?.[task.key];
  return queue?.items.length>0?<span className="message-queue-badge">{queue.paused?'队列暂停':'消息队列'} {queue.items.length}/{QUEUE_LIMIT}</span>:null;
}

export default function MessageQueuePanel({task,data,action,readOnly=false}){
  const [text,setText]=useState(''),[editing,setEditing]=useState(null),[pending,setPending]=useState(false);
  const requestId=useRef(null);
  const device=data.devices.find(d=>d.id===task.deviceId),queue=data.messageQueues?.[task.key]??{items:[],history:[],paused:false};
  if(device?.type!=='ssh'||task.threadKind==='subagent')return null;
  if(data.messageQueues==null)return <section className="message-queue-panel"><h3>待发送消息</h3><p>后台更新后即可使用消息队列。</p></section>;
  const full=queue.items.length>=QUEUE_LIMIT,head=queue.items[0];
  const waiting=queue.paused?'队列已暂停':!task.online?'设备离线，连接后继续等待':head?.status==='uncertain'?'发送结果待确认，后续消息暂不发送':isCapacityError(task.turnError)?'正在等待当前任务重试成功':normalCompletion(task)?'当前任务已完成，加入后将自动发送':'等待当前任务正常完成';
  async function change(request){
    if(readOnly)return false;
    setPending(true);
    try{return await action('message-queue',{key:task.key,...request});}
    finally{setPending(false);}
  }
  async function submit(event){
    event.preventDefault();if(!text.trim()||pending)return;
    requestId.current??=crypto.randomUUID();
    if(await change({operation:editing?'edit':'add',id:editing??requestId.current,text})){
      setText('');setEditing(null);requestId.current=null;
    }
  }
  function edit(item){setEditing(item.id);setText(item.text);requestId.current=null;}
  return <section className="message-queue-panel" aria-label="待发送消息" data-queue-draft={text.length>0?'true':undefined}>
    <div className="message-queue-heading"><h3>待发送消息</h3><span>{queue.items.length} / {QUEUE_LIMIT}</span>{queue.items.length>0&&<button disabled={pending||readOnly} onClick={()=>change({operation:'pause',paused:!queue.paused})}>{queue.paused?'继续队列':'暂停队列'}</button>}</div>
    <p className="message-queue-help">每条消息都等上一条正常完成后再发到这个对话。容量错误时先重试当前任务。</p>
    <p className="message-queue-state">{waiting}</p>
    <ol className="message-queue-items">{queue.items.map((item,index)=><li key={item.id}>
      <div className="message-queue-item-heading"><strong>{index+1}. {statusLabels[item.status]}</strong><time>{dateLabel(item.createdAt)}</time></div>
      <p className="message-queue-text">{item.text}</p>
      {item.message&&item.status!=='queued'&&<small>{item.message}</small>}
      {item.status==='queued'&&!readOnly&&<div className="message-queue-controls">
        <button aria-label={`编辑第 ${index+1} 条消息`} disabled={pending} onClick={()=>edit(item)}>编辑</button>
        <button aria-label={`上移第 ${index+1} 条消息`} disabled={pending||index===0||queue.items[index-1]?.status!=='queued'} onClick={()=>change({operation:'move',id:item.id,direction:-1})}>上移</button>
        <button aria-label={`下移第 ${index+1} 条消息`} disabled={pending||index===queue.items.length-1} onClick={()=>change({operation:'move',id:item.id,direction:1})}>下移</button>
        <button aria-label={`删除第 ${index+1} 条消息`} disabled={pending} onClick={async()=>{if(await change({operation:'remove',id:item.id})&&editing===item.id){setEditing(null);setText('');}}}>删除</button>
      </div>}
    </li>)}</ol>
    {!readOnly&&<form onSubmit={submit}>
      <label className="message-queue-label" htmlFor={'queue-message-'+task.id}>{editing?'编辑待发送消息':'添加下一条消息'}</label>
      <textarea id={'queue-message-'+task.id} rows={4} maxLength={QUEUE_TEXT_LIMIT} value={text} disabled={pending||full&&!editing} placeholder="写下接下来要做的事…" onChange={e=>{setText(e.target.value);requestId.current=null;}}/>
      <div className="message-queue-compose-actions"><small>{full&&!editing?'最多缓存 3 条消息':`${text.length} / ${QUEUE_TEXT_LIMIT}`}</small>{editing&&<button type="button" disabled={pending} onClick={()=>{setEditing(null);setText('');}}>取消编辑</button>}<button className="primary" disabled={pending||!text.trim()||full&&!editing}>{pending?'保存中…':editing?'保存修改':'加入队列'}</button></div>
    </form>}
    {readOnly&&<p className="message-queue-help">消息已保存在工作台。重新连接设备后可编辑或继续添加。</p>}
    {queue.history.length>0&&<details className="message-queue-history"><summary>已完成的队列消息（{queue.history.length}）</summary>{queue.history.slice().reverse().map(item=><article key={item.id}><time>{dateLabel(item.completedAt)} · 已完成</time><p className="message-queue-text">{item.text}</p></article>)}</details>}
    <small className="message-queue-footnote">加入后自动保存，重启工作台后保留；连接恢复后继续。发送期间不能修改该条消息。</small>
  </section>;
}
