import { effectiveAdjust, orientedSize, portraitStrength, straightenScale, type CropRect, type EditRecipe } from '../../../shared/edits'

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform mat3 u_map;          // output uv -> source uv
uniform vec2 u_out;          // output size in pixels
uniform vec2 u_offset;       // tile offset in pixels
uniform float u_flipY;
uniform float u_exposure, u_brilliance, u_highlights, u_shadows, u_contrast, u_brightness, u_black;
uniform float u_saturation, u_vibrance, u_warmth, u_tint;
uniform float u_sharpness, u_definition, u_noise, u_vignette;
uniform sampler2D u_depth;   // R = disparity (near is bright), G = person matte
uniform float u_bokeh;       // largest blur radius in source-height uv; 0 = off
uniform float u_focus;       // disparity kept sharp
uniform float u_srcH;
out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.2627, 0.6780, 0.0593)); }
vec3 tap(vec2 uv) { return texture(u_tex, uv).rgb; }

// Circle of confusion (0…1): behind the focal plane blurs fully, in front a little less; the matte keeps people sharp.
float coc(vec2 uv) {
  vec2 dm = texture(u_depth, uv).rg;
  float d = u_focus - dm.r;
  float c = d > 0.0 ? smoothstep(0.015, 0.32, d) : 0.8 * smoothstep(0.05, 0.4, -d);
  return c * (1.0 - smoothstep(0.35, 0.9, dm.g));
}

// Golden-angle disc gather. Each tap only counts if its own blur reaches this pixel, so the sharp
// subject never smears into the background; bright taps are boosted into bokeh balls.
vec3 bokeh(vec2 uv) {
  float c0 = coc(uv);
  float rad = u_bokeh * c0;
  vec3 base = tap(uv);
  if (rad * u_srcH < 0.75) return base;
  float lod = log2(max(1.0, rad * u_srcH / 9.0));
  vec2 asp = vec2(u_texel.x / u_texel.y, 1.0);
  vec3 acc = textureLod(u_tex, uv, lod).rgb;
  float wsum = 1.0;
  for (int i = 0; i < 40; i++) {
    float t = (float(i) + 0.5) / 40.0;
    float r = sqrt(t) * rad;
    float a = float(i) * 2.39996323;
    vec2 suv = clamp(uv + vec2(cos(a), sin(a)) * r * asp, vec2(0.0), vec2(1.0));
    float reach = coc(suv) * u_bokeh;
    float w = clamp((reach - r) * u_srcH * 0.5 + 1.0, 0.0, 1.0);
    vec3 s = textureLod(u_tex, suv, lod).rgb;
    w *= 1.0 + 4.0 * smoothstep(0.72, 0.98, luma(s));
    acc += s * w;
    wsum += w;
  }
  return mix(base, acc / wsum, smoothstep(0.75, 2.5, rad * u_srcH));
}

