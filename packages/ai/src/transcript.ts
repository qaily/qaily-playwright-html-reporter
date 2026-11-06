// Turns streamed chat actions into a transcript model the UI renders, without touching the DOM.
// Shapes were verified against a real host.

import { textOf } from './session.ts';

export interface ToolOption {
  id?: string;
  label: string;
  kind: 'approve' | 'deny' | string;
}

export type TranscriptEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      turnId: string;
      name: string;
      message: string;
      input: string;
      /** asking = waiting for the user's Approve/Deny. */
      status: 'preparing' | 'running' | 'asking' | 'approved' | 'denied' | 'done' | 'failed';
      /** The host approved it by itself (reads/writes in the working dir, safe shell commands). */
      auto: boolean;
      options: ToolOption[];
      result: string;
    }
  | { kind: 'status'; id: string; text: string; error: boolean };

function prettyInput(toolInput: unknown): string {
  if (toolInput == null) return '';
  if (typeof toolInput !== 'string') return JSON.stringify(toolInput, null, 2);
  try {
    return JSON.stringify(JSON.parse(toolInput), null, 2);
  } catch {
    return toolInput;
  }
}

export function errorText(a: any): string {
  const info = a.part?.error ?? a.error ?? {};
  const msg = textOf(info.message ?? a.message) || 'Unknown error';
  const type = info.errorType ? ` [${info.errorType}]` : '';
  const hint = /No GitHub OAuth token/i.test(msg)
    ? ' The agent host is not signed in: add a GitHub token (gh auth token) in Settings → Tokens, or sign the host in from VS Code.'
    : /Personal Access Tokens are not supported/i.test(msg) || /400 Bad Request/.test(msg)
      ? ' Personal access tokens do not work through the agent host; use `gh auth token` (gho_…).'
      : '';
  return `Error${type}: ${msg}${hint}`;
}

export class Transcript {
  entries: TranscriptEntry[] = [];
  model: string | undefined;
  private onChange: () => void;

  constructor(onChange: () => void = () => {}) {
    this.onChange = onChange;
  }

  private find<K extends TranscriptEntry['kind']>(kind: K, id: string) {
    return this.entries.find((e) => e.kind === kind && e.id === id) as Extract<TranscriptEntry, { kind: K }> | undefined;
  }

  addUser(id: string, text: string): void {
    this.entries.push({ kind: 'user', id, text });
    this.onChange();
  }

  status(text: string, error = false): void {
    this.entries.push({ kind: 'status', id: crypto.randomUUID(), text, error });
    this.onChange();
  }

  /** Text the agent wrote in the given turn (markdown parts only, in order). */
  answerOf(partIds: string[]): string {
    return partIds.map((id) => this.find('text', id)?.text ?? '').join('');
  }

  /** Applies one chat action. Returns the id of a text part it created or extended, if any. */
  apply(a: any): string | null {
    let touched: string | null = null;
    switch (a.type) {
      case 'chat/responsePart': {
        const part = a.part ?? {};
        const id = part.id ?? crypto.randomUUID();
        if (part.kind === 'reasoning' || part.kind === 'thinking') {
          this.entries.push({ kind: 'reasoning', id, text: textOf(part.content ?? '') });
        } else if (part.kind === 'error') {
          this.entries.push({ kind: 'status', id, text: errorText({ part }), error: true });
        } else {
          // The part already carries the first chunk of text.
          this.entries.push({ kind: 'text', id, text: textOf(part.content ?? part.text ?? '') });
          touched = id;
        }
        break;
      }
      case 'chat/delta': {
        let e = this.find('text', a.partId) ?? this.find('reasoning', a.partId);
        if (!e) {
          e = { kind: 'text', id: a.partId, text: '' };
          this.entries.push(e);
        }
        e.text += a.content ?? '';
        if (e.kind === 'text') touched = e.id;
        break;
      }
      case 'chat/reasoning': {
        const id = a.partId ?? `reasoning-${a.turnId}`;
        let e = this.find('reasoning', id);
        if (!e) {
          e = { kind: 'reasoning', id, text: '' };
          this.entries.push(e);
        }
        e.text += textOf(a.content ?? a.text ?? '');
        break;
      }
      case 'chat/toolCallStart':
      case 'chat/toolCallDelta':
      case 'chat/toolCallReady':
      case 'chat/toolCallConfirmed':
      case 'chat/toolCallComplete':
        this.tool(a);
        break;
      case 'chat/usage': {
        const model = a.model ?? a.usage?.model;
        if (typeof model === 'string') this.model = model;
        break;
      }
      default:
        return null;
    }
    this.onChange();
    return touched;
  }

