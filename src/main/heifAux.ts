import { open } from 'node:fs/promises'

/** Minimal ISO-BMFF / HEIF reader that finds a photo's auxiliary images (depth map, portrait matte). */

export interface AuxImage {
  type: 'depth' | 'matte'
  width: number
  height: number
  /** HEVC Annex-B bitstream (parameter sets + slice data), decodable with `ffmpeg -f hevc`. */
  annexB: Buffer
}

export interface HeifAux {
  /** Counter-clockwise quarter turns and mirror axis applied to the primary image (irot / imir). */
  rotation: number
  mirror?: 'h' | 'v'
  aux: AuxImage[]
}

interface Box { type: string; start: number; end: number; body: number }

function boxes(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = []
  let p = start
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    let body = p + 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); body = p + 16 }
    else if (size === 0) size = end - p
    if (size < 8 || p + size > end) break
    out.push({ type, start: p, end: p + size, body })
    p += size
  }
  return out
}

/** `full`: the parent is a FullBox, so its children start after the version/flags word. */
const child = (buf: Buffer, b: Box, type: string, full = false): Box | undefined =>
  boxes(buf, b.body + (full ? 4 : 0), b.end).find((c) => c.type === type)

const readN = (buf: Buffer, o: number, n: number): number =>
  n === 0 ? 0 : n === 2 ? buf.readUInt16BE(o) : n === 4 ? buf.readUInt32BE(o) : Number(buf.readBigUInt64BE(o))

const AUX_TYPES: Record<string, AuxImage['type']> = {
  'urn:mpeg:hevc:2015:auxid:2': 'depth',
  'urn:mpeg:mpegB:cicp:systems:auxiliary:depth': 'depth',
  'urn:com:apple:photo:2018:aux:portraiteffectsmatte': 'matte'
}

