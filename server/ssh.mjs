import {Client} from 'ssh2';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const source=readFileSync(new URL('./remote_read_events.py',import.meta.url),'utf8')+'\n'+readFileSync(new URL('./remote_snapshot.py',import.meta.url),'utf8');
const fingerprint=key=>createHash('sha256').update(key).digest('hex');
function knownKeys(host,port){
 try{return readFileSync(join(homedir(),'.ssh','known_hosts'),'utf8').split('\n').filter(l=>l.split(' ')[0]?.split(',').includes(port===22?host:`[${host}]:${port}`)).map(l=>fingerprint(Buffer.from(l.split(' ')[2],'base64')));}catch{return [];}
}
export function connectSsh(device,password,onSnapshot,onStatus,onFingerprint){
 const client=new Client(),known=knownKeys(device.host,device.port),expected=device.fingerprint?[device.fingerprint]:known;
 let buffer='',stderr='',closed=false,verified;
 const settings={host:device.host,port:device.port||22,username:device.username,password,readyTimeout:12000,keepaliveInterval:10000,keepaliveCountMax:2,hostVerifier:key=>{verified=fingerprint(key);return !expected.length||expected.includes(verified);}};
 client.on('ready',()=>{
   if(!device.fingerprint)onFingerprint(verified);
   onStatus('正在读取远程任务');
   const encoded=Buffer.from(source).toString('base64');
   client.exec(`python3 -u -c "import base64; exec(base64.b64decode('${encoded}'))"`,(error,stream)=>{
     if(error){onStatus(error.message);return client.end();}
     stream.setEncoding('utf8');
     stream.on('data',chunk=>{
       buffer+=chunk.toString('utf8');if(buffer.length>16*1024*1024){onStatus('远程数据超出限制');return client.end();}
       let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);if(value.error)onStatus('远程读取失败：'+value.error);else if(Array.isArray(value.threads))onSnapshot(value);}catch{onStatus('远程响应格式错误');}}
     });
     stream.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-1000));
     stream.on('close',()=>{if(!closed)onStatus(stderr?'采集结束：'+stderr:'SSH 采集已结束');client.end();});
   });
 });
 client.on('error',e=>onStatus(e.message.includes('authentication')?'SSH 登录失败，请检查用户名或密码':e.message));
 client.on('close',()=>{if(!closed)onStatus('SSH 已断开，请重新连接');});
 client.connect(settings);
 return {close(){closed=true;client.end();}};
}
