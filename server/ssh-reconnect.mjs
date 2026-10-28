// Credentials remain inside the connection closure and are never persisted.
export function reconnectSsh(open,onStatus,{setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let connection,timer,closed=false,attempt=0,generation=0;
  const start=()=>{
    if(closed)return;
    const current=++generation;
    connection=open({
      active:()=>!closed&&current===generation,
      healthy:()=>{if(!closed&&current===generation)attempt=0;},
      disconnected:(reason,retryable=true)=>{
        if(closed||current!==generation)return;
        ++generation;
        if(!retryable){onStatus(reason);return;}
        const delay=Math.min(30000,2000*2**Math.min(attempt++,4));
        onStatus(`${reason}，${delay/1000} 秒后自动重连`);
        timer=setTimer(start,delay);
      },
    });
  };
  start();
  return {
    sendQueuedMessage:request=>connection.sendQueuedMessage(request),
    inspectQueuedMessage:request=>connection.inspectQueuedMessage(request),
    retryCapacity:request=>connection.retryCapacity(request),
    close(){closed=true;++generation;clearTimer(timer);connection?.close();},
  };
}
