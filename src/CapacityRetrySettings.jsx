import React,{useState} from 'react';
import {isCapacityError,capacityRetryCount} from './capacityRetry';

const outcomeLabels={sending:'正在尝试',sent:'已触发重试',unavailable:'暂未触发',stale:'已取消',unknown:'回执待确认',waiting:'等待重试',completed:'任务已完成'};
const retryTime=at=>new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});

export function CapacityRetryBadge({task,data}){
  const count=capacityRetryCount(data.capacityRetries?.[task.key]);
  return count>0?<span className="capacity-retry-count" title="at capacity 后累计重试尝试次数；具体结果见任务详情">重试 {count} 次</span>:null;
}

export function CapacityRetryUpgradeNotice({data,onDevices}){
  if(data.capacityRetries!=null||!data.devices.some(d=>d.type==='ssh'))return null;
  return <section className="capacity-upgrade-notice" role="status">
    <div><strong>自动重试尚未生效：工作台后台需要重启</strong><p>只关窗口再打开不会重启后台。重启后，请重新连接远程设备。为避免误报，已暂停远程任务通知。</p></div>
    <button onClick={onDevices}>管理设备</button>
  </section>;
}

export function CapacityRetryStatus({task,data}){
  const enabled=data.devices.find(d=>d.id===task.deviceId)?.autoRetryCapacity;
  const record=data.capacityRetries?.[task.key];
  const count=capacityRetryCount(record),history=record?.history??[];
  if(!record&&(!enabled||!isCapacityError(task.turnError)))return null;
  const message=task.turnStatus==='completed'?'任务已正常完成':!enabled?'自动重试已关闭':!task.online?'等待设备重新连接':task.turnStatus==='inProgress'?'任务已恢复运行':record?.message??'容量已满，等待自动重试';
  return <section className="capacity-retry-note" aria-label="容量错误重试记录">
    <div className="capacity-retry-heading"><strong>at capacity 自动重试</strong><span>累计尝试 <b>{count}</b> 次</span></div>
    <p>{message}{enabled&&task.turnStatus!=='completed'?'。正常完成后提醒。':''}</p>
    {record?.attemptedAt&&<p className="capacity-retry-last">最近尝试：{retryTime(record.attemptedAt)}</p>}
    {history.length>0&&<details><summary>查看最近 {history.length} 条记录</summary><ol>{history.slice().reverse().map(h=><li key={h.number}><div><strong>第 {h.number} 次 · {outcomeLabels[h.status]??'等待状态更新'}</strong><time dateTime={new Date(h.at).toISOString()}>{retryTime(h.at)}</time></div><p>{h.message}</p></li>)}</ol></details>}
    <small>次数按尝试累计，任务完成后保留。连接不可用等未触发的尝试也会记录。</small>
  </section>;
}

export default function CapacityRetrySettings({data,action}){
  const [pending,setPending]=useState(null);
  const devices=data.devices.filter(d=>d.type==='ssh');
  if(!devices.length)return null;
  if(data.capacityRetries==null)return <section className="capacity-retry-settings"><h3>容量错误自动重试</h3><p>功能已安装。请重启工作台后台并重新连接设备后启用。</p></section>;
  async function toggle(device,enabled){
    setPending(device.id);
    try{await action('device/capacity-retry',{id:device.id,enabled});}
    finally{setPending(null);}
  }
  return <section className="capacity-retry-settings" aria-label="容量错误自动重试">
    <h3>容量错误自动重试</h3>
    <p>检测到 at capacity 后立即重试，仅正常完成后提醒。连接暂不可用时持续检查，各任务独立重试。</p>
    {devices.map(d=><label key={d.id} className="capacity-retry-device">
      <input type="checkbox" aria-label={`${d.name} 容量错误自动重试`} checked={!!d.autoRetryCapacity} disabled={pending!==null} onChange={e=>toggle(d,e.target.checked)}/>
      <span><strong>{d.name}</strong><small>{!d.autoRetryCapacity?'已关闭':d.online?'已开启 · 后台静默重试':'已开启 · 等待设备重新连接'}</small></span>
    </label>)}
  </section>;
}
