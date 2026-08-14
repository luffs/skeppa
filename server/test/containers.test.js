import { test, expect } from 'bun:test'
import { createLogDemuxer, createContainerClient } from '../src/containers/client.js'

// --- log demuxer ------------------------------------------------------------

// Docker mux frame: [streamType, 0, 0, 0, sizeBE32] + payload
function frame(streamType, text) {
  const payload = new TextEncoder().encode(text)
  const buf = new Uint8Array(8 + payload.length)
  buf[0] = streamType
  new DataView(buf.buffer).setUint32(4, payload.length)
  buf.set(payload, 8)
  return buf
}

function concat(...bufs) {
  const total = bufs.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const b of bufs) {
    out.set(b, off)
    off += b.length
  }
  return out
}

test('demuxer emits whole lines from stdout and stderr frames', () => {
  const lines = []
  const demux = createLogDemuxer(l => lines.push(l))
  demux.push(concat(frame(1, 'building...\n'), frame(2, 'a warning\n')))
  demux.flush()
  expect(lines).toEqual(['building...', 'a warning'])
})

test('demuxer survives frames split across arbitrary chunk boundaries', () => {
  const lines = []
  const demux = createLogDemuxer(l => lines.push(l))
  const whole = concat(frame(1, 'first line\nsec'), frame(1, 'ond line\n'))
  // feed one byte at a time — headers and payloads split everywhere
  for (let i = 0; i < whole.length; i++) demux.push(whole.subarray(i, i + 1))
  demux.flush()
  expect(lines).toEqual(['first line', 'second line'])
})

test('demuxer handles multibyte characters split across frames', () => {
  const lines = []
  const demux = createLogDemuxer(l => lines.push(l))
  const bytes = new TextEncoder().encode('på svenska\n')
  // split inside the two-byte "å"
  const head = frame(1, '')
  const f1 = concat(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 3]), bytes.subarray(0, 3))
  const f2 = new Uint8Array(8 + (bytes.length - 3))
  f2[0] = 1
  new DataView(f2.buffer).setUint32(4, bytes.length - 3)
  f2.set(bytes.subarray(3), 8)
  demux.push(concat(head, f1, f2))
  demux.flush()
  expect(lines).toEqual(['på svenska'])
})

test('demuxer strips carriage returns and flushes a trailing unterminated line', () => {
  const lines = []
  const demux = createLogDemuxer(l => lines.push(l))
  demux.push(frame(1, 'done\r\nno newline at end'))
  demux.flush()
  expect(lines).toEqual(['done', 'no newline at end'])
})

// --- REST client ------------------------------------------------------------

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('createContainer posts the spec as JSON and returns the id', async () => {
  const calls = []
  const client = createContainerClient({
    socketPath: '/tmp/podman.sock',
    fetchFn: async (url, init) => {
      calls.push({ url, init })
      return json(201, { Id: 'abc123' })
    },
  })
  const id = await client.createContainer('skeppa-build-app', { Image: 'oven/bun', Env: ['TOKEN=sekret'] })
  expect(id).toBe('abc123')
  expect(calls[0].url).toBe('http://engine/containers/create?name=skeppa-build-app')
  expect(calls[0].init.unix).toBe('/tmp/podman.sock')
  expect(JSON.parse(calls[0].init.body).Env).toEqual(['TOKEN=sekret'])
})

test('API errors carry the status and the engine message', async () => {
  const client = createContainerClient({
    socketPath: '/tmp/podman.sock',
    fetchFn: async () => json(404, { message: 'no such image' }),
  })
  try {
    await client.createContainer('x', {})
    throw new Error('should have thrown')
  } catch (err) {
    expect(err.status).toBe(404)
    expect(err.message).toContain('no such image')
  }
})

test('waitContainer returns the exit code', async () => {
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async () => json(200, { StatusCode: 3 }),
  })
  expect(await client.waitContainer('abc')).toBe(3)
})

test('streamLogs demuxes a streamed body into lines', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(frame(1, 'hello\n'))
      controller.enqueue(frame(2, 'oops\n'))
      controller.close()
    },
  })
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async () => new Response(body, { status: 200 }),
  })
  const lines = []
  await client.streamLogs('abc', l => lines.push(l))
  expect(lines).toEqual(['hello', 'oops'])
})

test('stopContainer treats 304 (already stopped) as success', async () => {
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async () => new Response('', { status: 304 }),
  })
  await client.stopContainer('abc') // must not throw
})

test('inspectContainer returns null for a missing container', async () => {
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async () => json(404, { message: 'no such container' }),
  })
  expect(await client.inspectContainer('ghost')).toBeNull()
})

test('tailLogs splits stdout and stderr into separate texts', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(frame(1, 'out 1\nout 2\n'))
      controller.enqueue(frame(2, 'err 1\n'))
      controller.close()
    },
  })
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async () => new Response(body, { status: 200 }),
  })
  const { out, err } = await client.tailLogs('abc', 100)
  expect(out).toBe('out 1\nout 2')
  expect(err).toBe('err 1')
})

test('buildImage posts the tar context and re-emits stream fragments as whole lines', async () => {
  const enc = new TextEncoder()
  const calls = []
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('{"stream":"Step 1/2 : FROM oven/bun\\n"}\n'))
      controller.enqueue(enc.encode('{"stream":"partial"}\n{"stream":" line\\n"}\n'))
      controller.enqueue(enc.encode('{"aux":{"ID":"sha256:abc"}}\n'))
      controller.close()
    },
  })
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async (url, init) => {
      calls.push({ url, init })
      return new Response(body, { status: 200 })
    },
  })
  const lines = []
  const tar = new Uint8Array([1, 2, 3])
  await client.buildImage('localhost/skeppa/bun-node:latest', tar, l => lines.push(l))
  expect(calls[0].url).toContain('/build?t=localhost%2Fskeppa%2Fbun-node%3Alatest')
  expect(calls[0].url).not.toContain('pull=1') // cached bases by default
  expect(calls[0].init.headers['Content-Type']).toBe('application/x-tar')
  expect(calls[0].init.body).toBe(tar)
  expect(lines).toEqual(['Step 1/2 : FROM oven/bun', 'partial line'])
})

test('buildImage with pull refreshes FROM bases from their registries', async () => {
  const calls = []
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async url => {
      calls.push(url)
      return new Response(new ReadableStream({ start: c => c.close() }), { status: 200 })
    },
  })
  await client.buildImage('t', new Uint8Array(0), () => {}, { pull: true })
  expect(calls[0]).toContain('&pull=1')
})

test('buildImage throws when the stream reports an error', async () => {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('{"stream":"Step 1/1 : RUN nope\\n"}\n'))
      controller.enqueue(enc.encode('{"error":"exit code: 127"}\n'))
      controller.close()
    },
  })
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async () => new Response(body, { status: 200 }),
  })
  await expect(client.buildImage('t', new Uint8Array(0))).rejects.toThrow('exit code: 127')
})

test('pullImage surfaces a terminal error line from the progress stream', async () => {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('{"status":"Pulling from library/nope"}\n'))
      controller.enqueue(enc.encode('{"error":"manifest unknown"}'))
      controller.close()
    },
  })
  const client = createContainerClient({
    socketPath: '/s',
    fetchFn: async () => new Response(body, { status: 200 }),
  })
  await expect(client.pullImage('nope:latest')).rejects.toThrow('manifest unknown')
})
