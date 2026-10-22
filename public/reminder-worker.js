self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',event=>{
  const key=event.notification.data?.key;
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const client=windows.find(window=>new URL(window.url).origin===self.location.origin);
    if(client){
      if(key)client.postMessage({type:'open-reminder',key});
      await client.focus();
    }else{
      await self.clients.openWindow(key?'/?openTask='+encodeURIComponent(key):'/');
    }
  })());
});
