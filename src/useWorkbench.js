import {useEffect,useRef,useState} from 'react';
import {notificationReason,displayTitle} from './model';
const initial={threads:[],devices:[],folders:[],meta:{}};
export function useWorkbench(){
  const [data,setData]=useState(initial),[connected,setConnected]=useState(false),[toast,setToast]=useState('');
  const previous=useRef(null),notify=useRef(false),meta=useRef({});
  useEffect(()=>{let lastMessage=0;const events=new EventSource('/api/events');events.onerror=()=>setConnected(false);events.onmessage=e=>{
    const next=JSON.parse(e.data);
    lastMessage=Date.now();setConnected(true);meta.current=next.meta??{};
    if(previous.current){for(const t of next.threads){
      const reason=notificationReason(previous.current.get(t.key),t);if(!reason)continue;
      const body=`${displayTitle(t,meta.current)} · ${reason.label}${reason.detail?`：${reason.detail}`:''}`;
      setToast(body);
      if(notify.current&&globalThis.Notification?.permission==='granted')new Notification('Codex 工作台',{body});
    }}
    previous.current=new Map(next.threads.map(t=>[t.key,t]));setData(next);
  };const watchdog=setInterval(()=>{if(Date.now()-lastMessage>15000)setConnected(false);},3000);return()=>{clearInterval(watchdog);events.close();};},[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),5500);return()=>clearTimeout(timer);},[toast]);
  async function action(path,body){try{const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw new Error(result.error);if(result.message)setToast(result.message);return true;}catch(e){setToast(e.message);return false;}}
  useEffect(()=>{
    const loaded=[...document.scripts].find(s=>s.type==='module'&&s.src.includes('/assets/'))?.src;
    if(!loaded)return;
    const controller=new AbortController();let checking=false;
    const timer=setInterval(async()=>{
      if(checking||document.querySelector('dialog[open]')||document.visibilityState!=='visible')return;
      checking=true;
      try{const res=await fetch('/',{cache:'no-store',signal:controller.signal});if(!res.ok)return;const html=await res.text(),src=html.match(/<script[^>]*\bsrc="([^"]+)"/)?.[1];if(src&&new URL(src,location.href).href!==loaded&&!document.querySelector('dialog[open]'))location.reload();}catch{}finally{checking=false;}
    },15000);
    return()=>{clearInterval(timer);controller.abort();};
  },[]);
  async function notifications(){if(!globalThis.Notification){setToast('当前浏览器不支持桌面通知，仍会显示应用内提醒');return;}const p=await Notification.requestPermission();notify.current=p==='granted';setToast(notify.current?'已开启桌面提醒，请保持工作台运行':'未开启桌面通知，应用内提醒仍可用');}
  const visibleData=connected?data:{...data,devices:data.devices.map(d=>({...d,online:false})),threads:data.threads.map(t=>({...t,online:false}))};
  return {data:visibleData,connected,toast,action,notifications};
}
