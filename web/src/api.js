import { noteServerDate } from './store.js'

async function request(method, url, body) {
  const sentAt = Date.now()
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })
  // every answer carries the server's clock: how far off this browser's is
  noteServerDate(res.headers?.get?.('date'), sentAt)
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    api.onUnauthorized?.()
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`)
    err.status = res.status
    err.fields = data?.fields
    err.blockers = data?.blockers
    throw err
  }
  return data
}

export const api = {
  onUnauthorized: null,
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: url => request('DELETE', url),
}
