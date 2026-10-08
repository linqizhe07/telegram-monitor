// The activity log: what the service did, as it happens. Every request the reader account sends to
// Telegram passes through one wrapped `invoke`, so nothing it does on the account goes unrecorded.

import type { ActivityKind, ActivityRow, Store } from './store.ts';

type Listener = (row: ActivityRow) => void;

export class Activity {
  private readonly store: Store;
  private readonly listeners = new Set<Listener>();

  constructor(store: Store) {
    this.store = store;
  }

  record(a: { actor: string; kind: ActivityKind; method: string; target?: string; detail?: string; ok?: boolean; ms?: number | null }): ActivityRow {
    const row = this.store.addActivity({
      actor: a.actor,
      kind: a.kind,
      method: a.method,
      target: a.target ?? '',
      detail: a.detail ?? '',
      ok: a.ok ?? true,
      ms: a.ms ?? null,
    });
    for (const l of this.listeners) {
      try {
        l(row);
      } catch {
        // a broken listener (a closed browser tab) must not break the service
      }
    }
    return row;
  }

  /** A one-line event (pulled 12 messages, digest written, …). */
  event(actor: string, method: string, target = '', detail = '', ok = true): ActivityRow {
    return this.record({ actor, kind: ok ? 'event' : 'error', method, target, detail, ok });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

// ── classifying MTProto requests ───────────────────────────────────────────

const SYSTEM = /^(help|updates|langpack)\.|^(InvokeWithLayer|InitConnection|InvokeWithoutUpdates|Ping|PingDelayDisconnect|DestroySession|ReqPq|ReqDHParams|SetClientDHParams)$|^auth\.(ExportAuthorization|ImportAuthorization|BindTempAuthKey)$/;
// Upkeep-looking reads that do say something about the account's chats: paced and recorded.
const RECORDED_UPKEEP = new Set(['help.GetAppConfig', 'updates.GetDifference', 'updates.GetChannelDifference']);
const READ = /^\w+\.(Get|Check|Resolve|Search)\w*$/;
// Reads by name that still change something someone else can see.
const READS_THAT_WRITE = new Set(['messages.GetBotCallbackAnswer', 'messages.GetMessagesViews']);

/** read / write / system for a GramJS request class name (e.g. "messages.GetHistory"). Unknown = write, to be safe. */
export function classify(className: string, request?: { increment?: boolean }): ActivityKind {
  if (RECORDED_UPKEEP.has(className)) return 'read';
  if (SYSTEM.test(className)) return 'system';
  if (className === 'messages.GetMessagesViews') return request?.increment ? 'write' : 'read';
  if (READS_THAT_WRITE.has(className) || className.startsWith('payments.')) return 'write';
  if (READ.test(className)) return 'read';
  return 'write';
}

type Peerish = { className?: string; channelId?: unknown; chatId?: unknown; userId?: unknown } | undefined;

/** Which chat a request is about, as a readable label: "@name", a known chat title, or an id. */
export function describeTarget(req: Record<string, unknown>, titleOf: (chatId: number) => string | null): string {
  const label = (p: Peerish): string | null => {
    if (!p || typeof p !== 'object') return null;
    if (p.className === 'InputPeerSelf' || p.className === 'InputUserSelf') return 'self';
    if (p.channelId !== undefined) {
      const id = -(1_000_000_000_000 + Number(String(p.channelId)));
      return titleOf(id) ?? String(id);
    }
    if (p.chatId !== undefined) return titleOf(-Number(String(p.chatId))) ?? `chat ${String(p.chatId)}`;
    if (p.userId !== undefined) return `user ${String(p.userId)}`;
    return null;
  };
  if (typeof req.username === 'string') return `@${req.username}`;
  if (typeof req.hash === 'string') return `invite ${req.hash.slice(0, 4)}…`;
  // A chat's notification settings carry it one level down; a forward names where it came from.
  const direct =
    label(req.channel as Peerish) ?? label(req.peer as Peerish) ?? label((req.peer as { peer?: Peerish } | undefined)?.peer) ?? label(req.fromPeer as Peerish) ?? (req.chatId !== undefined ? label({ chatId: req.chatId }) : null);
  if (direct) return direct;
  if (Array.isArray(req.id) && req.id.length > 0 && typeof req.id[0] === 'object') return label(req.id[0] as Peerish) ?? '';
  return '';
}

/** A few numbers worth seeing about a request and its answer. */
export function describeCall(className: string, req: Record<string, unknown>, res: unknown): string {
  const parts: string[] = [];
  if (className === 'messages.GetHistory') {
    for (const k of ['limit', 'offsetId', 'minId', 'offsetDate'] as const) if (req[k]) parts.push(`${k} ${String(req[k])}`);
  }
  if (Array.isArray(req.id) && className.endsWith('GetMessages')) parts.push(`${req.id.length} ids`);
  if (className === 'messages.SendReaction') {
    const r = (req.reaction as { emoticon?: string }[] | undefined) ?? [];
    parts.push(`#${String(req.msgId)} ${r.length ? r.map((x) => x.emoticon ?? '?').join('') : 'reaction taken back'}`);
  }
  if (className === 'messages.ForwardMessages' && (req.toPeer as Peerish)?.className === 'InputPeerSelf') parts.push('→ Saved Messages');
  const r = res as { messages?: unknown[]; chats?: unknown[]; count?: number } | undefined;
  if (r && Array.isArray(r.messages)) parts.push(`→ ${r.messages.length} messages`);
  return parts.join(' · ');
}
