// Minimal container-engine client speaking the Docker-compatible REST API
// over a unix socket. Podman's rootless user socket serves this API, and
// rootless Docker's socket is wire-compatible — the engine is a config value
// (config.containerSocket), not a code dependency. Talking HTTP instead of
// spawning a CLI keeps decrypted ENV values inside request bodies in memory,
// off argv (/proc/*/cmdline) and --env-file temp files.

// Docker multiplexes non-tty container output into frames: an 8-byte header
// [streamType, 0, 0, 0, sizeBE32] followed by `size` payload bytes. Frames
// split arbitrarily across network chunks, payloads split mid-line and
// mid-codepoint. The demuxer reassembles frames and emits whole lines as
// onLine(line, stream) where stream is 1 (stdout) or 2 (stderr).
export function createLogDemuxer(onLine) {
  let pending = new Uint8Array(0)
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() }
  const carry = { 1: '', 2: '' }

  const emitText = (stream, text) => {
    carry[stream] += text
    let i
    while ((i = carry[stream].indexOf('\n')) >= 0) {
      onLine(carry[stream].slice(0, i).replace(/\r$/, ''), stream)
      carry[stream] = carry[stream].slice(i + 1)
    }
  }

  return {
    push(chunk) {
      const merged = new Uint8Array(pending.length + chunk.length)
      merged.set(pending)
      merged.set(chunk, pending.length)
      pending = merged

      while (pending.length >= 8) {
        const size = new DataView(pending.buffer, pending.byteOffset).getUint32(4)
        if (pending.length < 8 + size) break
        const stream = pending[0] === 2 ? 2 : 1 // stdin/other → treat as stdout
        emitText(stream, decoders[stream].decode(pending.subarray(8, 8 + size), { stream: true }))
        pending = pending.subarray(8 + size)
      }
    },
    flush() {
      for (const stream of [1, 2]) {
        carry[stream] += decoders[stream].decode()
        if (carry[stream]) onLine(carry[stream].replace(/\r$/, ''), stream)
        carry[stream] = ''
      }
    },
  }
}