  private tool(a: any): void {
    let t = this.find('tool', a.toolCallId);
    if (!t) {
      t = {
        kind: 'tool', id: a.toolCallId, turnId: a.turnId, name: a.displayName ?? a.toolName ?? 'Tool', message: '', input: '',
        status: 'preparing', auto: true, options: [], result: '',
      };
      this.entries.push(t);
    }
    switch (a.type) {
      case 'chat/toolCallStart':
        t.name = a.displayName ?? a.toolName ?? t.name;
        break;
      case 'chat/toolCallDelta':
        if (a.invocationMessage) t.message = textOf(a.invocationMessage);
        break;
      case 'chat/toolCallReady': {
        const msg = textOf(a.confirmationTitle) || textOf(a.invocationMessage) || a.intention || '';
        if (msg) t.message = msg;
        t.input = prettyInput(a.toolInput);
        // With `confirmed` the host decided by itself; a real prompt arrives as a toolCallReady without it.
        if (a.confirmed) {
          if (t.status !== 'asking') t.status = 'running';
          break;
        }
        t.auto = false;
        t.status = 'asking';
        const options: ToolOption[] =
          Array.isArray(a.options) && a.options.length
            ? a.options
            : [{ label: 'Deny', kind: 'deny' }, { label: 'Approve', kind: 'approve' }];
        // Deny first: the safe choice is leftmost and focused.
        t.options = [...options.filter((o) => o.kind === 'deny'), ...options.filter((o) => o.kind !== 'deny')];
        break;
      }
      case 'chat/toolCallConfirmed':
        if (t.status === 'asking') t.status = a.approved ? 'approved' : 'denied';
        t.options = [];
        break;
      case 'chat/toolCallComplete':
        t.status = a.result?.success === false ? 'failed' : 'done';
        t.options = [];
        t.result = textOf(a.result?.pastTenseMessage);
        break;
    }
  }

  /** Tools currently waiting for the user. */
  pendingApprovals(): Extract<TranscriptEntry, { kind: 'tool' }>[] {
    return this.entries.filter((e): e is Extract<TranscriptEntry, { kind: 'tool' }> => e.kind === 'tool' && e.status === 'asking');
  }
}

export interface ChatLike {
  onAction(handler: (action: any) => void): () => void;
  sendPrompt(text: string): string;
  cancelTurn(turnId: string): void;
}

/**
 * Sends one prompt and resolves with the agent's answer text when the turn completes.
 * Rejects on chat/error, on cancel, or when the signal aborts.
 */
export function runTurn(chat: ChatLike, prompt: string, transcript: Transcript, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: string[] = [];
    let turnId = '';
    const early: any[] = [];
    const handle = (a: any) => {
      if (!turnId) return void early.push(a);
      if (a.turnId !== undefined && a.turnId !== turnId) return;
      // The server echoes our own turnStarted; the transcript already shows the prompt.
      if (a.type === 'chat/turnStarted') return;
      if (a.type === 'chat/turnComplete') return finish(() => resolve(transcript.answerOf(parts)));
      if (a.type === 'chat/turnCancelled') return finish(() => reject(new Error('Cancelled')));
      if (a.type === 'chat/error') {
        const text = errorText(a);
        transcript.status(text, true);
        return finish(() => reject(new Error(text)));
      }
      const touched = transcript.apply(a);
      if (touched && !parts.includes(touched)) parts.push(touched);
    };
    const off = chat.onAction(handle);
    const onAbort = () => {
      if (turnId) chat.cancelTurn(turnId);
      finish(() => reject(new Error('Cancelled')));
    };
    const finish = (settle: () => void) => {
      off();
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    if (signal?.aborted) return finish(() => reject(new Error('Cancelled')));
    signal?.addEventListener('abort', onAbort);
    turnId = chat.sendPrompt(prompt);
    transcript.addUser(turnId, prompt);
    for (const a of early.splice(0)) handle(a);
  });
}
