import { createAssistantMessageEventStream, streamSimple } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Agent } from '@earendil-works/pi-agent-core';
import { Container } from '@earendil-works/pi-tui';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
const record = value => { if (process.env.JOINT_CONTACT_CAPTURE) appendFileSync(process.env.JOINT_CONTACT_CAPTURE, JSON.stringify({ ...value, pid: process.pid, child: process.env.PI_SUBAGENT_CHILD === '1' }) + '\n'); };

export default async function (pi) {
  const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  const module = async (name, entry='index.js') => import(pathToFileURL(path.join(host,'..',name,'dist',entry)));
  const [coding,core,tui,ai]=await Promise.all([import(pathToFileURL(path.join(host,'dist/index.js'))),module('pi-agent-core'),module('pi-tui'),module('pi-ai','compat.js')]);
  record({type:'identities',allEqual:SessionManager===coding.SessionManager&&Agent===core.Agent&&Container===tui.Container&&streamSimple===ai.streamSimple,root:host});
  let requests = 0;
  for (const type of ['subagent:async-complete','subagent:process-terminal']) pi.events.on(type, value => record({ type, value }));
  pi.events.on('pi-config:root-owner-ready', value => record({type:'root-owner-ready',value}));
  pi.on('session_start', (_event, ctx) => record({ type: 'start', actualModel: {provider:ctx.model?.provider,id:ctx.model?.id,api:ctx.model?.api}, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), tools: pi.getAllTools().map(t => ({ name: t.name, exposure: t.exposure })) }));
  pi.on('message_end', event => { const m = event.message; if (m.customType === 'subagent_supervisor_request' || (m.role === 'toolResult' && ['subagent', 'subagent_supervisor', 'contact_supervisor'].includes(m.toolName))) record({ type: 'message_end', message: m }); });
  pi.registerProvider('joint-contact', {
    api: 'joint-contact', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      if(++requests>64)throw new Error('fixture turn budget exhausted');
      const stream = createAssistantMessageEventStream(); const messages = context.messages;
      const user = messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('')).join('\n');
      const results = messages.filter(m => m.role === 'toolResult'); let next; let text = 'JOINT_DONE'; const scenario = process.env.JOINT_CONTACT_CASE ?? 'ask';
      const child = process.env.PI_SUBAGENT_CHILD === '1';
      if (child) {
        const contactResults=results.filter(r=>r.toolName==='contact_supervisor');
        const result = scenario==='repeat-question' && contactResults.length<2 ? undefined : contactResults.at(-1);
        if(scenario==='two-asks' && contactResults.length<2) next={name:'contact_supervisor',arguments:{reason:'need_decision',message:'parallel-ask-a'}};
        else if(scenario==='child-mcp') {
          const nested=results.find(r=>r.toolName==='codemode');
          if(!nested) next={name:'codemode',arguments:{code:'text(await tools.mcp__fixture__echo({value:"child-mcp-allowed"}));try { await tools.mcp__fixture__forbidden({}); } catch(e) { text("denied:"+e.message); }'}};
          else text='JOINT_CHILD_MCP '+nested.content.map(c=>c.text??'').join('');
        }
        else if(scenario==='empty') text='JOINT_EMPTY_CHILD';
        else if (!result) next = { name: 'contact_supervisor', arguments: { reason: scenario === 'interview' ? 'interview_request' : scenario === 'progress' ? 'progress_update' : 'need_decision', message: 'joint-contact-nonce', ...(scenario === 'interview' ? { interview: { question: 'fixture' } } : {}) } };
        else text = result.isError ? 'JOINT_CHILD_FAILED' : 'JOINT_CHILD_CONSUMED ' + (result.details?.requestId ?? '') + ' ' + result.content.map(c => c.text ?? '').join('');
        if (scenario === 'managed' && result && !result.isError) text += '\n```acceptance-report\n' + JSON.stringify({ criteriaSatisfied: [{ id: 'criterion-1', status: 'satisfied', evidence: '规范contact工具实际收到joint-reply-nonce' }], changedFiles: [], testsAddedOrUpdated: [], commandsRun: [{ command: 'contact_supervisor', result: 'passed', summary: '真实supervisor往返' }], validationOutput: ['joint-reply-nonce'], residualRisks: ['合成provider只证明通信与资源链，不代表实现模型'], noStagedFiles: true, diffSummary: '无源码修改', manualNotes: '只读通信测试' }) + '\n```';
      } else {
        const request = messages.find(m => m.customType === 'subagent_supervisor_request');
        let modelVisibleRequestId = [...user.matchAll(/replyTo:\s*"([0-9a-f-]+)"/g)].at(-1)?.[1];
        if(scenario==='two-asks') {
          const ids=[...user.matchAll(/replyTo:\s*"([0-9a-f-]+)"/g)].map(m=>m[1]);
          modelVisibleRequestId=ids.find(id=>!results.some(r=>r.toolName==='subagent_supervisor'&&r.content.some(c=>c.text?.includes('Replied to supervisor request '+id))));
        }
        if (!results.some(r => r.toolName === 'subagent')) next = { name: 'subagent', arguments: { agent: 'executor', task: 'JOINT_CHILD_ASK', title: 'Contact supervisor真实往返', model: 'joint-contact/fixture', ...(['managed','root-close','lease-expire'].includes(scenario) ? { worktree: true, writePaths: ['base.txt'], acceptance: { criteria: ['完成隔离通信测试'] } } : {}) } };
        else if (results.some(r => r.toolName === 'subagent' && r.isError)) text = 'JOINT_PARENT_SPAWN_FAILED';
        else if (scenario === 'invalid-reply' && modelVisibleRequestId && results.filter(r=>r.toolName==='subagent_supervisor').length < 3) {
          const n=results.filter(r=>r.toolName==='subagent_supervisor').length;
          next={name:'subagent_supervisor',arguments:n===0?{action:'reply',replyTo:'unknown-request',message:'bad'}:n===1?{action:'reply',to:'executor',message:'bad'}:{action:'reply',message:'bad'}};
        }
        else if (results.some(r=>r.toolName==='subagent_supervisor'&&r.isError)) text='JOINT_PARENT_REPLY_BLOCKED';
        else if (scenario === 'stop' && modelVisibleRequestId && !results.some(r=>r.toolName==='subagent' && r.content.some(c=>c.text?.includes('stopp')))) next={name:'subagent',arguments:{action:'stop',id:user.match(/Run:\s*([a-f0-9-]+)/)?.[1]}};
        else if (!['root-close','lease-expire'].includes(scenario) && scenario !== 'timeout' && scenario !== 'restart-first' && scenario !== 'stop' && modelVisibleRequestId && !results.some(r => r.toolName === 'subagent_supervisor' && r.content.some(c => c.text?.includes('Replied to supervisor request '+modelVisibleRequestId)))) {
          const pending = results.findLast(r => r.toolName === 'subagent_supervisor' && r.content.some(c => c.text?.includes(modelVisibleRequestId)));
          if (!pending) next = { name: 'subagent_supervisor', arguments: { action: 'pending' } };
          else next = { name: 'subagent_supervisor', arguments: { action: 'reply', replyTo: modelVisibleRequestId, message: scenario === 'interview' ? '{"answer":"joint-reply-nonce"}' : 'joint-reply-nonce' } };

        } else text = modelVisibleRequestId ? 'JOINT_PARENT_REPLIED' : 'JOINT_WAITING';
      }
      const content = next ? [{ type: 'toolCall', id: 'joint-call-' + process.pid + '-' + Date.now(), name: next.name, arguments: next.arguments }] : [{ type: 'text', text }];
      if(child&&scenario==='two-asks'&&next?.name==='contact_supervisor') content.push({...content[0],id:content[0].id+'-b',arguments:{reason:'need_decision',message:'parallel-ask-b'}});
      if (!child && scenario === 'duplicate' && next?.name === 'subagent_supervisor' && next.arguments.action === 'reply') content.push({ ...content[0], id: content[0].id + '-duplicate' });
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: next ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'start', partial: message });
      if (next) for(let i=0;i<content.length;i++){ stream.push({ type: 'toolcall_start', contentIndex: i, partial: message }); stream.push({ type: 'toolcall_delta', contentIndex: i, delta: JSON.stringify(content[i].arguments), partial: message }); stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: content[i], partial: message }); }
      else { stream.push({ type: 'text_start', contentIndex: 0, partial: message }); stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message }); stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message }); }
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
    },
  });
}
