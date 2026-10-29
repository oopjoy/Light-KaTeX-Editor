import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Write a UTF-8 file without exposing a partially-written target.
 * The temporary file is in the same directory so the final rename stays on
 * one filesystem. If replacement is rejected, leave the original intact and
 * report failure; deleting the destination first would lose atomicity.
 */
export async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: fs.FileHandle | null = null
  try {
    await fs.mkdir(directory, { recursive: true })
    handle = await fs.open(temporary, 'wx')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null

    await fs.rename(temporary, filePath)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}
