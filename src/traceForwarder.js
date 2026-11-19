/**
 * Forwards OTLP traces (e.g. GitHub Copilot GenAI spans) to Langfuse's native OTLP endpoint.
 */

const pino = require('pino')
const { encodeTraceRequest } = require('./otlpProtobuf')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

// Claude Code is ingested from its log events instead; forwarding its spans would duplicate it
const EXCLUDED_SERVICES = (process.env.TRACE_FORWARD_EXCLUDE_SERVICES ?? 'claude-code')
  .split(',').map((s) => s.trim()).filter(Boolean)

const MAX_TRACKED_TRACES = 5000
// traceId -> { sessionId, userId }; child spans are exported before their invoke_agent root
const traceContext = new Map()

function getAttr(attributes, key) {
  return attributes?.find((a) => a.key === key)?.value?.stringValue
}

function setAttr(attributes, key, value) {
  if (value !== undefined && !attributes.some((a) => a.key === key)) {
    attributes.push({ key, value })
  }
}

function rememberTrace(traceId, ctx) {
  if (traceContext.size >= MAX_TRACKED_TRACES) {
    traceContext.delete(traceContext.keys().next().value)
  }
  traceContext.set(traceId, { ...traceContext.get(traceId), ...ctx })
}

/**
 * Drop excluded services and add langfuse.* attributes so Langfuse groups spans
 * into sessions/users. Mutates and returns the payload, or null if nothing is left.
 */
function prepareTraces(payload) {
  const resourceSpans = (payload?.resourceSpans || []).filter(
    (rs) => !EXCLUDED_SERVICES.includes(getAttr(rs.resource?.attributes, 'service.name')),
  )
  if (resourceSpans.length === 0) return null

  const allSpans = []
  for (const rs of resourceSpans) {
    const serviceName = getAttr(rs.resource?.attributes, 'service.name')
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        span.attributes = span.attributes || []
        allSpans.push({ span, serviceName })
        const sessionId = getAttr(span.attributes, 'gen_ai.conversation.id')
        const userId = getAttr(span.attributes, 'user.name')
        if (sessionId || userId) {
          rememberTrace(span.traceId, { ...(sessionId && { sessionId }), ...(userId && { userId }) })
        }
      }
    }
  }
  if (allSpans.length === 0) return null

  for (const { span, serviceName } of allSpans) {
    const ctx = traceContext.get(span.traceId) || {}
    if (ctx.sessionId) setAttr(span.attributes, 'langfuse.session.id', { stringValue: ctx.sessionId })
    if (ctx.userId) setAttr(span.attributes, 'langfuse.user.id', { stringValue: ctx.userId })
    if (serviceName) {
      setAttr(span.attributes, 'langfuse.trace.tags', { arrayValue: { values: [{ stringValue: serviceName }] } })
    }
  }

  return { payload: { resourceSpans }, spanCount: allSpans.length }
}

/**
 * Forward a decoded OTLP trace payload to Langfuse.
 * Returns null when there is nothing to forward, otherwise a promise of the span count.
 */
function forwardTraces(payload, isProtobuf, langfuseConfig) {
  if (!langfuseConfig?.publicKey || !langfuseConfig?.secretKey) return null
  const prepared = prepareTraces(payload)
  if (!prepared) return null

  const auth = Buffer.from(`${langfuseConfig.publicKey}:${langfuseConfig.secretKey}`).toString('base64')
  const body = isProtobuf ? encodeTraceRequest(prepared.payload) : JSON.stringify(prepared.payload)

  return fetch(`${langfuseConfig.baseUrl}/api/public/otel/v1/traces`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': isProtobuf ? 'application/x-protobuf' : 'application/json',
      'x-langfuse-ingestion-version': '4',
    },
    body,
    signal: AbortSignal.timeout(15000),
  }).then(async (res) => {
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new Error(`Langfuse OTLP ingest failed: HTTP ${res.status} ${text}`)
    }
    logger.info({ spans: prepared.spanCount }, 'Forwarded traces to Langfuse')
    return prepared.spanCount
  })
}

module.exports = { forwardTraces, prepareTraces }