/** Reads only the `meta` box and the aux items' bytes, so it stays cheap on 3 MB HEICs. */
export async function readHeifAux(path: string): Promise<HeifAux | null> {
  const fh = await open(path, 'r')
  try {
    const head = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    const top = boxes(head, 0, bytesRead)
    let metaBox = top.find((b) => b.type === 'meta')
    let buf = head
    if (!metaBox) {
      // meta can follow a large box; walk headers until found
      let p = 0
      const hdr = Buffer.alloc(16)
      for (let i = 0; i < 16; i++) {
        const r = await fh.read(hdr, 0, 16, p)
        if (r.bytesRead < 8) return null
        let size = hdr.readUInt32BE(0)
        if (size === 1) size = Number(hdr.readBigUInt64BE(8))
        if (hdr.toString('latin1', 4, 8) === 'meta') {
          buf = Buffer.alloc(size)
          await fh.read(buf, 0, size, p)
          metaBox = { type: 'meta', start: 0, end: size, body: 8 }
          break
        }
        if (size < 8) return null
        p += size
      }
      if (!metaBox) return null
    } else if (metaBox.end > bytesRead) {
      buf = Buffer.alloc(metaBox.end - metaBox.start)
      await fh.read(buf, 0, buf.length, metaBox.start)
      metaBox = { type: 'meta', start: 0, end: buf.length, body: 8 }
    }

    const pitm = child(buf, metaBox, 'pitm', true)
    const primary = pitm ? (buf[pitm.body] === 0 ? buf.readUInt16BE(pitm.body + 4) : buf.readUInt32BE(pitm.body + 4)) : 1

    // iloc: item -> extents
    const iloc = child(buf, metaBox, 'iloc', true)
    const locs = new Map<number, { method: number; base: number; extents: [number, number][] }>()
    if (iloc) {
      const v = buf[iloc.body]
      let p = iloc.body + 4
      const offSize = buf[p] >> 4, lenSize = buf[p] & 15, baseSize = buf[p + 1] >> 4, idxSize = v >= 1 ? buf[p + 1] & 15 : 0
      p += 2
      const count = v < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p)
      p += v < 2 ? 2 : 4
      for (let i = 0; i < count; i++) {
        const id = v < 2 ? buf.readUInt16BE(p) : buf.readUInt32BE(p)
        p += v < 2 ? 2 : 4
        let method = 0
        if (v >= 1) { method = buf.readUInt16BE(p) & 15; p += 2 }
        p += 2 // data_reference_index
        const base = readN(buf, p, baseSize); p += baseSize
        const n = buf.readUInt16BE(p); p += 2
        const extents: [number, number][] = []
        for (let e = 0; e < n; e++) {
          p += idxSize
          const off = readN(buf, p, offSize); p += offSize
          const len = readN(buf, p, lenSize); p += lenSize
          extents.push([off, len])
        }
        locs.set(id, { method, base, extents })
      }
    }

    // iinf: item types
    const types = new Map<number, string>()
    const iinf = child(buf, metaBox, 'iinf', true)
    if (iinf) {
      const v = buf[iinf.body]
      for (const infe of boxes(buf, iinf.body + 4 + (v === 0 ? 2 : 4), iinf.end)) {
        if (infe.type !== 'infe') continue
        const iv = buf[infe.body]
        if (iv < 2) continue
        const id = iv === 2 ? buf.readUInt16BE(infe.body + 4) : buf.readUInt32BE(infe.body + 4)
        const tOff = infe.body + 4 + (iv === 2 ? 2 : 4) + 2
        types.set(id, buf.toString('latin1', tOff, tOff + 4))
      }
    }

    // iref auxl: aux item -> master
    const auxOf = new Map<number, number[]>()
    const iref = child(buf, metaBox, 'iref', true)
    if (iref) {
      const v = buf[iref.body]
      const w = v === 0 ? 2 : 4
      for (const r of boxes(buf, iref.body + 4, iref.end)) {
        if (r.type !== 'auxl') continue
        const rd = (o: number) => (w === 2 ? buf.readUInt16BE(o) : buf.readUInt32BE(o))
        const from = rd(r.body)
        const n = buf.readUInt16BE(r.body + w)
        auxOf.set(from, Array.from({ length: n }, (_, k) => rd(r.body + w + 2 + k * w)))
      }
    }

    // iprp: properties per item
    const iprp = child(buf, metaBox, 'iprp', true)
    const props: Box[] = []
    const assoc = new Map<number, number[]>()
    if (iprp) {
      const ipco = child(buf, iprp, 'ipco')
      if (ipco) props.push(...boxes(buf, ipco.body, ipco.end))
      for (const ipma of boxes(buf, iprp.body, iprp.end).filter((b) => b.type === 'ipma')) {
        const v = buf[ipma.body]
        const flags = buf.readUIntBE(ipma.body + 1, 3)
        let p = ipma.body + 4
        const count = buf.readUInt32BE(p); p += 4
        for (let i = 0; i < count; i++) {
          const id = v < 1 ? buf.readUInt16BE(p) : buf.readUInt32BE(p)
          p += v < 1 ? 2 : 4
          const n = buf[p++]
          const list: number[] = []
          for (let k = 0; k < n; k++) {
            if (flags & 1) { list.push(buf.readUInt16BE(p) & 0x7fff); p += 2 }
            else list.push(buf[p++] & 0x7f)
          }
          assoc.set(id, list)
        }
      }
    }
    const propsOf = (id: number): Box[] => (assoc.get(id) ?? []).filter((i) => i > 0).map((i) => props[i - 1]).filter(Boolean)

    let rotation = 0
    let mirror: 'h' | 'v' | undefined
    for (const pr of propsOf(primary)) {
      if (pr.type === 'irot') rotation = buf[pr.body] & 3
      // axis 0 mirrors about the vertical axis (left/right), axis 1 about the horizontal axis
      if (pr.type === 'imir') mirror = buf[pr.body] & 1 ? 'v' : 'h'
    }

    const aux: AuxImage[] = []
    for (const [id, masters] of auxOf) {
      if (!masters.includes(primary) || types.get(id) !== 'hvc1') continue
      const ps = propsOf(id)
      const auxC = ps.find((p) => p.type === 'auxC')
      if (!auxC) continue
      const urn = buf.toString('latin1', auxC.body + 4, auxC.end).split('\0')[0]
      const kind = AUX_TYPES[urn]
      if (!kind || aux.some((a) => a.type === kind)) continue
      const hvcC = ps.find((p) => p.type === 'hvcC')
      const ispe = ps.find((p) => p.type === 'ispe')
      const loc = locs.get(id)
      if (!hvcC || !ispe || !loc || loc.method !== 0) continue
      const parts: Buffer[] = []
      const START = Buffer.from([0, 0, 0, 1])
      const lenSize = (buf[hvcC.body + 21] & 3) + 1
      let p = hvcC.body + 22
      const arrays = buf[p++]
      for (let a = 0; a < arrays; a++) {
        p++
        const n = buf.readUInt16BE(p); p += 2
        for (let k = 0; k < n; k++) {
          const len = buf.readUInt16BE(p); p += 2
          parts.push(START, buf.subarray(p, p + len)); p += len
        }
      }
      for (const [off, len] of loc.extents) {
        const data = Buffer.alloc(len)
        await fh.read(data, 0, len, loc.base + off)
        let q = 0
        while (q + lenSize <= data.length) {
          const n = data.readUIntBE(q, lenSize)
          q += lenSize
          parts.push(START, data.subarray(q, q + n))
          q += n
        }
      }
      aux.push({ type: kind, width: buf.readUInt32BE(ispe.body + 4), height: buf.readUInt32BE(ispe.body + 8), annexB: Buffer.concat(parts) })
    }
    return { rotation, mirror, aux }
  } finally {
    await fh.close()
  }
}
