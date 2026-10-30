// Turns raw rollout JSONL records into debugger nodes.
// Every node carries provenance: what was OBSERVED in the log. Module hints below are INFERRED.

const LANES = { user: 0, model: 1, harness: 2, agent: 3 };

// Inferred mapping: event kind -> where in codex-rs it is likely handled, plus grep terms
// used against CODEX_SRC. Nothing here is proof that a function ran.
const MODULE_HINTS = {
  session_meta:   { mod: 'core/src/session — 세션 생성, rollout에 SessionMeta 기록', terms: ['RolloutItem::SessionMeta'], path: ['record_initial_history', 'persist_rollout_items'] },
  turn_context:   { mod: 'core/src/session — 턴마다 TurnContext(model, sandbox, approval) 기록', terms: ['RolloutItem::TurnContext', 'TurnContextItem'], path: ['run_turn', 'persist_rollout_items'] },
  task_started:   { mod: 'core/src/session/mod.rs — TurnStartedEvent 발행 (rollout엔 task_started)', terms: ['TurnStartedEvent {'], path: ['run_turn'] },
  task_complete:  { mod: 'core/src/tasks/mod.rs — 턴 종료, TurnCompleteEvent', terms: ['TurnCompleteEvent {'], path: ['run_turn', 'run_turn_stop_hooks'] },
  turn_aborted:   { mod: 'core/src/tasks/mod.rs — 인터럽트 처리, TurnAbortedEvent', terms: ['TurnAbortedEvent {'], path: ['run_turn_interrupt_hooks'] },
  user:           { mod: 'core/src/session — 사용자 입력을 history에 넣고 턴 시작', terms: ['UserMessage'], path: ['run_turn', 'build_initial_context_with_world_state', 'run_sampling_request'] },
  context:        { mod: 'core/src/session — 초기 컨텍스트 구성 (instructions, AGENTS.md, 환경)', terms: ['build_initial_context_with_world_state'], path: ['build_initial_context_with_world_state', 'record_initial_history'] },
  world_state:    { mod: 'core/src/session/mod.rs — 작업 환경 상태 스냅샷 기록', terms: ['RolloutItem::WorldState'], path: ['build_initial_context_with_world_state', 'persist_rollout_items'] },
  reasoning:      { mod: 'core/src/client.rs — Responses 스트림의 reasoning item 수신', terms: ['ResponseItem::Reasoning'], path: ['run_turn', 'run_sampling_request', 'handle_output_item_done'] },
  assistant:      { mod: 'core/src/stream_events_utils.rs — 모델 출력 message item 처리', terms: ['handle_output_item_done'], path: ['run_turn', 'run_sampling_request', 'handle_output_item_done'] },
  inference:      { mod: 'core/src/state/session.rs — 모델 1회 호출당 TokenUsageRecord 생성·기록', terms: ['TokenUsageRecord {', 'RolloutItem::TokenUsageRecord'], path: ['run_sampling_request', 'persist_rollout_items'] },
  function_call:  { mod: 'core/src/tools — ToolRouter가 call 생성 → dispatch → handler', terms: ['dispatch_tool_call_with_state'], path: ['run_sampling_request', 'handle_output_item_done', 'build_tool_call', 'handle_tool_call', 'dispatch_tool_call_with_state'] },
  custom_tool_call:{ mod: 'core/src/tools — custom(freeform) 도구 / code mode(exec) dispatch', terms: ['CustomToolCall', 'dispatch_tool_call_with_code_mode_result'], path: ['handle_output_item_done', 'build_tool_call', 'handle_tool_call', 'dispatch_tool_call_with_code_mode_result'] },
  tool_output:    { mod: 'core/src/tools — 결과를 FunctionCallOutput으로 history에 기록, 다음 sampling 입력', terms: ['ResponseItem::FunctionCallOutput', 'ResponseItem::CustomToolCallOutput'], path: ['dispatch_tool_call_with_state', 'run_sampling_request'] },
  spawn_agent:    { mod: 'core/src/agent/control/spawn.rs — 하위 에이전트 스레드 생성', terms: ['"spawn_agent"'], path: ['dispatch_tool_call_with_state', 'spawn_agent'] },
  agent_message:  { mod: 'core/src/agent/control — 에이전트 간 메시지 (InterAgentCommunication)', terms: ['InterAgentCommunication::new'], path: ['spawn_agent'] },
  compacted:      { mod: 'core/src/compact.rs — 컨텍스트 압축 후 history 교체', terms: ['RolloutItem::Compacted'], path: ['run_inline_auto_compact_task', 'run_compact_task', 'run_compact_task_inner'] },
  settings:       { mod: 'core/src/session/mod.rs — 스레드 설정 적용 이벤트', terms: ['EventMsg::ThreadSettingsApplied'] },
  other:          { mod: '알 수 없음 — Raw 탭 참고', terms: [] },
};

