// The fleet protocol: what a master and its agents say to each other over
// /agent — the envelopes (`live`, `rpc`, `ask`/`answer`, `ctl`), the rpc
// METHODS and their params, the `ask` methods, and the shapes of what the
// relay carries. A commit names a checkout; this number names the language,
// so two panels at different commits can tell whether they still understand
// each other.
//
// Bump FLEET_PROTOCOL when a change would leave an older peer misreading
// something (a renamed method or envelope field, a new required param, a
// changed answer shape). A new optional thing an older peer simply ignores
// needs no bump. Raise MIN_FLEET_PROTOCOL only when this panel stops
// speaking an older one.
//
// Each side says both numbers in its hello; they get along while their
// ranges meet. A hello without them is from before the numbers: protocol 1.
export const FLEET_PROTOCOL = 1
export const MIN_FLEET_PROTOCOL = 1

const MAX = 999

// What a hello says, made safe: { protocol, minProtocol }.
export function helloProtocol(msg) {
  const protocol = Number.isInteger(msg?.protocol) && msg.protocol >= 1 && msg.protocol <= MAX ? msg.protocol : 1
  const min = Number.isInteger(msg?.minProtocol) && msg.minProtocol >= 1 && msg.minProtocol <= protocol ? msg.minProtocol : protocol
  return { protocol, minProtocol: min }
}

// Whether a peer speaking [minProtocol, protocol] and this panel overlap.
export function protocolsMeet({ protocol, minProtocol }, ours = { protocol: FLEET_PROTOCOL, minProtocol: MIN_FLEET_PROTOCOL }) {
  return Math.max(minProtocol, ours.minProtocol) <= Math.min(protocol, ours.protocol)
}

// Which side has to move, in words, or '' when they meet.
export function protocolAdvice(peer, ours = { protocol: FLEET_PROTOCOL, minProtocol: MIN_FLEET_PROTOCOL }) {
  if (protocolsMeet(peer, ours)) return ''
  return peer.protocol < ours.minProtocol ? 'peer-older' : 'peer-newer'
}
