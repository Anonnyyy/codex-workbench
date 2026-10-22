import React from 'react';
import MessageQueuePanel from './MessageQueuePanel';

export function queuedMessageCount(data){
  return Object.values(data.messageQueues??{}).reduce((count,queue)=>count+(queue.items?.length??0),0);
}

export default function MessageQueues({data,action,onSelect,onDevices}){
  const queues=Object.entries(data.messageQueues??{}).filter(([,queue])=>queue.items?.length);
  if(data.messageQueues==null)return <p className="help">工作台后台尚未加载消息队列功能。</p>;
  return <div className="queue-directory">
    <p className="help">每个对话最多缓存 3 条消息。上一条正常完成后，再自动发送下一条。</p>
    {!queues.length&&<div className="queue-directory-empty"><h3>还没有待发送消息</h3><p>点开 5090 上的任务，在右侧「待发送消息」中输入下一条任务，再点「加入队列」。</p><button onClick={onDevices}>管理设备</button></div>}
    {queues.map(([key,queue])=>{
      const live=data.threads.find(t=>t.key===key),deviceId=key.slice(0,key.lastIndexOf(':'));
      const device=data.devices.find(d=>d.id===deviceId);
      const task=live??{key,id:key.slice(key.lastIndexOf(':')+1),deviceId,online:false,threadKind:'conversation',state:'unknown'};
      return <section className="queue-directory-task" key={key}>
        <div className="queue-directory-title"><div><small>{device?.name??'远程设备'} · {task.online?'在线':'离线，消息已保存'}</small><h3>{task.title??`${device?.name??'远程设备'} 的待发送任务`}</h3>{task.cwd&&<p>{task.cwd}</p>}</div>{live&&<button onClick={()=>onSelect(key)}>打开任务</button>}</div>
        {!task.online&&<button className="queue-reconnect" onClick={onDevices}>重新连接 {device?.name??'设备'}</button>}
        <MessageQueuePanel task={task} data={data} action={action} readOnly={!live}/>
      </section>;
    })}
  </div>;
}
