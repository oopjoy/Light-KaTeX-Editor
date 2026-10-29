import { deflateSync } from 'node:zlib'

// Deterministic, visible PNGs for desktop regressions and manual acceptance.
export const IMAGE_WIDTH = 480
export const IMAGE_HEIGHT = 240
function chunk(type, data) {
  const tag = Buffer.from(type)
  const body = Buffer.concat([tag, data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, body, checksum])
}
export function createTestPng(label = 'A') {
  const glyph = label === 'B' ? ['11110','10001','10001','11110','10001','10001','11110']
    : ['01110','10001','10001','11111','10001','10001','10001']
  const color = label === 'B' ? [13, 130, 91] : [32, 91, 204]
  const raw = Buffer.alloc((1 + IMAGE_WIDTH * 3) * IMAGE_HEIGHT)
  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    for (let x = 0; x < IMAGE_WIDTH; x++) {
      const gx = Math.floor((x - 180) / 24), gy = Math.floor((y - 36) / 24)
      const letter = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && glyph[gy][gx] === '1'
      const edge = x < 8 || y < 8 || x >= IMAGE_WIDTH - 8 || y >= IMAGE_HEIGHT - 8
      const stripe = Math.floor((x + y) / 40) % 2 === 0
      const rgb = letter ? [255,255,255] : edge ? [16,28,48] : color.map(c => Math.min(255, c + (stripe ? 16 : 0)))
      const offset = y * (1 + IMAGE_WIDTH * 3) + 1 + x * 3
      raw.set(rgb, offset)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(IMAGE_WIDTH, 0)
  header.writeUInt32BE(IMAGE_HEIGHT, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
