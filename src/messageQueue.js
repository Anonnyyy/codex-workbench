export const QUEUE_LIMIT=3;
export const QUEUE_TEXT_LIMIT=8000;
export const queueHasWork=queue=>!!queue?.items?.length;
export const normalCompletion=task=>task?.state==='completed'&&task.turnStatus==='completed'&&!task.turnError&&!!task.turnId;