function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => c.text ?? (c.encrypted_content ? '🔒 [encrypted]' : c.type ? `[${c.type}]` : '')).join('\n');
  return JSON.stringify(content, null, 2);
}

function tryJson(s) { try { return JSON.parse(s); } catch { return s; } }
function short(s, n = 90) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

class SessionModel {
  constructor() { this.reset(); }
  reset() {
    this.nodes = [];          // ordered nodes
    this.turns = [];          // {id, start, end, prompt, nodes:[]}
    this.calls = new Map();   // call_id -> call node
    this.meta = {};
    this.stats = { turns: 0, inference: 0, tools: 0, agents: 0, compactions: 0, inTok: 0, outTok: 0, cachedTok: 0, reasoningTok: 0 };
    this.curTurn = null;
    this.ctx = null;
  }

  turnFor(id) {
    if (!id) return this.curTurn || this.openTurn('pre');
    let t = this.turns.find(t => t.id === id);
    if (!t) t = this.openTurn(id);
    return t;
  }
  openTurn(id) {
    const t = { id, idx: this.turns.length + 1, start: null, end: null, prompt: '', nodes: [], status: 'running', inference: 0, tools: 0 };
    this.turns.push(t); this.curTurn = t; return t;
    }

  add(n, turnId) {
    n.i = this.nodes.length;
    n.turn = this.turnFor(turnId || this.curTurn?.id);
    n.turn.nodes.push(n);
    this.nodes.push(n);
    return n;
  }