export function createContainerClient({ socketPath, fetchFn = fetch }) {
  async function api(method, path, body = null) {
    const res = await fetchFn(`http://engine${path}`, {
      method,
      unix: socketPath,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.json()).message ?? ''
      } catch {
        // non-JSON error body — the status code has to do
      }
      const err = new Error(`container engine: ${method} ${path} → ${res.status}${detail ? ` (${detail})` : ''}`)
      err.status = res.status
      throw err
    }
    return res
  }

  return {
    socketPath,

    // Returns the new container's id. `name` may be reused after remove.
    async createContainer(name, spec) {
      const res = await api('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec)
      return (await res.json()).Id
    },

    async startContainer(id) {
      await api('POST', `/containers/${encodeURIComponent(id)}/start`)
    },

    // Blocks until the container exits; returns its exit code.
    async waitContainer(id) {
      const res = await api('POST', `/containers/${encodeURIComponent(id)}/wait`)
      return (await res.json()).StatusCode ?? -1
    },

    async killContainer(id) {
      try {
        await api('POST', `/containers/${encodeURIComponent(id)}/kill`)
      } catch {
        // already dead — that is what we wanted
      }
    },

    async restartContainer(id) {
      await api('POST', `/containers/${encodeURIComponent(id)}/restart?t=10`)
    },

    async stopContainer(id) {
      try {
        await api('POST', `/containers/${encodeURIComponent(id)}/stop?t=10`)
      } catch (err) {
        if (err.status !== 304) throw err // 304 = already stopped
      }
    },

    // null when the container does not exist.
    async inspectContainer(id) {
      try {
        const res = await api('GET', `/containers/${encodeURIComponent(id)}/json`)
        return await res.json()
      } catch (err) {
        if (err.status === 404) return null
        throw err
      }
    },

    // One stats sample (no stream) — memory/cpu for the poller.
    async statsContainer(id) {
      const res = await api('GET', `/containers/${encodeURIComponent(id)}/stats?stream=false`)
      return await res.json()
    },

    // Last `lines` lines of each stream, demuxed. Throws with .status = 404
    // when the container does not exist.
    async tailLogs(id, lines) {
      const res = await api('GET', `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${Number(lines)}`)
      const out = []
      const err = []
      const demux = createLogDemuxer((line, stream) => (stream === 2 ? err : out).push(line))
      for await (const chunk of res.body) demux.push(chunk)
      demux.flush()
      return { out: out.join('\n'), err: err.join('\n') }
    },

    // [{ Id, Names, Image, State, Status, Created, Ports, Labels }] for every
    // container, stopped ones included — the Engine room lists them all.
    async listContainers() {
      const res = await api('GET', '/containers/json?all=1')
      return await res.json()
    },

    async removeContainer(id) {
      try {
        await api('DELETE', `/containers/${encodeURIComponent(id)}?force=true&v=true`)
      } catch {
        // not found — fine
      }
    },

    // Streams multiplexed stdout+stderr as whole lines until the container
    // exits (or the stream breaks — callers treat logs as best-effort).
    async streamLogs(id, onLine) {
      const res = await api('GET', `/containers/${encodeURIComponent(id)}/logs?follow=true&stdout=true&stderr=true`)
      const demux = createLogDemuxer(onLine)
      for await (const chunk of res.body) demux.push(chunk)
      demux.flush()
    },

    // Builds an image from an in-memory tar context (see lib/tar.js). Build
    // output arrives as JSON lines whose "stream" values are re-emitted as
    // whole text lines via onLine; a terminal {"error": ...} becomes a throw.
    // pull: refresh FROM bases from their registries instead of using cached
    // copies (the engine's default is pull-if-missing).
    async buildImage(tag, tarBytes, onLine = () => {}, { pull = false } = {}) {
      const res = await fetchFn(`http://engine/build?t=${encodeURIComponent(tag)}&dockerfile=Containerfile${pull ? '&pull=1' : ''}`, {
        method: 'POST',
        unix: socketPath,
        headers: { 'Content-Type': 'application/x-tar' },
        body: tarBytes,
      })
      if (!res.ok) {
        let detail = ''
        try {
          detail = (await res.json()).message ?? ''
        } catch {
          // non-JSON error body
        }
        const err = new Error(`container engine: POST /build → ${res.status}${detail ? ` (${detail})` : ''}`)
        err.status = res.status
        throw err
      }
      const decoder = new TextDecoder()
      let buf = ''
      let carry = '' // "stream" fragments do not align with line breaks
      let buildError = null
      const handle = line => {
        if (!line.trim()) return
        try {
          const msg = JSON.parse(line)
          if (msg.error) buildError = msg.error
          else if (typeof msg.stream === 'string') {
            carry += msg.stream
            let i
            while ((i = carry.indexOf('\n')) >= 0) {
              onLine(carry.slice(0, i).replace(/\r$/, ''))
              carry = carry.slice(i + 1)
            }
          }
        } catch {
          // non-JSON noise between messages — ignore
        }
      }
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          handle(buf.slice(0, i))
          buf = buf.slice(i + 1)
        }
      }
      buf += decoder.decode()
      if (buf.trim()) handle(buf)
      if (carry.trim()) onLine(carry.replace(/\r$/, ''))
      if (buildError) throw new Error(`image build failed: ${buildError}`)
    },

    // [{ Id, RepoTags, Size, Created }] — dangling images have no RepoTags.
    async listImages() {
      const res = await api('GET', '/images/json')
      return await res.json()
    },

    async removeImage(ref) {
      try {
        await api('DELETE', `/images/${encodeURIComponent(ref)}`)
      } catch (err) {
        if (err.status !== 404) throw err
      }
    },

    // Removes dangling (untagged) layers only — the engine's default filter.
    async pruneImages() {
      const res = await api('POST', '/images/prune')
      return await res.json()
    },

    // Pulls an image; progress arrives as a stream of JSON lines. Progress
    // spam is swallowed, a terminal {"error": ...} line becomes a throw.
    async pullImage(ref) {
      const res = await api('POST', `/images/create?fromImage=${encodeURIComponent(ref)}`)
      const decoder = new TextDecoder()
      let buf = ''
      let pullError = null
      const scan = () => {
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            if (msg.error) pullError = msg.error
          } catch {
            // partial or non-JSON progress line — ignore
          }
        }
      }
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true })
        scan()
      }
      buf += decoder.decode()
      buf += '\n'
      scan()
      if (pullError) throw new Error(`image pull failed: ${pullError}`)
    },
  }
}
