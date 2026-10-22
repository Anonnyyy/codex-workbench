import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';

// Observe the UI's IPC router as well as the remote collectors. The Windows
// extension can host an SSH task's webview and publish its reads locally.
export function createReadEventTracker(){
  const marks=new Map();
  return {
    accept(message,now=Date.now()){
      const p=message?.params;
      if(message?.type!=='broadcast'||message.method!=='thread-read-state-changed'||message.version!==3||p?.hostId!=='local'||typeof p.hasUnreadTurn!=='boolean'||typeof p.conversationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(p.conversationId))return;
      marks.set(p.conversationId,{unread:p.hasUnreadTurn,at:now});
    },
    apply(threads){
      const counts=new Map();for(const t of threads)counts.set(t.id,(counts.get(t.id)??0)+1);
      for(const t of threads){
        const mark=marks.get(t.id);
        const newerEvent=t.nativeReadSource?.endsWith('ipc')&&(t.nativeReadAt??0)>(mark?.at??0);
        if(counts.get(t.id)!==1||!mark||!t.online||!Number.isFinite(Date.parse(t.revision))||mark.at<Date.parse(t.revision)||newerEvent)continue;
        Object.assign(t,{nativeUnread:mark.unread,nativeReadAt:mark.at,nativeReadSource:'vscode-ui-ipc'});
      }
    },
  };
}

export function observeVscodeReads({tracker=createReadEventTracker(),socketPath=process.platform==='win32'?'\\\\.\\pipe\\codex-ipc':join(process.env.CODEX_HOME||join(homedir(),'.codex'),'ipc/ipc.sock'),retryMs=3000}={}){
  let socket,timer,closed=false,connected=false;
  function connect(){
    if(closed)return;
    let buffer=Buffer.alloc(0);
    const requestId=randomUUID();
    socket=net.createConnection(socketPath);
    const send=message=>{const data=Buffer.from(JSON.stringify(message)),frame=Buffer.alloc(data.length+4);frame.writeUInt32LE(data.length);data.copy(frame,4);socket.write(frame);};
    socket.on('connect',()=>send({type:'request',requestId,sourceClientId:'uninitialized',method:'initialize',params:{clientType:'codex-workbench-observer'},version:0}));
    socket.on('data',part=>{
      buffer=Buffer.concat([buffer,part]);
      while(buffer.length>=4){
        const size=buffer.readUInt32LE();
        if(!size||size>48*1024*1024){socket.destroy();return;}
        if(buffer.length<size+4)return;
        let message;try{message=JSON.parse(buffer.subarray(4,size+4));}catch{socket.destroy();return;}
        buffer=buffer.subarray(size+4);
        if(message.requestId===requestId&&message.resultType==='success')connected=true;
        // Never claim ownership or issue task commands.
        if(message.type==='client-discovery-request')send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});
        tracker.accept(message);
      }
    });
    socket.on('error',()=>{});
    socket.on('close',()=>{connected=false;if(!closed){timer=setTimeout(connect,retryMs);timer.unref();}});
    socket.unref();
  }
  connect();
  return {apply:tracker.apply,get connected(){return connected;},close(){closed=true;clearTimeout(timer);socket?.destroy();}};
}
