import { describe, expect, it } from 'vitest';
import { Transcript, runTurn, type ChatLike } from '../src/transcript.ts';
import { extractJson } from '../src/extract.ts';

class FakeChat implements ChatLike {
  handlers: ((a: any) => void)[] = [];
  sent: string[] = [];
  cancelled: string[] = [];
  turnId = 'turn-1';
  onAction(h: (a: any) => void) {
    this.handlers.push(h);
    return () => (this.handlers = this.handlers.filter((x) => x !== h));
  }
  sendPrompt(text: string) {
    this.sent.push(text);
    return this.turnId;
  }
  cancelTurn(id: string) {
    this.cancelled.push(id);
  }
  emit(a: any) {
    for (const h of [...this.handlers]) h({ turnId: this.turnId, ...a });
  }
}

describe('runTurn', () => {
  it('collects markdown parts and deltas, ignores the echoed turnStarted and other turns', async () => {
    const chat = new FakeChat();
    const t = new Transcript();
    const p = runTurn(chat, 'hi', t);
    chat.emit({ type: 'chat/turnStarted' });
    chat.emit({ type: 'chat/responsePart', part: { kind: 'markdown', id: 'p1', content: 'Hello' } });
    chat.emit({ type: 'chat/delta', partId: 'p1', content: ' world' });
    chat.emit({ type: 'chat/responsePart', part: { kind: 'reasoning', id: 'r1', content: 'thinking' } });
    chat.emit({ type: 'chat/delta', turnId: 'other', partId: 'p1', content: 'NOPE' });
    chat.emit({ type: 'chat/usage', model: 'claude-sonnet-5.5' });
    chat.emit({ type: 'chat/turnComplete', duration: 10 });
    expect(await p).toBe('Hello world');
    expect(t.model).toBe('claude-sonnet-5.5');
    expect(t.entries.map((e) => e.kind)).toEqual(['user', 'text', 'reasoning']);
    expect(chat.handlers).toHaveLength(0);
  });

  it('marks host-decided tool calls as auto, and real prompts as asking with deny first', async () => {
    const chat = new FakeChat();
    const t = new Transcript();
    const p = runTurn(chat, 'x', t);
    chat.emit({ type: 'chat/toolCallStart', toolCallId: 't1', toolName: 'read', displayName: 'Read file' });
    chat.emit({ type: 'chat/toolCallReady', toolCallId: 't1', confirmed: 'not-needed' });
    chat.emit({ type: 'chat/toolCallComplete', toolCallId: 't1', result: { success: true, pastTenseMessage: 'Read a.ts' } });
    chat.emit({ type: 'chat/toolCallStart', toolCallId: 't2', toolName: 'shell' });
    chat.emit({ type: 'chat/toolCallReady', toolCallId: 't2', confirmed: 'not-needed' });
    chat.emit({ type: 'chat/toolCallReady', toolCallId: 't2', confirmationTitle: 'Run in terminal?', toolInput: '{"cmd":"rm x"}',
      options: [{ id: 'allow-once', label: 'Allow once', kind: 'approve' }, { id: 'skip', label: 'Skip', kind: 'deny' }] });
    const asking = t.pendingApprovals();
    expect(asking.map((a) => a.id)).toEqual(['t2']);
    expect(asking[0].options[0].kind).toBe('deny');
    expect(asking[0].input).toContain('"cmd": "rm x"');
    chat.emit({ type: 'chat/toolCallConfirmed', toolCallId: 't2', approved: false });
    chat.emit({ type: 'chat/turnComplete' });
    await p;
    const tools = t.entries.filter((e) => e.kind === 'tool') as any[];
    expect(tools.map((x) => [x.status, x.auto])).toEqual([['done', true], ['denied', false]]);
  });

  it('rejects on chat/error with a hint, and cancels on abort', async () => {
    const chat = new FakeChat();
    const p = runTurn(chat, 'x', new Transcript());
    chat.emit({ type: 'chat/error', part: { kind: 'error', error: { errorType: 'query', message: 'No GitHub OAuth token or Copilot HMAC key provided' } } });
    await expect(p).rejects.toThrow(/not signed in/);

    const chat2 = new FakeChat();
    const ac = new AbortController();
    const p2 = runTurn(chat2, 'x', new Transcript(), ac.signal);
    ac.abort();
    await expect(p2).rejects.toThrow('Cancelled');
    expect(chat2.cancelled).toEqual(['turn-1']);
  });
});

describe('extractJson', () => {
  it('prefers the last json block, falls back to other blocks and bare JSON', () => {
    expect(extractJson('a\n```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('```\n{"b":1}\n```')).toEqual({ b: 1 });
    expect(extractJson('```json\n{broken\n```\n```ts\nconst x = 1\n```')).toBeUndefined();
    expect(extractJson('  {"c":3} ')).toEqual({ c: 3 });
    expect(extractJson('no json here')).toBeUndefined();
  });
});
