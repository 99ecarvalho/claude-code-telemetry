const { prepareTraces, forwardTraces } = require('../../src/traceForwarder')
const { decodeOtlpProtobuf, encodeTraceRequest } = require('../../src/otlpProtobuf')

const str = (key, value) => ({ key, value: { stringValue: value } })

function payload(serviceName, spans) {
  return {
    resourceSpans: [{
      resource: { attributes: [str('service.name', serviceName)] },
      scopeSpans: [{ spans }],
    }],
  }
}

describe('traceForwarder', () => {
  test('drops claude-code spans', () => {
    expect(prepareTraces(payload('claude-code', [{ traceId: 't0', attributes: [] }]))).toBeNull()
  })

  test('maps conversation id and user to langfuse attributes across batches', () => {
    // child chat span arrives before its invoke_agent root
    const child = { traceId: 't1', name: 'chat gpt-4o', attributes: [] }
    prepareTraces(payload('copilot-chat', [child]))
    expect(child.attributes.find((a) => a.key === 'langfuse.session.id')).toBeUndefined()

    const root = {
      traceId: 't1',
      name: 'invoke_agent GitHub Copilot Chat',
      attributes: [str('gen_ai.conversation.id', 'conv-1'), str('user.name', 'octocat')],
    }
    const later = { traceId: 't1', name: 'execute_tool readFile' }
    const result = prepareTraces(payload('copilot-chat', [root, later]))

    expect(result.spanCount).toBe(2)
    for (const span of [root, later]) {
      expect(span.attributes).toEqual(expect.arrayContaining([
        str('langfuse.session.id', 'conv-1'),
        str('langfuse.user.id', 'octocat'),
        { key: 'langfuse.trace.tags', value: { arrayValue: { values: [{ stringValue: 'copilot-chat' }] } } },
      ]))
    }
  })

  test('forwardTraces returns null without Langfuse credentials', () => {
    expect(forwardTraces(payload('copilot-chat', [{ traceId: 't2' }]), false, {})).toBeNull()
  })

  test('forwardTraces posts protobuf to the Langfuse OTLP endpoint', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true })
    const config = { publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://langfuse:3000' }
    const traceId = Buffer.alloc(16, 1).toString('base64')
    const spanId = Buffer.alloc(8, 2).toString('base64')

    const count = await forwardTraces(
      payload('copilot-chat', [{ traceId, spanId, name: 'chat', startTimeUnixNano: '1', endTimeUnixNano: '2' }]),
      true,
      config,
    )

    expect(count).toBe(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://langfuse:3000/api/public/otel/v1/traces')
    expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`)
    expect(options.headers['Content-Type']).toBe('application/x-protobuf')
    const sent = decodeOtlpProtobuf('/v1/traces', options.body)
    expect(sent.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({ traceId, spanId, name: 'chat' })
    fetchMock.mockRestore()
  })

  test('encodeTraceRequest round-trips through decode', () => {
    const traceId = Buffer.alloc(16, 3).toString('base64')
    const data = payload('copilot-chat', [{ traceId, name: 'x', attributes: [str('a', 'b')] }])
    const decoded = decodeOtlpProtobuf('/v1/traces', encodeTraceRequest(data))
    expect(decoded.resourceSpans[0].scopeSpans[0].spans[0]).toMatchObject({ traceId, name: 'x' })
  })
})
