import {randomUUID} from 'node:crypto';
import {QUEUE_LIMIT,QUEUE_TEXT_LIMIT,normalCompletion} from '../src/messageQueue.js';

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyQueue=()=>({paused:false,items:[],history:[]});

export function changeMessageQueue(store,task,request,now=Date.now()){
  if(!task||task.threadKind==='subagent')throw Error('请选择一个主对话');
  if(!store.get().devices.some(d=>d.id===task.deviceId&&d.type==='ssh'))throw Error('此设备暂不支持自动发送');
  const state=structuredClone(store.get());state.messageQueues??={};
  const queue=state.messageQueues[task.key]??=emptyQueue();
  const index=queue.items.findIndex(item=>item.id===request.id),item=queue.items[index];
  const validateText=text=>{if(typeof text!=='string'||!text.trim()||text.length>QUEUE_TEXT_LIMIT)throw Error('消息需为 1–8000 个字符');return text;};
  if(request.operation==='add'){
    const text=validateText(request.text),id=request.id??randomUUID();
    if(!uuidPattern.test(id))throw Error('消息标识无效');
    const existing=[...queue.items,...queue.history].find(i=>i.id===id);
    if(existing){if(existing.text!==text)throw Error('这条消息已存在，请使用编辑');return existing.id;}
    if(queue.items.length>=QUEUE_LIMIT)throw Error('最多缓存 3 条消息');
    queue.items.push({id,text,status:'queued',createdAt:now});
  }else if(request.operation==='pause'){
    if(typeof request.paused!=='boolean')throw Error('队列状态无效');
    queue.paused=request.paused;
  }else{
    if(!item)throw Error('找不到待发送消息');
    if(item.status!=='queued')throw Error('消息已进入发送流程，不能修改或删除');
    if(request.operation==='edit')item.text=validateText(request.text);
    else if(request.operation==='remove')queue.items.splice(index,1);
    else if(request.operation==='move'){
      if(![-1,1].includes(request.direction))throw Error('移动方向无效');
      const target=index+request.direction;
      if(target<0||target>=queue.items.length||queue.items[target].status!=='queued')throw Error('无法移动到该位置');
      [queue.items[index],queue.items[target]]=[queue.items[target],item];
    }else throw Error('未知队列操作');
  }
  queue.updatedAt=now;store.save(state);
  return queue.items.at(-1)?.id;
}

export function createMessageQueue({store,send,inspect,onChange=()=>{},now=Date.now}){
  let busy=false;
  const get=key=>store.get().messageQueues?.[key];
  function update(key,change){
    const state=structuredClone(store.get()),queue=state.messageQueues?.[key];
    if(!queue)return;change(queue);queue.updatedAt=now();store.save(state);onChange();
  }
  function patch(key,id,values){update(key,q=>{const item=q.items.find(i=>i.id===id);if(item)Object.assign(item,values);});}
  return {
    async tick(threads){
      if(busy)return;busy=true;
      try{
        for(const task of threads){
          if(!task.online||task.threadKind==='subagent')continue;
          let queue=get(task.key),item=queue?.items[0];
          if(!item)continue;
          // A process exit or a lost acknowledgement must never submit again.
          if(['sending','uncertain'].includes(item.status)){
            if(!inspect||(item.nextCheckAt??0)>now())continue;
            patch(task.key,item.id,{status:'uncertain',nextCheckAt:now()+30000,message:'正在核对发送结果，后续消息暂不发送'});
            let result;try{result=await inspect(task,{threadId:task.id,turnId:item.afterTurnId,text:item.text});}catch{continue;}
            if(result?.status!=='observed'||!result.turnId)continue;
            patch(task.key,item.id,{status:'running',runTurnId:result.turnId,message:'消息已确认送达，等待正常完成'});
            item=get(task.key)?.items[0];
          }
          if(item&&['sent','running'].includes(item.status)){
            if(task.turnId===item.afterTurnId||!task.turnId)continue;
            if(item.status==='sent'){
              patch(task.key,item.id,{status:'running',runTurnId:item.runTurnId??task.turnId,message:'消息已发送，等待正常完成'});
              item=get(task.key)?.items[0];
            }
            if(!normalCompletion(task))continue;
            update(task.key,q=>{
              if(q.items[0]?.id!==item.id)return;
              q.history=[...q.history,{...q.items.shift(),status:'completed',completedAt:now(),completedTurnId:task.turnId}].slice(-20);
            });
          }
          queue=get(task.key);item=queue?.items[0];
          if(!item||item.status!=='queued'||queue.paused||!normalCompletion(task)||(item.nextAt??0)>now())continue;
          const id=item.id,afterTurnId=task.turnId;
          patch(task.key,id,{status:'sending',afterTurnId,sentAt:now(),message:'正在发送'});
          let result;
          try{result=await send(task,{threadId:task.id,turnId:afterTurnId,text:item.text});}
          catch{result={status:'unknown'};}
          if(result?.status==='sent')patch(task.key,id,{status:'sent',runTurnId:result.turnId??null,message:'已发送，等待正常完成'});
          else if(['unavailable','stale'].includes(result?.status))patch(task.key,id,{status:'queued',nextAt:now()+15000,message:result.message??'等待发送条件恢复'});
          else patch(task.key,id,{status:'uncertain',nextCheckAt:now()+5000,message:'发送结果待确认，后续消息暂不发送'});
        }
      }finally{busy=false;}
    }
  };
}
