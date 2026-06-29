import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GlobalSearchIndex } from '../electron/search-index.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'next-pdf-search-'))

try {
  const index = new GlobalSearchIndex(root)
  const document = {
    id: 'document-a',
    name: 'NIST.pdf',
    path: 'C:\\Library\\NIST.pdf',
    fileSize: 1024,
    modifiedAt: 100,
  }
  await index.syncLibrarySources(
    { [document.id]: document },
    {
      'document-key': {
        filePath: document.path,
        fileSize: document.fileSize,
        modifiedAt: document.modifiedAt,
        highlights: [{
          id: 'highlight-1',
          pageNumber: 12,
          text: 'Risk management framework',
          note: 'Use in Chapter 2',
          category: 'research',
          color: 'green',
          createdDate: '2026-06-01T00:00:00.000Z',
          modifiedDate: '2026-06-02T00:00:00.000Z',
        }],
      },
    },
  )
  await index.startDocument({
    id: document.id,
    name: document.name,
    filePath: document.path,
    fileSize: document.fileSize,
    modifiedAt: document.modifiedAt,
    totalPages: 2,
    metadata: { title: 'Zero Trust Architecture', author: 'NIST', subject: 'Cyber security', keywords: 'zero trust' },
    bookmarks: [{ title: 'Security Controls', pageNumber: 2 }],
  })
  await index.appendPages(document.id, [
    { pageNumber: 1, text: 'Zero trust changes the traditional network security model.' },
    { pageNumber: 2, text: 'Continuous verification and compliance monitoring are required.' },
  ])
  await index.completeDocument(document.id)

  const all = { type: 'all', category: 'all', documentId: 'all', dateStart: '', dateEnd: '', scope: 'all' }
  const exact = await index.search({ query: '"zero trust"', filters: all })
  assert.ok(exact.results.some((result) => result.type === 'pdf-text' && result.pageNumber === 1))

  const fuzzy = await index.search({ query: 'cyber securty', filters: all })
  assert.ok(fuzzy.results.some((result) => result.type === 'metadata'))

  const note = await index.search({ query: 'chapter 2', filters: all })
  assert.equal(note.results[0]?.type, 'note')

  const category = await index.search({
    query: 'risk',
    filters: { ...all, type: 'highlight', category: 'research' },
  })
  assert.equal(category.results.length, 1)
  assert.equal(category.results[0].highlightId, 'highlight-1')

  const excludedWorkspace = await index.search({
    query: 'risk',
    filters: { ...all, scope: 'workspace', documentIds: ['another-document'] },
  })
  assert.equal(excludedWorkspace.results.length, 0)

  assert.deepEqual(await index.recordSearch('zero trust'), ['zero trust'])
  const saved = await index.saveSearch({ name: 'Zero Trust', query: 'zero trust', filters: all, workspaceId: 'workspace-a' })
  assert.equal(saved[0].name, 'Zero Trust')
  assert.equal((await index.getWorkspaceStats([document.id], 'workspace-a')).savedSearches, 1)

  const reloaded = new GlobalSearchIndex(root)
  const persisted = await reloaded.search({ query: 'continuous verification', filters: all })
  assert.ok(persisted.results.some((result) => result.type === 'pdf-text' && result.pageNumber === 2))
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

console.log('Global search index regression tests passed.')
