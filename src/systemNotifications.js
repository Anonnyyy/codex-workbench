import {labels,unread,displayTitle} from './model.js';
import {taskNotification} from './capacityRetry.js';

const prefix='codex-workbench:';

// The service worker owns notifications, so a refreshed page can still close
// the exact reply that was read. There is no second, in-page reminder surface.
export function createSystemNotifier({registration,enabled=()=>true}){
  let previous=null,queue=Promise.resolve();
  return function update(snapshot){
    const tasks=new Map(snapshot.threads.map(t=>[t.key,t]));
    const supported=snapshot.capacityRetries!=null;
    const notices=new Map(snapshot.threads.map(t=>[t.key,taskNotification(t,snapshot.devices.find(d=>d.id===t.deviceId),supported,snapshot.messageQueues?.[t.key])]));
    const arrivals=[];
    if(previous?.supported===supported){
      for(const task of snapshot.threads){
        const old=previous.tasks.get(task.key),notice=notices.get(task.key);
        if(old&&task.online&&notice&&unread(task,snapshot.meta)&&(notice!==previous.notices.get(task.key)||task.turnId!==old.turnId||task.revision!==old.revision))arrivals.push({task,notice});
      }
    }
    previous={tasks,notices,supported};
    if(!enabled())return Promise.resolve();
    queue=queue.catch(()=>{}).then(async()=>{
      if(!enabled())return;
      const worker=await registration();
      const active=await worker.getNotifications();
      const surviving=new Map();
      for(const notification of active){
        if(!notification.tag?.startsWith(prefix))continue;
        const task=tasks.get(notification.data?.key);
        if(task&&(task.revision!==notification.data?.revision||!unread(task,snapshot.meta)))notification.close();
        else surviving.set(notification.tag,notification);
      }
      for(const {task,notice} of arrivals){
        const tag=prefix+task.key,shown=surviving.get(tag);
        if(shown?.data?.revision===task.revision&&shown.data.notice===notice)continue;
        await worker.showNotification('Codex 工作台',{
          body:`${displayTitle(task,snapshot.meta)} · ${labels[notice]}`,
          icon:'/workbench.png',tag,requireInteraction:true,
          data:{key:task.key,revision:task.revision,notice},
        });
      }
    });
    return queue;
  };
}

let workerReady;
export function notificationWorker(){
  if(!navigator.serviceWorker)throw new Error('当前浏览器不支持系统提醒，请使用 Microsoft Edge 打开工作台');
  workerReady??=navigator.serviceWorker.register('/reminder-worker.js').then(()=>navigator.serviceWorker.ready).catch(error=>{workerReady=null;throw error;});
  return workerReady;
}
