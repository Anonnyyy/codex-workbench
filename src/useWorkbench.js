import {useEffect,useRef,useState} from 'react';
import {conversationTasks} from './model';
import {createSystemNotifier,notificationWorker,notificationPreferenceKey,systemNotificationsEnabled,setSystemNotificationsEnabled,closeSystemNotifications} from './systemNotifications';
import {usesDesktopNotifications,desktopNotificationsRequest} from './desktopNotifications';
const initial={threads:[],devices:[],folders:[],meta:{}};
const desktopReminders=usesDesktopNotifications();
export function useWorkbench(){
  const [data,setData]=useState(initial),[connected,setConnected]=useState(false),[toast,setToast]=useState('');
  const [notificationsEnabled,setNotificationsEnabled]=useState(()=>!desktopReminders&&systemNotificationsEnabled());
  const changingNotifications=useRef(false);
  const [reminderToOpen,setReminderToOpen]=useState(null);
  // Discard the retired in-page reminder queue.
  useEffect(()=>{
    try{localStorage.removeItem('codex-workbench-reminders-v1');}catch{}
  },[]);
  useEffect(()=>{
    if(desktopReminders){
      let disposed=false,busy=false;
      // Old open tabs observe this preference too, preventing duplicate Edge banners.
      setSystemNotificationsEnabled(false);
      void notificationWorker().then(closeSystemNotifications).catch(()=>{});
      const sync=async()=>{
        if(busy)return;busy=true;
        try{const status=await desktopNotificationsRequest();if(!disposed)setNotificationsEnabled(status.enabled);}
        catch{}finally{busy=false;}
      };
      void sync();const timer=setInterval(sync,5000);window.addEventListener('focus',sync);
      return()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',sync);};
    }
    const sync=()=>{
      const enabled=systemNotificationsEnabled();setNotificationsEnabled(enabled);
      if(!enabled)void navigator.serviceWorker?.getRegistration().then(closeSystemNotifications).catch(()=>{});
    };
    const storage=event=>{if(event.key===notificationPreferenceKey||event.key===null)sync();};
    const open=event=>{if(event.data?.type==='open-reminder'&&typeof event.data.key==='string')setReminderToOpen(event.data.key);};
    sync();window.addEventListener('focus',sync);window.addEventListener('storage',storage);navigator.serviceWorker?.addEventListener('message',open);
    return()=>{window.removeEventListener('focus',sync);window.removeEventListener('storage',storage);navigator.serviceWorker?.removeEventListener('message',open);};
  },[]);
  useEffect(()=>{let lastMessage=0,reportedError=false;const notify=createSystemNotifier({registration:notificationWorker,enabled:()=>!desktopReminders&&systemNotificationsEnabled()});const events=new EventSource('/api/events');events.onerror=()=>setConnected(false);events.onmessage=e=>{
    const snapshot=JSON.parse(e.data),next={...snapshot,threads:conversationTasks(snapshot.threads)};
    lastMessage=Date.now();setConnected(true);
    setData(next);
    void notify(next).then(()=>{reportedError=false;}).catch(error=>{if(!reportedError)setToast('系统提醒暂不可用：'+error.message);reportedError=true;});
  };const watchdog=setInterval(()=>{if(Date.now()-lastMessage>15000)setConnected(false);},3000);return()=>{clearInterval(watchdog);events.close();};},[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),5500);return()=>clearTimeout(timer);},[toast]);
  async function action(path,body){try{const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw new Error(result.error);if(result.message)setToast(result.message);return true;}catch(e){setToast(e.message);return false;}}
  useEffect(()=>{
    const loaded=[...document.scripts].find(s=>s.type==='module'&&s.src.includes('/assets/'))?.src;
    if(!loaded)return;
    const controller=new AbortController();let checking=false;
    const timer=setInterval(async()=>{
      if(checking||document.querySelector('dialog[open]')||document.querySelector('[data-queue-draft="true"]')||document.visibilityState!=='visible')return;
      checking=true;
      try{const res=await fetch('/',{cache:'no-store',signal:controller.signal});if(!res.ok)return;const html=await res.text(),src=html.match(/<script[^>]*\bsrc="([^"]+)"/)?.[1];if(src&&new URL(src,location.href).href!==loaded&&!document.querySelector('dialog[open]')&&!document.querySelector('[data-queue-draft="true"]'))location.reload();}catch{}finally{checking=false;}
    },15000);
    return()=>{clearInterval(timer);controller.abort();};
  },[]);
  async function notifications(){
    if(changingNotifications.current)return;
    changingNotifications.current=true;
    try{
      if(desktopReminders){
        const status=await desktopNotificationsRequest();
        if(!status.ready)throw new Error('桌面提醒窗口正在启动，请稍后再试');
        const next=await desktopNotificationsRequest('/settings',{enabled:!status.enabled});
        setNotificationsEnabled(next.enabled);
        if(next.enabled)await desktopNotificationsRequest('/test',{});
        setToast(next.enabled?'已开启桌面提醒，显示在屏幕右上角':'已关闭桌面提醒，并收起已有通知');return;
      }
      if(systemNotificationsEnabled()){
        setSystemNotificationsEnabled(false);setNotificationsEnabled(false);
        await closeSystemNotifications(await navigator.serviceWorker?.getRegistration());
        setToast('已关闭系统提醒，并收起已有通知');return;
      }
      if(!globalThis.Notification)throw new Error('请使用 Microsoft Edge 打开工作台');
      const permission=Notification.permission==='default'?await Notification.requestPermission():Notification.permission;
      if(permission!=='granted'){setNotificationsEnabled(false);setToast('请在浏览器的网站权限中允许通知');return;}
      const worker=await notificationWorker();
      setSystemNotificationsEnabled(true);setNotificationsEnabled(true);
      await worker.showNotification('Codex 工作台 · 测试提醒',{body:'任务完成或等待你回答时，将使用这种系统通知提醒。',icon:'/workbench.png',tag:'codex-workbench-test',requireInteraction:false});
      if(!systemNotificationsEnabled()){await closeSystemNotifications(worker);return;}
      setToast('已开启系统提醒');
    }catch(error){setToast('提醒暂不可用：'+error.message);}finally{changingNotifications.current=false;}
  }
  const visibleData=connected?data:{...data,devices:data.devices.map(d=>({...d,online:false})),threads:data.threads.map(t=>({...t,online:false}))};
  return {data:visibleData,connected,toast,action,notifications,notificationsEnabled,reminderToOpen,clearReminderToOpen:()=>setReminderToOpen(null)};
}
