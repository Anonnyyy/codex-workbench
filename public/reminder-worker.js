self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  // Windows uses the positionable desktop host. Retire its old Edge banners.
  const desktop=/Win/i.test(self.navigator?.platform??'');
  for(const notification of await self.registration.getNotifications()){
    const ours=notification.tag?.startsWith('codex-workbench:')||notification.tag==='codex-workbench-test';
    if(ours&&(desktop||notification.requireInteraction))notification.close();
  }
  await self.clients.claim();
})()));
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
