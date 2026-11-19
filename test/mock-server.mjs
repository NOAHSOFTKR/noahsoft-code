// 테스트 전용 Mock Anthropic API (실제 API 키 없이 Agent SDK 전체 파이프라인을 검증하기 위함)
// 제품 기능이 아니며 test/ 에서만 사용된다.
import http from 'node:http';

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock', 'anthropic-organization-id': 'org-mock-cvp' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i];
  return undefined;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_result' ? `[tool_result${c.is_error ? ':error' : ''}] ${typeof c.content === 'string' ? c.content : JSON.stringify(c.content)}` : ''))
    .join('\n');
}

export function startMock({ inputTokens = 1000, outputTokens = 50, deniedModels = [], status = {}, cacheReadTokens = 0, cacheWriteTokens = 0, beforeNoToolResponse } = {}) {
  const log = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = body ? JSON.parse(body) : undefined;
      log.push({ method: req.method, path: url.pathname, body: json, headers: req.headers });
      const headers = { 'content-type': 'application/json', 'anthropic-organization-id': 'org-mock-cvp', 'request-id': 'req_mock' };
      if (req.headers['x-api-key'] !== process.env.MOCK_EXPECT_KEY && process.env.MOCK_EXPECT_KEY) {
        res.writeHead(401, headers);
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, headers);
        return res.end(
          JSON.stringify({
            data: ['claude-sonnet-5-5', 'claude-denied-model'].map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' })),
            has_more: false,
            first_id: 'claude-sonnet-5-5',
            last_id: 'claude-denied-model',
          }),
        );
      }
      if (url.pathname.startsWith('/v1/models/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
        if (id === 'claude-nonexistent') {
          res.writeHead(404, headers);
          return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${id}` } }));
        }
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }));
      }
      if (url.pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, headers);
        return res.end(JSON.stringify({ input_tokens: 10 }));
      }
      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        const model = json.model;
        if (status[model]) {
          const [code, type, message] = status[model];
          res.writeHead(code, headers);
          return res.end(JSON.stringify({ type: 'error', error: { type, message } }));
        }
        if (deniedModels.includes(model) || model === 'claude-denied-model') {
          res.writeHead(403, headers);
          return res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: `Your organization does not have access to ${model}` } }));
        }
        const last = lastUser(json.messages);
        const lastText = textOf(last?.content);
        const hasToolResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
        // Agent 런타임의 부가 요청(제목 생성 등)은 tools 가 없음 → 짧은 텍스트
        const isMain = Array.isArray(json.tools) && json.tools.length > 0;
        const id = `msg_mock_${++n}`;
        const usage = { input_tokens: isMain ? inputTokens : 10, output_tokens: 1, cache_read_input_tokens: isMain ? cacheReadTokens : 0, cache_creation_input_tokens: isMain ? cacheWriteTokens : 0 };
        const start = ['message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }];
        const text = (t) => [
          ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
          ...t.match(/[\s\S]{1,12}/g).map((chunk) => ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunk } }]),
          ['content_block_stop', { index: 0 }],
        ];
        const tool = (name, input) => [
          ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name, input: {} } }],
          ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
          ['content_block_stop', { index: 0 }],
        ];
        const end = (stop) => [
          ['message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: isMain ? outputTokens : 5 } }],
          ['message_stop', {}],
        ];
        const toolNames = (json.tools ?? []).map((t) => t.name);
        const cwdMatch = JSON.stringify(json.system ?? '').match(/Primary working directory: ([^\\"]+)/);
        const cwd = cwdMatch ? cwdMatch[1].trim() : '.';
        if (!json.stream) {
          // 비스트리밍 요청(cvp verify 의 권한 확인 호출 등)
          res.writeHead(200, headers);
          return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }));
        }
        if (!isMain) return sse(res, [start, ...text('Mock title'), ...end('end_turn')]);
        if (!hasToolResult && lastText.includes('RUN_HTTP_MCP') && toolNames.includes('mcp__remote__hello')) {
          return sse(res, [start, ...tool('mcp__remote__hello', {}), ...end('tool_use')]);
        }
        if (toolNames.includes('mcp__cvp_agents__spawn_agent') && JSON.stringify(json.messages).includes('COORDINATE_AGENTS')) {
          const previous = json.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'tool_use');
          const idMatch = lastText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          let name = 'mcp__cvp_agents__spawn_agent';
          let args = {role:'explorer',message:'BANANA child research'};
          if (previous.length && idMatch) {
            const lastTool = previous.at(-1).name;
            if (lastTool.endsWith('spawn_agent') || lastTool.endsWith('send_message') || lastText.includes('running')) {
              name = 'mcp__cvp_agents__wait_agent'; args = {agent_id:idMatch[0],timeout_ms:10000};
            } else if (!previous.some((x) => x.name.endsWith('send_message'))) {
              name = 'mcp__cvp_agents__send_message'; args = {agent_id:idMatch[0],message:'RECALL child conversation'};
            } else return sse(res, [start, ...text('COORDINATION_DONE'), ...end('end_turn')]);
          }
          return sse(res,[start,...tool(name,args),...end('tool_use')]);
        }
        if(toolNames.includes('mcp__cvp_progress__update_todos')&&JSON.stringify(json.messages).includes('TODO_UPDATE')){
          const previous=json.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='tool_use'&&c.name==='mcp__cvp_progress__update_todos');
          if(previous.length<2)return sse(res,[start,...tool('mcp__cvp_progress__update_todos',{todos:[{content:'Inspect sample',activeForm:'Inspecting sample',status:previous.length?'completed':'in_progress'},{content:'Report results',activeForm:'Reporting results',status:previous.length?'completed':'pending'}]}),...end('tool_use')]);
        }
        if(toolNames.includes('mcp__cvp_agents__spawn_agent')&&lastText.includes('RUN_BACKGROUND_AGENT'))return sse(res,[start,...tool('mcp__cvp_agents__spawn_agent',{role:'explorer',message:lastText.includes('WRITE')?'DELAY_WRITE':'SLOW',background:true}),...end('tool_use')]);
        if(lastText.includes('RUN_BACKGROUND_POWERSHELL'))return sse(res,[start,...tool('Bash',{command:'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 2; Write-Output background-ready"',run_in_background:true,description:'Local Windows background test'}),...end('tool_use')]);
        if(lastText.includes('RUN_BACKGROUND_LONG'))return sse(res,[start,...tool('Bash',{command:'sleep 30; echo long-ready',run_in_background:true,description:'Local long background test'}),...end('tool_use')]);
        if(lastText.includes('RUN_BACKGROUND'))return sse(res,[start,...tool('Bash',{command:'sleep 2; echo background-ready',run_in_background:true,description:'Local background test'}),...end('tool_use')]);
        if (hasToolResult) {
          return sse(res, [start, ...text(`도구 결과 수신: ${lastText.slice(0, 200)}\n`), ...end('end_turn')]);
        }
        if (lastText.includes('RUN_SUBAGENT')) {
          return sse(res, [start, ...tool('Agent', { description: 'Explore sample project', prompt: 'SUBAGENT_READ_OUTSIDE', subagent_type: 'explorer', run_in_background: false }), ...end('tool_use')]);
        }
        if (lastText.includes('SUBAGENT_READ_OUTSIDE')) {
          const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
          return sse(res, [start, ...tool('Read', { file_path: outside }), ...end('tool_use')]);
        }
        if (lastText.includes('RUN_BASH')) {
          return sse(res, [start, ...tool('Bash', { command: 'echo hello-cvp', description: 'echo test' }), ...end('tool_use')]);
        }
        if (lastText.includes('RUN_POWERSHELL') && toolNames.includes('PowerShell')) {
          return sse(res, [start, ...tool('PowerShell', { command: 'Write-Output hello-ps' }), ...end('tool_use')]);
        }
        if(lastText.includes('DELAY_WRITE')){
          setTimeout(()=>{if(!res.destroyed)sse(res,[start,...tool('Write',{file_path:`${cwd}/cvp-out.txt`,content:'written by background'}),...end('tool_use')]);},1000);
          return;
        }
        if (lastText.includes('DANGEROUS_COMMAND')) {
          return sse(res, [start, ...tool('Bash', { command: 'echo rm -rf example' }), ...end('tool_use')]);
        }
        if (lastText.includes('WRITE_OUTSIDE')) {
          return sse(res, [start, ...tool('Write', { file_path: `${cwd}/../outside-write.txt`, content: 'must not write' }), ...end('tool_use')]);
        }
        if (lastText.includes('EDIT_FILE')) {
          return sse(res, [start, ...tool('Edit', { file_path: `${cwd}/README.md`, old_string: '# sample', new_string: '# edited' }), ...end('tool_use')]);
        }
        if (lastText.includes('WRITE_FILE')) {
          return sse(res, [start, ...tool('Write', { file_path: `${cwd}/cvp-out.txt`, content: 'written by mock\n' }), ...end('tool_use')]);
        }
        if (lastText.includes('READ_OUTSIDE')) {
          const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
          return sse(res, [start, ...tool('Read', { file_path: outside }), ...end('tool_use')]);
        }
        if (lastText.includes('RECALL')) {
          const all = json.messages.map((m) => textOf(m.content)).join(' | ');
          return sse(res, [start, ...text(`기억: ${all.includes('BANANA') ? 'BANANA 발견' : '없음'}\n`), ...end('end_turn')]);
        }
        if (lastText.includes('PRIORITY_NOW') || lastText.includes('QUEUED_NEXT')) return sse(res, [start, ...text('follow-up complete\n'), ...end('end_turn')]);
        if (beforeNoToolResponse && lastText.includes('STEER_NO_TOOL_ROOT')) {
          void beforeNoToolResponse().then(() => {
            if (!res.destroyed) sse(res, [start, ...text('first answer ends without tools'), ...end('end_turn')]);
          });
          return;
        }
        if (lastText.includes('SLOW')) {
          // 중단 테스트용: 천천히 스트리밍
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const evs = [start, ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }]];
          for (const [t, d] of evs) res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
          let i = 0;
          const timer = setInterval(() => {
            if (res.destroyed || i++ > 200) return clearInterval(timer);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `tick${i} ` } })}\n\n`);
          }, 100);
          res.on('close', () => clearInterval(timer));
          return;
        }
        return sse(res, [start, ...text('# 분석 결과\n\n프로젝트는 **정상**입니다.\n\n```js\nconsole.log("hi");\n```\n\n끝.\n'), ...end('end_turn')]);
      }
      res.writeHead(404, headers);
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `mock: ${req.method} ${url.pathname}` } }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, log, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mock-server.mjs')) {
  const m = await startMock();
  console.log(m.url);
}
