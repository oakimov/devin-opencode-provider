/**
 * Minimal protobuf wire helpers for Windsurf/Devin Connect-RPC.
 * Mirrors devin_mock chat_decode / proto_util and rsvedant cloud-direct wire.ts
 * but pure TS, no protobufjs dependency for MVP.
 */

export function encodeVarint(value: number | bigint): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(value)
  const out: number[] = []
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return Uint8Array.from(out)
}

export function encodeTag(fieldNum: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNum << 3) | wireType)
}

export function encodeString(fieldNum: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  const tag = encodeTag(fieldNum, 2)
  const len = encodeVarint(bytes.length)
  const out = new Uint8Array(tag.length + len.length + bytes.length)
  out.set(tag, 0)
  out.set(len, tag.length)
  out.set(bytes, tag.length + len.length)
  return out
}

export function encodeBytes(fieldNum: number, value: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNum, 2)
  const len = encodeVarint(value.length)
  const out = new Uint8Array(tag.length + len.length + value.length)
  out.set(tag, 0)
  out.set(len, tag.length)
  out.set(value, tag.length + len.length)
  return out
}

export function encodeVarintField(fieldNum: number, value: number | bigint): Uint8Array {
  const tag = encodeTag(fieldNum, 0)
  const val = encodeVarint(value)
  const out = new Uint8Array(tag.length + val.length)
  out.set(tag, 0)
  out.set(val, tag.length)
  return out
}

export function encodeMessage(fieldNum: number, inner: Uint8Array): Uint8Array {
  return encodeBytes(fieldNum, inner)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Connect streaming envelope: 1 byte flags + 4 byte BE length + payload */
export function frameEnvelope(payload: Uint8Array, flags = 0x00): Uint8Array {
  const header = new Uint8Array(5)
  header[0] = flags
  new DataView(header.buffer).setUint32(1, payload.length, false)
  return concat(header, payload)
}

export function frameEndStream(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  // flags 0x02 = end stream
  return frameEnvelope(payload, 0x02)
}

/** Iter top-level fields from a raw proto bytes */
export type ProtoField = { num: number; wire: number; value: Uint8Array | bigint | number }

export function iterFields(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let pos = 0
  while (pos < buf.length) {
    const tagResult = readVarint(buf, pos)
    if (!tagResult) break
    const [tag, nextPos] = tagResult
    pos = nextPos
    const num = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      const r = readVarint(buf, pos)
      if (!r) break
      fields.push({ num, wire, value: r[0] })
      pos = r[1]
    } else if (wire === 1) {
      if (pos + 8 > buf.length) break
      fields.push({ num, wire, value: buf.slice(pos, pos + 8) })
      pos += 8
    } else if (wire === 2) {
      const r = readVarint(buf, pos)
      if (!r) break
      const len = Number(r[0])
      pos = r[1]
      if (pos + len > buf.length) break
      fields.push({ num, wire, value: buf.slice(pos, pos + len) })
      pos += len
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break
      fields.push({ num, wire, value: buf.slice(pos, pos + 4) })
      pos += 4
    } else {
      break
    }
  }
  return fields
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] | null {
  let result = 0n
  let shift = 0n
  for (let i = pos; i < buf.length && i < pos + 10; i++) {
    const b = BigInt(buf[i])
    result |= (b & 0x7fn) << shift
    if ((b & 0x80n) === 0n) return [result, i + 1]
    shift += 7n
  }
  return null
}

/** Parse Connect frames from a concatenated buffer */
export function parseConnectFrames(buf: Uint8Array): Array<{ flags: number; payload: Uint8Array }> {
  const frames: Array<{ flags: number; payload: Uint8Array }> = []
  let pos = 0
  while (pos + 5 <= buf.length) {
    const flags = buf[pos]
    const len = new DataView(buf.buffer, buf.byteOffset + pos + 1, 4).getUint32(0, false)
    if (pos + 5 + len > buf.length) break
    frames.push({ flags, payload: buf.slice(pos + 5, pos + 5 + len) })
    pos += 5 + len
  }
  return frames
}

/** Convenience: decode GetUserJwtResponse field 1 as string */
export function decodeUserJwtResponse(buf: Uint8Array): string | null {
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2 && f.value instanceof Uint8Array) {
      return new TextDecoder().decode(f.value)
    }
  }
  return null
}
