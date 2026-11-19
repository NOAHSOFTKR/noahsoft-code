import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
type Task = { runId?:string; type:string; id:string; nativeId:string; owner:string; description:string; status:string; background:boolean; outputFile?:string; summary?:string; stop:()=>Promise<void> };
const clean=(value:unknown)=>stripVTControlCharacters(String(value??'')).replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,500);
export class BackgroundTasks {
  private tasks=new Map<string,Task>();
  observe(owner:string,msg:Record<string,any>,stop:(id:string)=>Promise<void>): boolean {
    if(msg.subtype==='background_tasks_changed'&&Array.isArray(msg.tasks)){
      const present=new Set<string>();
      for(const task of msg.tasks){if(task.ambient)continue;const id=owner==='main'?task.task_id:`${owner}:${task.task_id}`;present.add(id);this.observe(owner,{...task,subtype:'task_started',is_backgrounded:true},stop);}
      for(const t of this.tasks.values())if(t.owner===owner&&t.background&&['running','pending','paused'].includes(t.status)&&!present.has(t.id))t.status='ended';
      return true;
    }
    if (!['task_started','task_updated','task_progress','task_notification'].includes(msg.subtype) || typeof msg.task_id!=='string' || msg.ambient || msg.skip_transcript) return false;
    const id=owner==='main'?msg.task_id:`${owner}:${msg.task_id}`;
    let t=this.tasks.get(id);
    if (!t) {
      if(this.tasks.size>=100){const ended=[...this.tasks.values()].find(x=>!['running','pending','paused'].includes(x.status));if(ended)this.tasks.delete(ended.id);}
      t={id,type:msg.task_type==='local_agent'?'agent':'command',runId:msg.run_id,nativeId:msg.task_id,owner,description:clean(msg.description),status:'running',background:msg.is_backgrounded===true,stop:()=>stop(msg.task_id)};
      this.tasks.set(id,t);
    }
    if(typeof msg.run_id==='string'&&t.runId&&msg.run_id<t.runId)return false;
    t.stop=()=>stop(msg.task_id);
    if(typeof msg.run_id==='string'&&msg.run_id!==t.runId){t.runId=msg.run_id;t.status='running';t.outputFile=undefined;}
    if(msg.description??msg.patch?.description)t.description=clean(msg.description??msg.patch.description);
    if(typeof msg.patch?.is_backgrounded==='boolean')t.background=msg.patch.is_backgrounded;
    if(typeof msg.is_backgrounded==='boolean')t.background=msg.is_backgrounded;
    if(msg.summary)t.summary=clean(msg.summary);
    if(typeof msg.output_file==='string'&&path.isAbsolute(msg.output_file))t.outputFile=msg.output_file;
    const status=msg.subtype==='task_notification'?msg.status:msg.patch?.status;
    if(['pending','running','completed','failed','stopped','killed','paused'].includes(status))t.status=status;
    return true;
  }
  has(id:string):boolean{return this.tasks.has(id);}
  list(){return [...this.tasks.values()].map(({id,type,owner,description,status,background,summary})=>({task_id:id,type,owner,description,status,background,summary}));}
  read(id:string){
    const t=this.tasks.get(id);if(!t)throw new Error('현재 세션에 없는 task_id입니다.');
    let output:string|null=null;let truncated=false;
    if(t.outputFile){
      let fd:number|undefined;
      try{
        const original=fs.lstatSync(t.outputFile);const normalize=(p:string)=>process.platform==='win32'?p.toLowerCase():p;
        if(!original.isFile())throw new Error('출력 파일이 아닙니다.');
        if(original.isSymbolicLink()||normalize(fs.realpathSync(t.outputFile))!==normalize(path.resolve(t.outputFile)))throw new Error('출력 경로가 링크로 변경되었습니다.');
        // Nonblocking open also rejects a FIFO swapped in after lstat without hanging the UI.
        fd=fs.openSync(t.outputFile,fs.constants.O_RDONLY|(fs.constants.O_NONBLOCK??0));const stat=fs.fstatSync(fd);if(stat.ino!==original.ino||stat.dev!==original.dev)throw new Error('출력 파일이 변경되었습니다.');if(!stat.isFile())throw new Error('출력 파일이 아닙니다.');
        const size=Math.min(stat.size,32768);const buf=Buffer.alloc(size);const read=fs.readSync(fd,buf,0,size,Math.max(0,stat.size-size));output=stripVTControlCharacters(buf.subarray(0,read).toString('utf8')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');truncated=stat.size>size;
      }catch(err){output=`출력 조회 불가: ${(err as Error).message}`;}finally{if(fd!==undefined)fs.closeSync(fd);}
    }
    const {outputFile,stop,nativeId,...view}=t;return {...view,output,truncated};
  }
  async stop(id:string){const t=this.tasks.get(id);if(!t)throw new Error('현재 세션에 없는 task_id입니다.');if(['running','pending','paused'].includes(t.status)){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([t.stop(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('작업 중단 응답 시간 초과')),2000);})]);t.status='stopped';}finally{if(timer)clearTimeout(timer);}}return this.read(id);}
  async stopAll(owner?:string){await Promise.allSettled([...this.tasks.values()].filter(t=>['running','pending','paused'].includes(t.status)&&(!owner||t.owner===owner)).map(t=>this.stop(t.id)));}
}
