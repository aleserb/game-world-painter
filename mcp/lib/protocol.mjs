// The Model Context Protocol (JSON-RPC 2.0) for any transport, written against the specification without
// dependencies. Dual-era: a client that opens with `initialize` gets the legacy handshake (2024-11-05 … 2025-11-25);
// a request that carries `_meta["io.modelcontextprotocol/protocolVersion"]` is served statelessly as the modern
// revision (2026-07-28), which also has `server/discover`.

import { fileURLToPath } from 'node:url';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';

export const ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

/**
 * A protocol endpoint for one connection (a stdio process, or one HTTP session / stateless request stream).
 * options: {serverInfo, instructions, tools, resources, callTool(name, args, ctx) -> {content, isError}, onClient(info),
 * send(message): the transport, for requests to the client (roots/list); without it the server asks nothing}.
 * ctx of callTool: {client, signal, roots(): the client's workspace folders as paths (legacy clients with roots)}.
 */
export class McpEndpoint {
  constructor(options) {
    this.o = options;
    this.legacyVersion = null; // after initialize
    this.clientInfo = null;
    this.pending = new Map(); // request id -> AbortController (notifications/cancelled)
    this.clientCapabilities = {};
    this.outgoing = new Map(); // id of a request to the client -> {resolve, reject, timer}
    this.nextOut = 1;
    this.roots = null; // cached until notifications/roots/list_changed
  }

  /** Sends a request to the client (only over a transport that can: stdio). */
  request(method, params, ms = 5000) {
    if (!this.o.send) return Promise.reject(new Error('This transport cannot send requests to the client'));
    const id = `gwp-${this.nextOut++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.outgoing.delete(id); reject(new Error(`${method}: no answer from the client`)); }, ms);
      this.outgoing.set(id, { resolve, reject, timer });
      this.o.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  /** The client's workspace folders as paths (file:// roots), or [] when it has none or cannot tell. */
  async listRoots() {
    if (!this.o.send || !this.legacyVersion || !this.clientCapabilities.roots) return [];
    if (this.roots) return this.roots;
    try {
      const r = await this.request('roots/list');
      this.roots = (r?.roots || []).filter(x => typeof x.uri === 'string' && x.uri.startsWith('file:')).map(x => {
        try { return fileURLToPath(x.uri); } catch { return null; }
      }).filter(Boolean);
    } catch {
      this.roots = [];
    }
    return this.roots;
  }

  /** Handles a parsed message (or a batch). Returns the response (object, array) or null for notifications. */
  async handle(message) {
    if (Array.isArray(message)) { // JSON-RPC batches (2025-03-26)
      if (!message.length) return error(null, ERR.INVALID_REQUEST, 'Empty batch');
      const out = (await Promise.all(message.map(m => this.handleOne(m)))).filter(Boolean);
      return out.length ? out : null;
    }
    return this.handleOne(message);
  }

  async handleOne(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return error(msg?.id ?? null, ERR.INVALID_REQUEST, 'Not a JSON-RPC 2.0 message');
    const isRequest = 'id' in msg && msg.id !== null && typeof msg.method === 'string';
    if (!('method' in msg)) { // a response to a request of this server (roots/list)
      const out = this.outgoing.get(msg.id);
      if (out) {
        this.outgoing.delete(msg.id);
        clearTimeout(out.timer);
        if (msg.error) out.reject(new Error(msg.error.message || 'error')); else out.resolve(msg.result);
      }
      return null;
    }
    try {
      const result = await this.dispatch(msg, isRequest);
      return isRequest ? { jsonrpc: '2.0', id: msg.id, result } : null;
    } catch (e) {
      if (!isRequest) return null;
      if (e instanceof RpcError) return error(msg.id, e.code, e.message, e.data);
      return error(msg.id, ERR.INTERNAL, e?.message || String(e));
    }
  }

  /** The protocol version of a request: modern from its _meta, else the legacy one of this connection. */
  versionOf(params) {
    const v = params?._meta?.[META_VERSION];
    if (v == null) return { modern: false, version: this.legacyVersion || '2025-03-26' };
    if (!MODERN_VERSIONS.includes(v)) {
      throw new RpcError(ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: v });
    }
    const info = params._meta[META_CLIENT];
    if (info && !this.clientInfo) { this.clientInfo = info; this.o.onClient?.(info); }
    return { modern: true, version: v };
  }

  async dispatch(msg, isRequest) {
    const { method } = msg, params = msg.params || {};
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        this.legacyVersion = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
        this.clientInfo = params.clientInfo || { name: 'unknown client' };
        this.clientCapabilities = params.capabilities || {};
        this.o.onClient?.(this.clientInfo);
        return {
          protocolVersion: this.legacyVersion,
          capabilities: this.capabilities(),
          serverInfo: this.o.serverInfo,
          instructions: this.o.instructions,
        };
      }
      case 'notifications/initialized':
        return null;
      case 'notifications/roots/list_changed':
        this.roots = null;
        return null;
      case 'notifications/cancelled': {
        this.pending.get(params.requestId)?.abort(params.reason || 'cancelled');
        return null;
      }
      case 'ping':
        return {};
      case 'server/discover':
        this.versionOf(params);
        return {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: this.capabilities(),
          _meta: { 'io.modelcontextprotocol/serverInfo': this.o.serverInfo },
          instructions: this.o.instructions,
        };
      case 'tools/list':
        this.versionOf(params);
        return { resultType: 'complete', tools: this.o.tools };
      case 'tools/call': {
        this.versionOf(params);
        const name = params.name;
        if (typeof name !== 'string' || !this.o.tools.some(t => t.name === name)) {
          throw new RpcError(ERR.INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        const args = params.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(ERR.INVALID_PARAMS, 'arguments must be an object');
        const ac = new AbortController();
        if (isRequest) this.pending.set(msg.id, ac);
        try {
          const r = await this.o.callTool(name, args, { client: this.clientInfo, signal: ac.signal, roots: () => this.listRoots() });
          return { resultType: 'complete', ...r };
        } finally {
          this.pending.delete(msg.id);
        }
      }
      case 'resources/list':
        this.versionOf(params);
        return { resultType: 'complete', resources: (this.o.resources || []).map(({ read, ...r }) => r) };
      case 'resources/templates/list':
        this.versionOf(params);
        return { resultType: 'complete', resourceTemplates: [] };
      case 'resources/read': {
        this.versionOf(params);
        const r = (this.o.resources || []).find(x => x.uri === params.uri);
        if (!r) throw new RpcError(-32002, `Resource not found: ${params.uri}`);
        return { resultType: 'complete', contents: [{ uri: r.uri, mimeType: r.mimeType, text: await r.read() }] };
      }
      case 'prompts/list':
        this.versionOf(params);
        return { resultType: 'complete', prompts: [] };
      case 'logging/setLevel':
        return {};
      default:
        if (!isRequest) return null; // unknown notifications are ignored
        throw new RpcError(ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  capabilities() {
    return { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } };
  }
}

export function error(id, code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id, error: e };
}

/** A tool result from what the app returned: {text?, data?, images?: [{data, mimeType}]}. */
export function toolResult(r) {
  const content = [];
  if (r.text) content.push({ type: 'text', text: r.text });
  if (r.data !== undefined) content.push({ type: 'text', text: JSON.stringify(r.data) });
  for (const img of r.images || []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' });
  if (!content.length) content.push({ type: 'text', text: 'Done.' });
  return { content, isError: false };
}

export function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
