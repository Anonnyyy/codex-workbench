export function usesDesktopNotifications(environment=globalThis){
  return /Win/i.test(environment.navigator?.platform??'')&&['127.0.0.1','localhost'].includes(environment.location?.hostname);
}

export function desktopNotificationUrl(location=globalThis.location){
  const hubPort=location.port==='5173'?24319:Number(location.port||80);
  return `http://127.0.0.1:${hubPort+1}`;
}

export async function desktopNotificationsRequest(path='/health',body,environment=globalThis){
  try{
    const response=await environment.fetch(desktopNotificationUrl(environment.location)+path,{
      ...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(2500),
    });
    if(!response.ok)throw new Error('Service unavailable');
    const result=await response.json();
    if(path==='/health'&&result.service!=='codex-desktop-notifications')throw new Error('Unexpected service');
    return result;
  }catch{throw new Error('桌面提醒服务未启动，请重新运行 Start-Workbench.cmd');}
}
