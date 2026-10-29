import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestPng } from './image-fixture.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
for (const label of ['A', 'B']) {
  await fs.writeFile(path.join(root, 'samples', 'png-' + label.toLowerCase() + '.png'), createTestPng(label))
}
console.log('Updated samples/png-a.png and png-b.png (480 x 240)')
