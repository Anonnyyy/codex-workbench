import {Client} from 'ssh2';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {reconnectSsh} from './ssh-reconnect.mjs';
const source=readFileSync(new URL('./remote_read_events.py',import.meta.url),'utf8')+'\n'+readFileSync(new URL('./remote_snapshot.py',import.meta.url),'utf8');
const retrySource=readFileSync(new URL('./remote_capacity_retry.py',import.meta.url),'utf8');
const queueSource="import types, sys, base64\n_transport=types.ModuleType('remote_capacity_retry')\nexec(base64.b64decode('"+Buffer.from(retrySource).toString('base64')+"'),_transport.__dict__)\nsys.modules['remote_capacity_retry']=_transport\n"+readFileSync(new URL('./remote_queue_send.py',import.meta.url),'utf8');
const fingerprint=key=>createHash('sha256').update(key).digest('hex');
function knownKeys(host,port){
 try{return readFileSync(join(homedir(),'.ssh','known_hosts'),'utf8').split('\n').filter(l=>l.split(' ')[0]?.split(',').includes(port===22?host:`[${host}]:${port}`)).map(l=>fingerprint(Buffer.from(l.split(' ')[2],'base64')));}catch{return [];}
}
export function connectSsh(device,password,onSnapshot,onStatus,onFingerprint){
 device={...device};
 return reconnectSsh(lifecycle=>connectSshOnce(device,password,
   snapshot=>{if(lifecycle.active()){lifecycle.healthy();onSnapshot(snapshot);}},
   status=>{if(lifecycle.active())onStatus(status);},
   value=>{if(lifecycle.active()){device.fingerprint=value;onFingerprint(value);}},lifecycle),onStatus);
}
function connectSshOnce(device,password,onSnapshot,onStatus,onFingerprint,lifecycle){
 const client=new Client(),known=knownKeys(device.host,device.port),expected=device.fingerprint?[device.fingerprint]:known;
 let buffer='',stderr='',closed=false,ready=false,verified,lastError='SSH 已断开',retryable=true;
 const settings={host:device.host,port:device.port||22,username:device.username,password,readyTimeout:12000,keepaliveInterval:10000,keepaliveCountMax:6,hostVerifier:key=>{verified=fingerprint(key);const valid=!expected.length||expected.includes(verified);if(!valid){retryable=false;lastError='SSH 主机身份不匹配，请核对设备地址';}return valid;}};
 client.on('ready',()=>{
   ready=true;
   if(!device.fingerprint)onFingerprint(verified);
   onStatus('正在读取远程任务');
   const encoded=Buffer.from(source).toString('base64');
   client.exec(`python3 -u -c "import base64; exec(base64.b64decode('${encoded}'))"`,(error,stream)=>{
     if(error){lastError=error.message;onStatus(lastError);return client.end();}
     stream.setEncoding('utf8');
     stream.on('data',chunk=>{
       buffer+=chunk.toString('utf8');if(buffer.length>16*1024*1024){onStatus('远程数据超出限制');return client.end();}
       let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(value.error)onStatus('远程读取失败：'+value.error);else if(Array.isArray(value.threads))onSnapshot(value);}catch{onStatus('远程响应格式错误');}}
     });
     stream.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-1000));
     stream.on('error',error=>{lastError=error.message;client.end();});
     stream.on('close',()=>{if(!closed){lastError=stderr?'采集结束：'+stderr:'SSH 采集已结束';onStatus(lastError);}client.end();});
   });
 });
 client.on('error',e=>{if(e.level==='client-authentication'||e.message.includes('authentication')){retryable=false;lastError='SSH 登录失败，请检查用户名或密码';}else if(retryable)lastError=e.message;onStatus(lastError);});
 client.on('close',()=>{ready=false;if(!closed)lifecycle.disconnected(lastError,retryable);});
 client.connect(settings);
 function queueRequest(request){
   if(!ready||closed)return Promise.resolve({status:'unavailable',message:'SSH 未连接'});
   const encoded=Buffer.from(queueSource).toString('base64');
   return new Promise(resolve=>client.exec(`python3 -u -c "import base64; exec(base64.b64decode('${encoded}'))"`,(error,stream)=>{
    if(error)return resolve({status:'unavailable',message:'无法打开消息发送通道'});
    let output='',settled=false;
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
    const timer=setTimeout(()=>{finish({status:'unknown'});stream.close();},60000);
    stream.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>65536){finish({status:'unknown'});stream.close();}});
    stream.on('error',()=>finish({status:'unknown'}));
    stream.on('close',()=>{try{finish(JSON.parse(output));}catch{finish({status:'unknown'});}});
    stream.stderr.on('data',()=>{});stream.end(JSON.stringify(request));
   }));
 }
 return {
  sendQueuedMessage:request=>queueRequest({...request,operation:'send'}),
  inspectQueuedMessage:request=>queueRequest({...request,operation:'inspect'}),
  retryCapacity(request){
   if(!ready||closed)return Promise.resolve({status:'unavailable',message:'SSH 未连接'});
   const encoded=Buffer.from(retrySource).toString('base64');
   return new Promise(resolve=>client.exec(`python3 -u -c "import base64; exec(base64.b64decode('${encoded}'))"`,(error,stream)=>{
    if(error)return resolve({status:'unavailable',message:'无法打开 SSH 重试通道'});
    let output='',settled=false;
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
    const timer=setTimeout(()=>{finish({status:'unknown',message:'重试回执超时，等待任务状态确认'});stream.close();},60000);
    stream.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>65536){finish({status:'unknown',message:'重试回执异常'});stream.close();}});
    stream.on('error',()=>finish({status:'unknown',message:'重试通道断开，等待任务状态确认'}));
    stream.on('close',()=>{try{finish(JSON.parse(output));}catch{finish({status:'unknown',message:'未收到重试回执，等待任务状态确认'});}});
    stream.stderr.on('data',()=>{});
    stream.end(JSON.stringify(request));
   }));
  },
  close(){closed=true;client.end();}
 };
}
