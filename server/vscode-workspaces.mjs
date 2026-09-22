import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';

export async function resolveWorkspaces(device,processes=[],base=process.env.APPDATA?join(process.env.APPDATA,'Code/User/workspaceStorage'):join(homedir(),'.config/Code/User/workspaceStorage')) {
  const aliases=new Set([device.host,device.name].filter(Boolean));
  // Match aliases by their explicit SSH HostName, without reading credentials.
  try{const text=await readFile(join(homedir(),'.ssh/config'),'utf8');let hosts=[];for(const line of text.split(/\r?\n/)){const m=line.trim().match(/^(Host|HostName)\s+(.+)$/i);if(!m)continue;if(m[1].toLowerCase()==='host')hosts=m[2].split(/\s+/).filter(h=>!/[!*?]/.test(h));else if(m[2].trim()===device.host)hosts.forEach(h=>aliases.add(h));}}catch{}
  return Promise.all(processes.map(async process=>{
    if(!/^[a-f0-9]{32}$/.test(process.workspaceId??''))return process;
    try{
      const info=JSON.parse(await readFile(join(base,process.workspaceId,'workspace.json'),'utf8'));
      if(!info.folder)return process;
      const uri=new URL(info.folder),authority=decodeURIComponent(uri.host);
      if(uri.protocol!=='vscode-remote:'||![...aliases].some(alias=>authority==='ssh-remote+'+alias))return process;
      return {...process,processCwd:process.processCwd??process.cwd,cwd:decodeURIComponent(uri.pathname),cwdSource:'vscode-workspace'};
    }catch{return process;}
  }));
}
