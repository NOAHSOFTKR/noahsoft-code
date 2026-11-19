import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { cvpHome } from './config.js';
import { stripVTControlCharacters } from 'node:util';
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string };
export class TodoList {
  private scopes = new Map<string, Todo[]>();
  private sessionId?: string;
  bind(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.scopes.clear();
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) for (const [scope, items] of Object.entries(data)) {
        try { this.scopes.set(scope, this.validate(items)); } catch { /* invalid saved list */ }
      }
    } catch { /* first use */ }
  }
  private file(): string { return path.join(cvpHome(), 'todos', `${this.sessionId!.replace(/[^a-zA-Z0-9-]/g, '_')}.json`); }
  private validate(value: unknown): Todo[] {
    if (!Array.isArray(value) || value.length > 100) throw new Error('할 일 목록은 최대 100개여야 합니다.');
    return value.map((item) => {
      if (!item || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 1000 || !['pending','in_progress','completed'].includes(item.status)) throw new Error('잘못된 할 일 항목입니다.');
      return { content: stripVTControlCharacters(item.content).replace(/[\x00-\x1f\x7f-\x9f]/g,' '), status: item.status,
        ...(typeof item.activeForm === 'string' ? { activeForm: stripVTControlCharacters(item.activeForm).slice(0,1000).replace(/[\x00-\x1f\x7f-\x9f]/g,' ') } : {}) };
    });
  }
  update(scope: string, items: unknown): void {
    this.scopes.set(scope, this.validate(items));
    if (this.sessionId) { const file=this.file();fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(Object.fromEntries(this.scopes),null,2)+'\n','utf8'); }
  }
  snapshot() {
    return [...this.scopes].map(([owner,items])=>({owner,items:structuredClone(items),completed:items.filter((x)=>x.status==='completed').length,total:items.length}));
  }
  lines(owner?:string): string[] {
    const scopes=this.snapshot().filter(scope=>!owner||scope.owner===owner);
    if (!scopes.length) return ['Todo: 아직 등록된 할 일이 없습니다.'];
    return scopes.flatMap((scope)=>[`Todo [${stripVTControlCharacters(scope.owner).replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,100)}]: ${scope.completed}/${scope.total} 완료`,...scope.items.map((t)=>`  ${t.status==='completed'?'[x]':t.status==='in_progress'?'[>]':'[ ]'} ${t.content}`)]);
  }
}


export const TODO_TOOL_NAMES = ['update_todos','get_todos'].map(name=>`mcp__cvp_progress__${name}`);
export function todoServer(store:TodoList,owner:string,notice?:(text:string)=>void){
  const result=(action:()=>unknown)=>{try{return {content:[{type:'text' as const,text:JSON.stringify(action())}]};}catch(err){return {isError:true,content:[{type:'text' as const,text:(err as Error).message}]};}};
  const item=z.object({content:z.string().trim().min(1).max(1000),status:z.enum(['pending','in_progress','completed']),activeForm:z.string().max(1000).optional()});
  return createSdkMcpServer({name:'cvp_progress',version:'1.0.0',tools:[
    tool('update_todos','Replace your task list. Mark one task in_progress while working, and completed only after verifying it. User sees updates.',{todos:z.array(item).max(100)},async args=>result(()=>{store.update(owner,args.todos);notice?.(store.lines(owner).join('\n'));return store.snapshot().find(s=>s.owner===owner);})),
    tool('get_todos','Read task progress. Main agent can see all agent lists; workers see their own list.',{},async()=>result(()=>store.snapshot().filter(s=>owner==='main'||s.owner===owner))),
  ]});
}
