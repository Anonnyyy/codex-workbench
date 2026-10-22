import {isCapacityError,capacityRetryCount} from '../src/capacityRetry.js';

export const capacityRetryDelay=0;

export function createCapacityRecovery({store,send,onChange=()=>{},now=Date.now}){
  const inFlight=new Set();
  // Preserve counters from the previous version. It retained only the latest
  // result, so older individual outcomes must not be invented during migration.
  const migrated=structuredClone(store.get());let changed=false;
  for(const record of Object.values(migrated.capacityRetries??{})){
    if(record.totalAttempts==null){
      record.totalAttempts=capacityRetryCount(record);
      record.history=record.totalAttempts&&record.attemptedAt?[{number:record.totalAttempts,at:record.attemptedAt,failedTurnId:record.failedTurnId,status:record.status,message:record.message}]:[];
      changed=true;
    }
  }
  if(changed)store.save(migrated);
  function save(key,value){
    const state=structuredClone(store.get());
    state.capacityRetries??={};state.capacityRetries[key]=value;
    store.save(state);onChange();
  }
  const enabled=t=>store.get().devices.find(d=>d.id===t.deviceId)?.autoRetryCapacity===true;
  return {
    async tick(threads){
      await Promise.all(threads.map(async t=>{
        if(inFlight.has(t.key))return;
        inFlight.add(t.key);
        try{
          if(!t.online||t.threadKind==='subagent')return;
          const device=store.get().devices.find(d=>d.id===t.deviceId);
          let record=store.get().capacityRetries?.[t.key];
          if(t.turnStatus==='completed'){
            if(record&&record.status!=='completed')save(t.key,{...record,status:'completed',attempts:0,completedAt:now(),message:'任务已正常完成'});
            return;
          }
          if(!enabled(t))return;
          if(t.turnStatus!=='failed'||!t.turnId||!isCapacityError(t.turnError))return;
          const failedAt=Date.parse(t.lastAt);
          if(!Number.isFinite(failedAt)||failedAt<(device.capacityRetrySince??now()))return;
          if(Date.parse(t.lastUserAt)>failedAt)return;
          if(record?.failedTurnId!==t.turnId){
            const attempts=record?.status==='completed'?0:record?.attempts??0;
            record={...record,totalAttempts:capacityRetryCount(record),history:record?.history??[],failedTurnId:t.turnId,failedAt,attempts,status:'waiting',nextAt:now()+capacityRetryDelay,message:'容量已满，等待自动重试'};
            save(t.key,record);
          }
          // A rejected connection has not submitted a turn. Recheck it on the
          // next snapshot, including old records with a two-minute backoff.
          else if(['waiting','unavailable'].includes(record.status)&&record.nextAt>now()){
            record={...record,nextAt:now()};save(t.key,record);
          }
          // Reserve before dispatch. A lost acknowledgement or a restart can
          // never cause a second empty turn for the same failure.
          if(!['waiting','unavailable'].includes(record.status)||record.nextAt>now()||!enabled(t))return;
          const entry={number:capacityRetryCount(record)+1,at:now(),failedTurnId:t.turnId,status:'sending',message:'正在重试'};
          record={...record,attempts:record.attempts+1,totalAttempts:entry.number,history:[...(record.history??[]),entry].slice(-20),status:'sending',attemptedAt:entry.at,nextAt:null,message:entry.message};
          save(t.key,record);
          let result;
          try{result=await send(t,{threadId:t.id,turnId:t.turnId});}
          catch{result={status:'unknown',message:'重试回执未确认，等待任务状态更新'};}
          const status=['sent','unavailable','stale','unknown'].includes(result?.status)?result.status:'unknown';
          const message=result?.message??'等待任务状态更新';
          save(t.key,{...record,status,nextAt:status==='unavailable'?now():null,message,history:record.history.map(h=>h.number===entry.number?{...h,status,message}:h)});
        }finally{inFlight.delete(t.key);}
      }));
    }
  };
}
