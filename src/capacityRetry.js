export function isCapacityError(error){
  if(!error||typeof error!=='object')return false;
  const code=error.codex_error_info??error.codexErrorInfo;
  return code==='server_overloaded'||code==='serverOverloaded'||/selected model is at capacity/i.test(error.message??'');
}

export function capacityRetryCount(record){
  const value=record?.totalAttempts??record?.attempts??0;
  return Number.isSafeInteger(value)&&value>0?value:0;
}

export function taskNotification(task,device,retrySupported=true,queue){
  // A terminal failure must never masquerade as successful completion.
  if(task.turnError||task.turnStatus==='failed')return null;
  if(task.state==='attention'&&task.attentionKind==='question')return 'question';
  if(task.state==='attention'&&task.attentionKind==='approval')return 'attention';
  if(task.state==='attention'&&task.turnStatus==='inProgress')return 'attention';
  if(!queue?.paused&&queue?.items?.length)return null;
  // Old collectors cannot distinguish capacity failure from completion.
  if(device?.type==='ssh'&&!retrySupported)return null;
  if(device?.autoRetryCapacity&&task.turnStatus!=='completed')return null;
  if(task.state==='completed'&&task.turnStatus==='inProgress')return null;
  return ['completed','attention','interrupted'].includes(task.state)?task.state:null;
}
