/**
 * Minimal Langfuse client that exports observations as OTLP spans (Langfuse v4 ingestion).
 *
 * Mirrors the subset of the legacy `langfuse` SDK used by SessionHandler: trace(), generation(),
 * event(), score(), flushAsync(), shutdownAsync(). Child observations are exported as soon as they
 * are created; a trace's root span is held until the trace is updated, a new trace starts for the
 * same session, it goes idle, or the client shuts down, because v4 needs each span exported once.
 */

const crypto = require('crypto')
const { EventEmitter } = require('events')
const pino = require('pino')
const { sendOtlpTraces } = require('./traceForwarder')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

const SERVICE_NAME = 'claude-code'
const SCOPE_NAME = 'claude-code-telemetry'
const MAX_QUEUED_SPANS = 10000
const STATUS_ERROR = 2

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex')
const toMs = (value) => new Date(value ?? Date.now()).getTime()
const toNanos = (ms) => (BigInt(Math.round(ms)) * 1000000n).toString()
const toJson = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

function otlpAttr(key, value) {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) {
    return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } }
  }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (typeof value === 'number') {
    return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }
  }
  if (typeof value === 'object') return { key, value: { stringValue: JSON.stringify(value) } }
  return { key, value: { stringValue: String(value) } }
}

function metadataAttrs(prefix, metadata) {
  return Object.entries(metadata || {}).map(([k, v]) => otlpAttr(`${prefix}.${k}`, v))
}

class LangfuseOtelClient extends EventEmitter {
  constructor({ publicKey, secretKey, baseUrl, flushAt = 20, flushInterval = 10000, rootIdleMs = 5 * 60 * 1000 }) {
    super()
    this.config = { publicKey, secretKey, baseUrl }
    this.flushAt = flushAt
    this.rootIdleMs = rootIdleMs
    this.traces = new Map()
    this.spanQueue = []
    this.scoreQueue = []
    this.flushing = null
    this.timer = setInterval(() => {
      this.closeIdleRoots()
      this.flush()
    }, flushInterval)
    this.timer.unref()
  }

  traceAttrs(ctx) {
    if (!ctx) return []
    return [
      otlpAttr('langfuse.trace.name', ctx.name),
      otlpAttr('langfuse.session.id', ctx.sessionId),
      otlpAttr('langfuse.user.id', ctx.userId),
      otlpAttr('langfuse.trace.tags', ctx.tags),
    ]
  }

  trace(params = {}) {
    if (params.sessionId) {
      for (const open of this.traces.values()) {
        if (!open.closed && open.sessionId === params.sessionId) this.closeRoot(open)
      }
    }
    const startMs = toMs(params.timestamp)
    const ctx = {
      ...params,
      tags: params.tags || [SERVICE_NAME],
      traceId: randomHex(16),
      rootSpanId: randomHex(8),
      startMs,
      endMs: startMs,
      lastActivity: Date.now(),
      closed: false,
    }
    this.traces.set(ctx.traceId, ctx)
    if (params.output !== undefined) this.closeRoot(ctx)

    return {
      id: ctx.traceId,
      update: (update = {}) => {
        if (ctx.closed) {
          logger.debug({ traceId: ctx.traceId }, 'Ignoring update of an exported trace')
          return
        }
        Object.assign(ctx, update)
        this.closeRoot(ctx)
      },
    }
  }

  generation(params) {
    return this.observation('generation', params)
  }

  span(params) {
    return this.observation('span', params)
  }

  event(params) {
    const type = params.name?.startsWith('tool-') ? 'tool' : 'event'
    return this.observation(type, { ...params, endTime: params.endTime || params.startTime })
  }

  observation(type, params = {}) {
    const ctx = this.traces.get(params.traceId)
    const spanId = randomHex(8)
    const startMs = toMs(params.startTime)
    const endMs = Math.max(startMs, toMs(params.endTime ?? params.startTime))
    if (ctx) {
      ctx.startMs = Math.min(ctx.startMs, startMs)
      ctx.endMs = Math.max(ctx.endMs, endMs)
      ctx.lastActivity = Date.now()
    }

    const attributes = [
      otlpAttr('langfuse.observation.type', type),
      otlpAttr('langfuse.observation.input', params.input === undefined ? undefined : toJson(params.input)),
      otlpAttr('langfuse.observation.output', params.output === undefined ? undefined : toJson(params.output)),
      otlpAttr('langfuse.observation.level', params.level),
      otlpAttr('langfuse.observation.status_message', params.statusMessage),
      otlpAttr('langfuse.observation.model.name', params.model),
      otlpAttr('langfuse.observation.usage_details', params.usageDetails && toJson(params.usageDetails)),
      otlpAttr('langfuse.observation.cost_details', params.costDetails && toJson(params.costDetails)),
      otlpAttr('langfuse.version', params.version ?? ctx?.version),
      ...metadataAttrs('langfuse.observation.metadata', params.metadata),
      ...this.traceAttrs(ctx),
    ]

    this.enqueue({
      traceId: ctx?.traceId || params.traceId || randomHex(16),
      spanId,
      parentSpanId: params.parentObservationId || ctx?.rootSpanId,
      name: params.name || type,
      startMs,
      endMs,
      attributes,
      isError: params.level === 'ERROR',
    })

    // Spans are immutable once exported in v4; end/update are accepted for API compatibility only
    return { id: spanId, end: () => {}, update: () => {} }
  }

