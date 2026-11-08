import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import {
  displayPath, editBasePath, ensureBaseFull, ensureBounce, ensureCompatVideo, ensureFull, ensureLongExposure, ensurePreview, ensureStrip, ensureThumb, getRenderRow, livePath
} from './render'
import { depthPath, ensureDepth } from './depth'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.webm': 'video/webm', '.3gp': 'video/3gpp'
}

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
  ])
}

async function serveFile(path: string, req: Request, cache = true): Promise<Response> {
  const s = await stat(path)
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  // Chromium does not sniff QuickTime well; MOV files are usually ISO-BMFF compatible.
  const contentType = type === 'video/quicktime' ? 'video/mp4' : type
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // The editor uploads these images into WebGL, which requires CORS-clean pixels.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cache ? 'max-age=31536000, immutable' : 'no-cache'
  }
  const range = req.headers.get('range')
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : s.size - 1
    if (!m?.[1] && m?.[2]) {
      start = Math.max(0, s.size - parseInt(m[2], 10))
      end = s.size - 1
    }
    end = Math.min(end, s.size - 1)
    if (start > end || start >= s.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${s.size}` } })
    const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${s.size}`, 'Content-Length': String(end - start + 1) }
    })
  }
  const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(s.size) } })
}

/**
 * media://thumb/<id>       512px JPEG
 * media://preview/<id>     1600px JPEG, or the original file when the browser can decode it
 * media://full/<id>        full-resolution image
 * media://original/<id>    the unedited original (full resolution)
 * media://video/<id>       the (edited) video file, byte-range streamed
 * media://live/<id>        Live Photo movie (edited render if present)
 * media://bounce/<id>      Bounce render
 * media://longexposure/<id>
 * media://compat/<id>      H.264 fallback for unsupported codecs (?which=live)
 */
export function handleMediaProtocol(): void {
  protocol.handle('media', async (req) => {
    const url = new URL(req.url)
    const kind = url.hostname
    const id = Number(url.pathname.replace(/^\//, ''))
    const original = url.searchParams.get('original') === '1'
    try {
      switch (kind) {
        case 'thumb': return await serveFile(await ensureThumb(id, 'high'), req)
        case 'preview': return await serveFile(await ensurePreview(id, original), req)
        case 'full': return await serveFile(await ensureFull(id, original), req)
        case 'video': {
          const r = getRenderRow(id)
          if (!r) break
          return await serveFile(displayPath(r, original), req)
        }
        case 'live': {
          const p = livePath(id, original)
          if (!p) break
          return await serveFile(p, req)
        }
        case 'bounce': return await serveFile(await ensureBounce(id), req)
        case 'longexposure': return await serveFile(await ensureLongExposure(id), req)
        case 'base': {
          const r = getRenderRow(id)
          if (!r) break
          if (original && r.kind === 'photo') return await serveFile(await ensureFull(id, true), req, false)
          return await serveFile(r.kind === 'video' ? editBasePath(r) : await ensureBaseFull(id), req, false)
        }
        case 'depth': {
          if (!(await ensureDepth(id))) break
          return await serveFile(depthPath(id), req)
        }
        case 'strip': return await serveFile(await ensureStrip(id, url.searchParams.get('edited') !== '1'), req)
        case 'compat': return await serveFile(await ensureCompatVideo(id, url.searchParams.get('which') === 'live' ? 'live' : 'video'), req)
      }
    } catch (e) {
      return new Response(String((e as Error).message), { status: 500 })
    }
    return new Response('not found', { status: 404 })
  })
}
