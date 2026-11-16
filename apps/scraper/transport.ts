/** Transport abstraction. A real MTProto client (e.g. gramjs/TDLib) is an external dependency: live use is BLOCKED. */
export interface ChannelMessage { channel: string; id: number; text: string; sender: string; ts: number }
export interface Credentials { apiId: number; apiHash: string }           // supplied by the user; never bundled
export interface TelegramTransport {
  connect(creds: Credentials, session: string | undefined): Promise<{ session: string }>;  // returns session string to persist
  onMessage(cb: (m: ChannelMessage) => void): () => void;
  disconnect(): Promise<void>;
}

/** In-memory fake for tests. Never touches the network. */
export class FakeTransport implements TelegramTransport {
  private subs = new Set<(m: ChannelMessage) => void>();
  connected = false;
  constructor(private issuedSession = 'fake-session-string') {}
  async connect(creds: Credentials, _session?: string) {
    if (!creds.apiId || !creds.apiHash) throw new Error('missing user-supplied API credentials');
    this.connected = true; return { session: this.issuedSession };
  }
  onMessage(cb: (m: ChannelMessage) => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  async disconnect() { this.connected = false; }
  emit(m: ChannelMessage) { for (const s of this.subs) s(m); }
}