  closeRoot(ctx) {
    ctx.closed = true
    ctx.lastActivity = Date.now()
    const attributes = [
      otlpAttr('langfuse.observation.type', ctx.type || 'agent'),
      otlpAttr('langfuse.observation.input', ctx.input === undefined ? undefined : toJson(ctx.input)),
      otlpAttr('langfuse.observation.output', ctx.output === undefined ? undefined : toJson(ctx.output)),
      otlpAttr('langfuse.version', ctx.version),
      ...metadataAttrs('langfuse.trace.metadata', ctx.metadata),
      ...this.traceAttrs(ctx),
    ]
    this.enqueue({
      traceId: ctx.traceId,
      spanId: ctx.rootSpanId,
      name: ctx.name || 'trace',
      startMs: ctx.startMs,
      endMs: Math.max(ctx.endMs, ctx.startMs),
      attributes,
    })
  }

  closeIdleRoots(now = Date.now()) {
    for (const [traceId, ctx] of this.traces) {
      if (!ctx.closed && now - ctx.lastActivity > this.rootIdleMs) this.closeRoot(ctx)
      // keep closed traces around so late child observations still get trace attributes
      if (ctx.closed && now - ctx.lastActivity > this.rootIdleMs * 2) this.traces.delete(traceId)
    }
  }

  score(params) {
    this.scoreQueue.push(params)
  }

  enqueue(span) {
    this.spanQueue.push(span)
    if (this.spanQueue.length > MAX_QUEUED_SPANS) this.spanQueue.splice(0, this.spanQueue.length - MAX_QUEUED_SPANS)
    if (this.spanQueue.length >= this.flushAt) this.flush()
  }

  toOtlp(spans) {
    return {
      resourceSpans: [{
        resource: { attributes: [otlpAttr('service.name', SERVICE_NAME)] },
        scopeSpans: [{
          scope: { name: SCOPE_NAME },
          spans: spans.map((s) => ({
            traceId: s.traceId,
            spanId: s.spanId,
            ...(s.parentSpanId && { parentSpanId: s.parentSpanId }),
            name: s.name,
            kind: 1,
            startTimeUnixNano: toNanos(s.startMs),
            endTimeUnixNano: toNanos(s.endMs),
            attributes: s.attributes.filter(Boolean),
            status: s.isError ? { code: STATUS_ERROR } : {},
          })),
        }],
      }],
    }
  }

  flush() {
    if (this.flushing) return this.flushing
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  async doFlush() {
    if (!this.config.publicKey || !this.config.secretKey) return
    // scores reference traces, so send spans first
    const spans = this.spanQueue.splice(0)
    if (spans.length > 0) {
      try {
        await sendOtlpTraces(this.config, JSON.stringify(this.toOtlp(spans)), false)
        logger.debug({ spans: spans.length }, 'Exported spans to Langfuse')
      } catch (error) {
        this.spanQueue.unshift(...spans)
        this.reportError(error)
        return
      }
    }

    const scores = this.scoreQueue.splice(0)
    for (const [i, score] of scores.entries()) {
      try {
        await this.postScore(score)
      } catch (error) {
        this.scoreQueue.unshift(...scores.slice(i))
        this.reportError(error)
        return
      }
    }
  }

  reportError(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error)
    else logger.error({ error: error.message }, 'Langfuse export failed')
  }

  async postScore(score) {
    const auth = Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString('base64')
    const res = await fetch(`${this.config.baseUrl}/api/public/scores`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(score),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      throw new Error(`Langfuse score failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
  }

  async flushAsync() {
    await this.flush()
    // a flush may have been in progress when new spans were queued
    if (this.spanQueue.length > 0 || this.scoreQueue.length > 0) await this.flush()
  }

  async shutdownAsync() {
    clearInterval(this.timer)
    for (const ctx of this.traces.values()) {
      if (!ctx.closed) this.closeRoot(ctx)
    }
    await this.flushAsync()
  }
}

module.exports = { LangfuseOtelClient }
