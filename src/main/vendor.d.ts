declare module '@ffmpeg-installer/ffmpeg' {
  const v: { path: string; version: string; url: string }
  export default v
}
declare module 'ffprobe-static' {
  const v: { path: string }
  export default v
}
declare module 'libheif-js/wasm-bundle' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const libheif: any
  export default libheif
}

declare module 'heic-decode' {
  interface Decoded { width: number; height: number; data: Uint8ClampedArray }
  function decode(opts: { buffer: Uint8Array | ArrayBuffer }): Promise<Decoded>
  export default decode
}
declare module '*?modulePath' {
  const path: string
  export default path
}
