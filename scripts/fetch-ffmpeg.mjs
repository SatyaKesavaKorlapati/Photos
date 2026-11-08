// Downloads a current ffmpeg build into vendor/ffmpeg (Windows). The npm ffmpeg packages date from 2018
// and cannot decode HEIC tile grids or render Long Exposure reliably.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dest = join(process.cwd(), 'vendor', 'ffmpeg')
if (process.platform !== 'win32') {
  console.log('On macOS install ffmpeg with Homebrew (brew install ffmpeg) and copy ffmpeg/ffprobe into vendor/ffmpeg.')
  process.exit(0)
}
if (existsSync(join(dest, 'ffmpeg.exe')) && !process.argv.includes('--force')) {
  console.log('vendor/ffmpeg already present (use --force to refresh).')
  process.exit(0)
}
const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
const work = join(tmpdir(), `ffmpeg-${Date.now()}`)
mkdirSync(work, { recursive: true })
const zip = join(work, 'ffmpeg.zip')
console.log(`Downloading ${url}`)
const res = await fetch(url)
if (!res.ok) throw new Error(`download failed: ${res.status}`)
writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`], { stdio: 'inherit' })
const root = readdirSync(work).map((d) => join(work, d)).find((d) => statSync(d).isDirectory() && existsSync(join(d, 'bin', 'ffmpeg.exe')))
if (!root) throw new Error('unexpected archive layout')
mkdirSync(dest, { recursive: true })
for (const f of ['ffmpeg.exe', 'ffprobe.exe']) copyFileSync(join(root, 'bin', f), join(dest, f))
rmSync(work, { recursive: true, force: true })
console.log(`ffmpeg installed to ${dest}`)