  ingest(line) {
    let o; try { o = JSON.parse(line); } catch { return; }
    const p = o.payload || {};
    const ts = Date.parse(o.timestamp) || null;
    const base = { ts, raw: o, noise: false };
    const T = o.type, PT = p.type;

    if (T === 'session_meta') {
      this.meta = { id: p.id, cwd: p.cwd, cli: p.cli_version, originator: p.originator, provider: p.model_provider };
      return this.add({ ...base, kind: 'session_meta', lane: 'harness', title: 'Session start', sub: p.cwd, body: textOf(p.base_instructions?.text), bodyLabel: 'base_instructions (시스템 프롬프트)' });
    }
    if (T === 'turn_context') {
      this.meta.model = p.model || this.meta.model;
      this.meta.effort = p.effort || p.reasoning_effort || this.meta.effort;
      const t = this.turnFor(p.turn_id);
      return this.add({ ...base, kind: 'turn_context', lane: 'harness', noise: true, title: 'Turn context', sub: `${p.model || ''} · sandbox=${p.sandbox_policy?.type || '?'} · approval=${p.approval_policy || '?'}`, body: JSON.stringify(p, null, 2), bodyLabel: 'turn context', lang: 'json' }, t.id);
    }
    if (T === 'world_state') return this.add({ ...base, kind: 'world_state', lane: 'harness', noise: true, title: 'World state', sub: p.full ? 'full snapshot' : 'delta', body: JSON.stringify(p, null, 2), lang: 'json' });
    if (T === 'compacted') {
      this.stats.compactions++;
      return this.add({ ...base, kind: 'compacted', lane: 'harness', title: 'Context compaction', sub: `history → ${p.replacement_history?.length ?? '?'} items`, body: (p.message || '') + '\n\n' + JSON.stringify(p.replacement_history?.map(h => ({ type: h.type, role: h.role, text: short(textOf(h.content), 200) })), null, 2), bodyLabel: 'replacement_history (요약)', lang: 'json', hot: true });
    }
    if (T === 'token_usage_record') {
      const u = p.usage || {};
      const turn = this.turnFor(p.turn_id);
      turn.inference++; this.stats.inference++;
      this.stats.inTok += u.input_tokens || 0; this.stats.outTok += u.output_tokens || 0;
      this.stats.cachedTok += u.cached_input_tokens || 0; this.stats.reasoningTok += u.reasoning_output_tokens || 0;
      return this.add({ ...base, kind: 'inference', lane: 'model', title: `LLM call #${turn.inference}`, sub: `in ${fmt(u.input_tokens)} (cache ${fmt(u.cached_input_tokens)}) · out ${fmt(u.output_tokens)}${u.reasoning_output_tokens ? ` · reasoning ${fmt(u.reasoning_output_tokens)}` : ''}`, body: JSON.stringify(p, null, 2), lang: 'json', pill: true }, p.turn_id);
    }
    if (T === 'inter_agent_communication_metadata') return this.add({ ...base, kind: 'agent_message', lane: 'agent', noise: true, title: 'inter-agent meta', sub: JSON.stringify(p), body: JSON.stringify(p, null, 2), lang: 'json' });

    if (T === 'event_msg') {
      if (PT === 'task_started') {
        const t = this.turnFor(p.turn_id); t.start = ts; t.status = 'running'; this.stats.turns++;
        if (p.model_context_window) this.meta.window = p.model_context_window;
        return this.add({ ...base, kind: 'task_started', lane: 'harness', title: 'Turn started', sub: `mode=${p.collaboration_mode_kind || '-'} · window ${fmt(p.model_context_window)}`, body: JSON.stringify(p, null, 2), lang: 'json', boundary: true }, p.turn_id);
      }
      if (PT === 'task_complete' || PT === 'turn_aborted') {
        const t = this.turnFor(p.turn_id); t.end = ts; t.status = PT === 'turn_aborted' ? 'aborted' : 'done';
        return this.add({ ...base, kind: PT, lane: 'harness', title: PT === 'turn_aborted' ? `Turn aborted (${p.reason})` : 'Turn complete', sub: t.start ? `${((ts - t.start) / 1000).toFixed(1)}s · ${t.inference} LLM calls · ${t.tools} tools` : '', body: p.last_agent_message || JSON.stringify(p, null, 2), bodyLabel: 'last_agent_message', boundary: true }, p.turn_id);
      }
      if (PT === 'token_count') {
        const lu = p.info?.last_token_usage;
        if (lu) this.ctx = { used: lu.input_tokens + (lu.output_tokens || 0), window: p.info.model_context_window || this.meta.window };
        const n = this.add({ ...base, kind: 'token_count', lane: 'harness', noise: true, title: 'token_count', sub: this.ctx ? `context ${fmt(this.ctx.used)} / ${fmt(this.ctx.window)}` : '', body: JSON.stringify(p, null, 2), lang: 'json' });
        n.ctx = this.ctx; return n;
      }
      if (PT === 'item_completed' && p.item?.type === 'UserMessage') {
        const t = this.turnFor(p.turn_id);
        const txt = textOf(p.item.content);
        if (!t.prompt) t.prompt = txt;
        return this.add({ ...base, kind: 'user', lane: 'user', title: 'User prompt', sub: short(txt, 140), body: txt, bodyLabel: 'prompt', hot: true }, p.turn_id);
      }
      if (PT === 'thread_settings_applied') {
        const s = p.thread_settings || {};
        this.meta.model = s.model || this.meta.model; this.meta.effort = s.reasoning_effort || this.meta.effort;
        return this.add({ ...base, kind: 'settings', lane: 'harness', noise: true, title: 'Thread settings', sub: `${s.model || ''} · effort=${s.reasoning_effort || '-'} · summary=${s.reasoning_summary || '-'}`, body: JSON.stringify(p, null, 2), lang: 'json' });
      }
      // item_completed for non-user items mirrors response_items -> noise
      return this.add({ ...base, kind: 'other', lane: 'harness', noise: true, title: PT || 'event', sub: p.item?.type || '', body: JSON.stringify(p, null, 2), lang: 'json' }, p.turn_id);
    }

    if (T === 'response_item') {
      const meta = p.internal_chat_message_metadata_passthrough;
      const tid = meta?.turn_id;
      if (PT === 'message') {
        const txt = textOf(p.content);
        if (p.role === 'assistant') return this.add({ ...base, kind: 'assistant', lane: 'model', title: p.phase === 'commentary' ? 'Assistant (commentary)' : 'Assistant message', sub: short(txt, 140), body: txt, bodyLabel: 'model output', hot: true }, tid);
        // developer/user role items are the context the harness feeds into the model
        return this.add({ ...base, kind: 'context', lane: 'harness', noise: p.role === 'user', title: `Context → model (${p.role})`, sub: short(txt, 120), body: txt, bodyLabel: `${p.role} message as seen by model` }, tid);
      }
      if (PT === 'reasoning') {
        const sum = (p.summary || []).map(s => s.text).join('\n\n');
        return this.add({ ...base, kind: 'reasoning', lane: 'model', title: 'Reasoning', sub: sum ? short(sum, 140) : '🔒 encrypted — 요약 없음', body: sum || '(reasoning 전문은 암호화되어 로그에 없음. config에서 model_reasoning_summary = "detailed"면 요약이 기록됨)', bodyLabel: 'reasoning summary' }, tid);
      }
      if (PT === 'function_call' || PT === 'custom_tool_call' || PT === 'local_shell_call' || PT === 'web_search_call') {
        const isSpawn = p.name === 'spawn_agent';
        const args = PT === 'custom_tool_call' ? p.input : tryJson(p.arguments ?? JSON.stringify(p.action ?? {}));
        const name = (p.namespace ? p.namespace + '.' : '') + (p.name || PT);
        const t = this.turnFor(tid || this.curTurn?.id); t.tools++; this.stats.tools++;
        if (isSpawn) this.stats.agents++;
        const n = this.add({ ...base, kind: isSpawn ? 'spawn_agent' : PT === 'custom_tool_call' ? 'custom_tool_call' : 'function_call', lane: isSpawn ? 'agent' : 'model', title: `${isSpawn ? 'Spawn agent' : 'Tool call'} · ${name}`, sub: short(typeof args === 'string' ? args : JSON.stringify(args), 140), body: typeof args === 'string' ? args : JSON.stringify(args, null, 2), bodyLabel: PT === 'custom_tool_call' ? 'code / input' : 'arguments', lang: PT === 'custom_tool_call' ? 'code' : 'json', callId: p.call_id, toolName: p.name, hot: true }, tid);
        if (p.call_id) this.calls.set(p.call_id, n);
        return n;
      }
      if (PT === 'function_call_output' || PT === 'custom_tool_call_output') {
        const out = textOf(p.output) || (typeof p.output === 'object' ? JSON.stringify(p.output, null, 2) : '');
        const call = this.calls.get(p.call_id);
        const n = this.add({ ...base, kind: 'tool_output', lane: 'harness', title: `Tool result · ${call?.toolName || p.call_id}`, sub: short(out, 140), body: out, bodyLabel: 'output', callId: p.call_id }, tid || call?.turn?.id);
        if (call) { call.result = n; n.call = call; n.dur = ts && call.ts ? ts - call.ts : null; n.sub = `${n.dur != null ? (n.dur / 1000).toFixed(2) + 's · ' : ''}${short(out, 120)}`; }
        return n;
      }
      if (PT === 'agent_message') {
        return this.add({ ...base, kind: 'agent_message', lane: 'agent', title: `Agent msg ${p.author || ''} → ${p.recipient || ''}`, sub: short(textOf(p.content), 120), body: textOf(p.content), bodyLabel: 'agent message' }, tid);
      }
      return this.add({ ...base, kind: 'other', lane: 'harness', title: PT || 'response_item', sub: '', body: JSON.stringify(p, null, 2), lang: 'json' }, tid);
    }
    return this.add({ ...base, kind: 'other', lane: 'harness', noise: true, title: T, sub: PT || '', body: JSON.stringify(p, null, 2), lang: 'json' });
  }
}

function fmt(n) {
  if (n == null) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
