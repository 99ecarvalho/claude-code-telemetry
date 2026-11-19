const { LangfuseOtelClient } = require('../../src/langfuseOtelClient')

const config = { publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://langfuse:3000', flushAt: 1000, flushInterval: 60000 }

function sentSpans(fetchMock) {
  return fetchMock.mock.calls
    .filter(([url]) => url.endsWith('/api/public/otel/v1/traces'))
    .flatMap(([, options]) => JSON.parse(options.body).resourceSpans[0].scopeSpans[0].spans)
}

const attrsOf = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]))

describe('LangfuseOtelClient', () => {
  let fetchMock
  let client

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => '' })
    client = new LangfuseOtelClient(config)
  })

  afterEach(async () => {
    await client.shutdownAsync()
    fetchMock.mockRestore()
  })

  test('exports a generation with usage, cost and propagated trace attributes', async () => {
    const trace = client.trace({ name: 'conversation-1', sessionId: 's1', userId: 'u1', input: { prompt: 'hi' } })
    client.generation({
      traceId: trace.id,
      name: 'generation-claude',
      model: 'claude-opus',
      startTime: new Date(1000),
      endTime: new Date(2000),
      usageDetails: { input: 1, output: 2 },
      costDetails: { total: 0.5 },
      metadata: { requestId: 'r1' },
    })
    await client.flushAsync()

    const [gen] = sentSpans(fetchMock)
    const attrs = attrsOf(gen)
    expect(gen.traceId).toBe(trace.id)
    expect(gen.startTimeUnixNano).toBe('1000000000')
    expect(gen.endTimeUnixNano).toBe('2000000000')
    expect(attrs['langfuse.observation.type']).toBe('generation')
    expect(attrs['langfuse.observation.model.name']).toBe('claude-opus')
    expect(JSON.parse(attrs['langfuse.observation.usage_details'])).toEqual({ input: 1, output: 2 })
    expect(JSON.parse(attrs['langfuse.observation.cost_details'])).toEqual({ total: 0.5 })
    expect(attrs['langfuse.observation.metadata.requestId']).toBe('r1')
    expect(attrs['langfuse.session.id']).toBe('s1')
    expect(attrs['langfuse.user.id']).toBe('u1')
    expect(fetchMock.mock.calls[0][1].headers['x-langfuse-ingestion-version']).toBe('4')
  })

  test('holds the root span until update and spans it over its children', async () => {
    const trace = client.trace({ name: 'conversation-1', sessionId: 's1', input: { prompt: 'hi' }, timestamp: new Date(2000) })
    client.generation({ traceId: trace.id, startTime: new Date(1000), endTime: new Date(5000) })
    await client.flushAsync()
    expect(sentSpans(fetchMock).some((s) => s.spanId && !s.parentSpanId)).toBe(false)

    trace.update({ output: { status: 'done' } })
    trace.update({ output: { status: 'again' } })
    await client.flushAsync()

    const roots = sentSpans(fetchMock).filter((s) => !s.parentSpanId)
    expect(roots).toHaveLength(1)
    const attrs = attrsOf(roots[0])
    expect(roots[0].startTimeUnixNano).toBe('1000000000')
    expect(roots[0].endTimeUnixNano).toBe('5000000000')
    expect(attrs['langfuse.observation.type']).toBe('agent')
    expect(JSON.parse(attrs['langfuse.observation.input'])).toEqual({ prompt: 'hi' })
    expect(JSON.parse(attrs['langfuse.observation.output'])).toEqual({ status: 'done' })
  })

  test('a new trace closes the previous open trace of the same session', async () => {
    const first = client.trace({ name: 'conversation-1', sessionId: 's1' })
    client.trace({ name: 'conversation-2', sessionId: 's1' })
    await client.flushAsync()

    const roots = sentSpans(fetchMock).filter((s) => !s.parentSpanId)
    expect(roots.map((r) => r.traceId)).toEqual([first.id])
  })

  test('tool events become zero-duration tool observations under their parent', async () => {
    const trace = client.trace({ sessionId: 's1' })
    const gen = client.generation({ traceId: trace.id })
    client.event({ traceId: trace.id, parentObservationId: gen.id, name: 'tool-Bash', startTime: new Date(3000), level: 'WARNING' })
    await client.flushAsync()

    const tool = sentSpans(fetchMock).find((s) => s.name === 'tool-Bash')
    expect(tool.parentSpanId).toBe(gen.id)
    expect(tool.startTimeUnixNano).toBe(tool.endTimeUnixNano)
    expect(attrsOf(tool)['langfuse.observation.type']).toBe('tool')
  })

  test('posts scores after spans', async () => {
    const trace = client.trace({ name: 'session-summary', output: {} })
    client.score({ traceId: trace.id, name: 'quality', value: 80 })
    await client.flushAsync()

    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toEqual(['http://langfuse:3000/api/public/otel/v1/traces', 'http://langfuse:3000/api/public/scores'])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ traceId: trace.id, name: 'quality', value: 80 })
  })

  test('re-queues spans when the export fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    const onError = jest.fn()
    client.on('error', onError)
    client.event({ name: 'e' })

    await client.flushAsync()
    expect(onError).toHaveBeenCalled()

    await client.flushAsync()
    expect(sentSpans(fetchMock).filter((s) => s.name === 'e')).toHaveLength(2)
  })
})
