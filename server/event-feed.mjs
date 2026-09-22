// Never queue every snapshot behind a sleeping browser: the next writable poll
// sends the latest complete state, so intermediate snapshots can be discarded.
export function createEventFeed(getState) {
  const clients=new Set();
  function send(res,message){
    if(res.destroyed||res.writableEnded){clients.delete(res);return;}
    if(res.writableNeedDrain||res.writableLength>0)return;
    try{res.write(message);}catch{clients.delete(res);res.destroy();}
  }
  return {
    add(res){clients.add(res);res.once('close',()=>clients.delete(res));res.once('error',()=>clients.delete(res));send(res,`data: ${JSON.stringify(getState())}\n\n`);},
    broadcast(){if(!clients.size)return;const message=`data: ${JSON.stringify(getState())}\n\n`;for(const res of clients)send(res,message);},
    heartbeat(){for(const res of clients)send(res,': heartbeat\n\n');},
    stats(){return {clients:clients.size,pendingBytes:[...clients].reduce((n,r)=>n+r.writableLength,0)};},
  };
}
