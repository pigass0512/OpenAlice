import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorIOJournal } from './io-journal.js'

const homes: string[] = []
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))))

describe('ConnectorIOJournal', () => {
  it('writes private JSONL and rotates bounded history', async () => {
    const home = await mkdtemp(join(tmpdir(), 'connector-journal-'))
    homes.push(home)
    const path = join(home, 'logs', 'connector-io.jsonl')
    const journal = new ConnectorIOJournal({ path, maxBytes: 300 })
    const record = (correlationId: string) => journal.record({
      correlationId,
      direction: 'inbound',
      stage: 'notification.received',
      payload: { notification: { id: correlationId, body: 'x'.repeat(160) } },
    })

    await record('first')
    await record('second')
    await record('third')
    await journal.flush()

    expect(await readFile(`${path}.1`, 'utf8')).toContain('"correlationId":"second"')
    expect(await readFile(path, 'utf8')).toContain('"correlationId":"third"')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