void main() {
  vec2 frag = gl_FragCoord.xy + u_offset;
  vec2 p = vec2(frag.x / u_out.x, u_flipY > 0.5 ? 1.0 - frag.y / u_out.y : frag.y / u_out.y);
  vec2 uv = (u_map * vec3(p, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 c = u_bokeh > 0.0 ? bokeh(uv) : tap(uv);

  // Detail passes read the unblurred source, so they fade out where the portrait blur applies.
  float sharp = u_bokeh > 0.0 ? 1.0 - smoothstep(0.0, 0.25, coc(uv)) : 1.0;
  if ((u_sharpness > 0.0 || u_noise > 0.0) && sharp > 0.0) {
    vec3 n = (tap(uv + vec2(u_texel.x, 0.0)) + tap(uv - vec2(u_texel.x, 0.0)) + tap(uv + vec2(0.0, u_texel.y)) + tap(uv - vec2(0.0, u_texel.y))) * 0.25;
    c = mix(c, mix(c, n, u_noise * 0.6), sharp);
    c += (c - n) * u_sharpness * 1.6 * sharp;
  }
  if (u_definition > 0.0 && sharp > 0.0) {
    vec2 r = u_texel * 7.0;
    vec3 b = (tap(uv + vec2(r.x, 0.0)) + tap(uv - vec2(r.x, 0.0)) + tap(uv + vec2(0.0, r.y)) + tap(uv - vec2(0.0, r.y))
      + tap(uv + r) + tap(uv - r) + tap(uv + vec2(r.x, -r.y)) + tap(uv + vec2(-r.x, r.y))) * 0.125;
    c += (c - b) * u_definition * 0.9 * sharp;
  }

  c *= exp2(u_exposure * 1.5 / 2.2);
  if (u_brightness != 0.0) c = pow(max(c, 0.0), vec3(1.0 - u_brightness * 0.38));

  float l = luma(c);
  float sm = 1.0 - smoothstep(0.0, 0.55, l);
  float hm = smoothstep(0.45, 1.0, l);
  c += u_shadows * 0.24 * sm * (1.0 - l);
  c += u_highlights * 0.24 * hm;
  c += u_brilliance * (0.16 * sm - 0.10 * hm);

  if (u_contrast > 0.0) c = mix(c, smoothstep(0.0, 1.0, c), u_contrast);
  else c = mix(c, vec3(0.5), -u_contrast * 0.45);

  if (u_black > 0.0) { float k = u_black * 0.14; c = (c - k) / (1.0 - k); }
  else if (u_black < 0.0) { float k = -u_black * 0.09; c = c * (1.0 - k) + k; }

  l = luma(c);
  c = mix(vec3(l), c, 1.0 + u_saturation);
  float s = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  c = mix(vec3(l), c, 1.0 + u_vibrance * (1.0 - clamp(s, 0.0, 1.0)));
  c.r += u_warmth * 0.075 + u_tint * 0.03;
  c.b -= u_warmth * 0.075 - u_tint * 0.03;
  c.g -= u_tint * 0.065;

  if (u_vignette > 0.0) {
    float aspect = u_out.x / u_out.y;
    vec2 q = (p - 0.5) * vec2(aspect, 1.0);
    float d = length(q) / length(vec2(aspect, 1.0) * 0.5);
    c *= 1.0 - u_vignette * 0.85 * smoothstep(0.3, 1.05, d);
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

type M = [number, number, number, number, number, number] // a b c / d e f  (x' = a x + b y + c, y' = d x + e y + f)
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
  m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5]
]
const T = (x: number, y: number): M => [1, 0, x, 0, 1, y]
const S = (x: number, y: number): M => [x, 0, 0, 0, y, 0]
const R = (a: number): M => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0]

/** Maps output uv (inside the crop) to source texture uv. Mirrors `ffmpegFilters` in shared/edits. */
export function sourceMap(r: EditRecipe, srcW: number, srcH: number, crop: CropRect = r.crop): M {
  const q = ((r.rot90 % 4) + 4) % 4
  const o = orientedSize(srcW, srcH, q)
  const s = straightenScale(o.w, o.h, r.angle)
  const th = (r.angle * Math.PI) / 180
  // output -> oriented normalised (crop)
  let m: M = mul(T(crop.x, crop.y), S(crop.w, crop.h))
  // undo straighten in oriented pixel space
  m = mul(S(o.w, o.h), m)
  m = mul(mul(T(o.w / 2, o.h / 2), mul(R(-th), S(1 / s, 1 / s))), mul(T(-o.w / 2, -o.h / 2), m))
  m = mul(S(1 / o.w, 1 / o.h), m)
  // undo clockwise quarter turns: inverse of (x, y) -> (1 - y, x) is (x, y) -> (y, 1 - x)
  const inv: M = [0, 1, 0, -1, 0, 1]
  for (let i = 0; i < q; i++) m = mul(inv, m)
  if (r.flipH) m = mul([-1, 0, 1, 0, 1, 0], m)
  if (r.flipV) m = mul([1, 0, 0, 0, -1, 1], m)
  return m
}

export class EditRenderer {
  readonly gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private tex: WebGLTexture
  private loc: Record<string, WebGLUniformLocation | null> = {}
  srcW = 0
  srcH = 0
  readonly maxSize: number

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    const g = gl as unknown as { drawingBufferColorSpace?: string; unpackColorSpace?: string }
    if ('drawingBufferColorSpace' in g) g.drawingBufferColorSpace = 'display-p3'
    if ('unpackColorSpace' in g) g.unpackColorSpace = 'display-p3'
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link')
    this.prog = p
    gl.useProgram(p)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const a = gl.getAttribLocation(p, 'a_pos')
    gl.enableVertexAttribArray(a)
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0)
    for (const n of [
      'u_tex', 'u_texel', 'u_map', 'u_out', 'u_offset', 'u_flipY', 'u_exposure', 'u_brilliance', 'u_highlights', 'u_shadows', 'u_contrast',
      'u_brightness', 'u_black', 'u_saturation', 'u_vibrance', 'u_warmth', 'u_tint', 'u_sharpness', 'u_definition', 'u_noise', 'u_vignette',
      'u_depth', 'u_bokeh', 'u_focus', 'u_srcH'
    ]) this.loc[n] = gl.getUniformLocation(p, n)
    this.tex = gl.createTexture()!
    this.depthTex = gl.createTexture()!
  }

  private depthTex: WebGLTexture
  hasDepth = false

  /** Depth map (R = disparity, G = matte) aligned with the source; used by the portrait effect. */
  setDepth(el: TexImageSource | null): void {
    const gl = this.gl
    this.hasDepth = !!el
    if (!el) return
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    const g = gl as unknown as { unpackColorSpace?: string }
    const prev = g.unpackColorSpace
    if (prev) g.unpackColorSpace = 'srgb'
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el)
    if (prev) g.unpackColorSpace = prev
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.activeTexture(gl.TEXTURE0)
  }

  private bindTextures(): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex)
    gl.uniform1i(this.loc.u_depth, 1)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.uniform1i(this.loc.u_tex, 0)
  }

  setSource(el: TexImageSource, w: number, h: number, mipmaps = true): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el)
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.srcW = w
    this.srcH = h
  }

  private uniforms(r: EditRecipe, outW: number, outH: number, crop: CropRect | undefined, adjust: boolean): void {
    const gl = this.gl
    const m = sourceMap(r, this.srcW, this.srcH, crop)
    gl.uniformMatrix3fv(this.loc.u_map, false, [m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1])
    gl.uniform2f(this.loc.u_out, outW, outH)
    gl.uniform2f(this.loc.u_texel, 1 / this.srcW, 1 / this.srcH)
    const a = effectiveAdjust(r)
    const set = (n: string, v: number) => gl.uniform1f(this.loc[n], adjust ? v : 0)
    set('u_exposure', a.exposure)
    set('u_brilliance', a.brilliance)
    set('u_highlights', a.highlights)
    set('u_shadows', a.shadows)
    set('u_contrast', a.contrast)
    set('u_brightness', a.brightness)
    set('u_black', a.blackPoint)
    set('u_saturation', a.saturation)
    set('u_vibrance', a.vibrance)
    set('u_warmth', a.warmth)
    set('u_tint', a.tint)
    set('u_sharpness', a.sharpness)
    set('u_definition', a.definition)
    set('u_noise', a.noise)
    set('u_vignette', a.vignette)
    const pt = r.portrait
    gl.uniform1f(this.loc.u_bokeh, adjust && pt?.on && this.hasDepth ? 0.03 * portraitStrength(pt.aperture) : 0)
    gl.uniform1f(this.loc.u_focus, pt?.focus ?? 0.5)
    gl.uniform1f(this.loc.u_srcH, this.srcH)
  }

  /** Draws to the visible canvas. `crop` overrides the recipe's crop (the Crop tab shows the whole frame). */
  draw(r: EditRecipe, w: number, h: number, opts: { crop?: CropRect; adjust?: boolean } = {}): void {
    const gl = this.gl
    if (!this.srcW) return
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.prog)
    this.bindTextures()
    this.uniforms(r, w, h, opts.crop, opts.adjust ?? true)
    gl.uniform2f(this.loc.u_offset, 0, 0)
    gl.uniform1f(this.loc.u_flipY, 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Full-resolution render in tiles; returns tightly packed top-down RGBA. */
  async renderFull(r: EditRecipe, outW: number, outH: number, onProgress?: (p: number) => void): Promise<Uint8Array> {
    const gl = this.gl
    const tile = Math.min(2048, this.maxSize)
    const out = new Uint8Array(outW * outH * 4)
    const fbTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, fbTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tile, tile, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0)
    gl.useProgram(this.prog)
    this.bindTextures()
    this.uniforms(r, outW, outH, undefined, true)
    gl.uniform1f(this.loc.u_flipY, 0)
    const buf = new Uint8Array(tile * tile * 4)
    const tilesX = Math.ceil(outW / tile)
    const tilesY = Math.ceil(outH / tile)
    let n = 0
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * tile
        const y0 = ty * tile
        const w = Math.min(tile, outW - x0)
        const h = Math.min(tile, outH - y0)
        gl.viewport(0, 0, w, h)
        gl.uniform2f(this.loc.u_offset, x0, y0)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        for (let row = 0; row < h; row++) out.set(buf.subarray(row * w * 4, row * w * 4 + w * 4), ((y0 + row) * outW + x0) * 4)
        onProgress?.(++n / (tilesX * tilesY))
        await new Promise((res) => setTimeout(res, 0))
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(fbTex)
    return out
  }

  /** Small RGBA readback of the unadjusted source for Auto Enhance. */
  sample(size = 64): Uint8Array {
    const gl = this.gl
    const fbTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, fbTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0)
    gl.viewport(0, 0, size, size)
    gl.useProgram(this.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    const identity: EditRecipe = {
      adjust: {}, filter: null, filterAmount: 1, crop: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, rot90: 0, flipH: false, flipV: false, size: null, trim: null, mute: false
    }
    this.uniforms(identity, size, size, undefined, false)
    gl.uniform2f(this.loc.u_offset, 0, 0)
    gl.uniform1f(this.loc.u_flipY, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    const px = new Uint8Array(size * size * 4)
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(fbTex)
    return px
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

/** Apple-like Auto Enhance from a luminance histogram of the source. */
export function autoEnhance(px: Uint8Array): Partial<Record<string, number>> {
  const hist = new Array(256).fill(0)
  let sum = 0
  let satSum = 0
  const n = px.length / 4
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    const l = Math.round(0.2627 * r + 0.678 * g + 0.0593 * b)
    hist[l]++
    sum += l
    satSum += (Math.max(r, g, b) - Math.min(r, g, b)) / 255
  }
  const pct = (p: number) => {
    let acc = 0
    for (let i = 0; i < 256; i++) {
      acc += hist[i]
      if (acc >= n * p) return i / 255
    }
    return 1
  }
  const mean = sum / n / 255
  const lo = pct(0.02)
  const hi = pct(0.98)
  const sat = satSum / n
  const r2 = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 100) / 100
  return {
    exposure: r2((0.46 - mean) * 0.9),
    brilliance: r2(0.18),
    highlights: r2(hi > 0.94 ? -0.35 : -0.1),
    shadows: r2(lo < 0.06 ? 0.3 : 0.12),
    contrast: r2(hi - lo < 0.7 ? 0.12 : 0.04),
    blackPoint: r2(lo > 0.08 ? 0.15 : 0.04),
    vibrance: r2(sat < 0.25 ? 0.22 : 0.08)
  }
}
