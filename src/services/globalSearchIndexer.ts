import type { PDFDocumentProxy } from 'pdfjs-dist'

type IndexableDocument = {
  id: string
  name: string
  filePath: string
  fileSize: number
  modifiedAt: number
}

type OutlineItem = {
  title?: string
  dest?: string | unknown[] | null
  items?: OutlineItem[]
}

export async function indexPdfForGlobalSearch(
  pdf: PDFDocumentProxy,
  document: IndexableDocument,
  signal: AbortSignal,
  onProgress?: (indexedPages: number, totalPages: number) => void,
) {
  const status = await window.electronAPI.getSearchIndexStatus({
    id: document.id,
    fileSize: document.fileSize,
    modifiedAt: document.modifiedAt,
  })
  if (status.current || signal.aborted) return { indexed: false, pages: status.indexedPages }

  try {
    const [metadata, outline] = await Promise.all([
      extractMetadata(pdf),
      extractBookmarks(pdf, signal),
    ])
    if (signal.aborted) throw new DOMException('Indexing cancelled', 'AbortError')

    const session = await window.electronAPI.startSearchIndex({
      ...document,
      totalPages: pdf.numPages,
      metadata,
      bookmarks: outline,
    })
    if (!session.accepted) return { indexed: false, pages: 0 }

    const batchSize = 6
    for (let start = 1; start <= pdf.numPages; start += batchSize) {
      if (signal.aborted) throw new DOMException('Indexing cancelled', 'AbortError')
      const end = Math.min(pdf.numPages, start + batchSize - 1)
      const pages = await Promise.all(
        Array.from({ length: end - start + 1 }, async (_, index) => {
          const pageNumber = start + index
          const page = await pdf.getPage(pageNumber)
          const content = await page.getTextContent()
          const text = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .filter(Boolean)
            .join(' ')
          return { pageNumber, text }
        }),
      )
      await window.electronAPI.appendSearchIndexPages(document.id, pages)
      onProgress?.(end, pdf.numPages)
      await yieldToBrowser()
    }

    const result = await window.electronAPI.completeSearchIndex(document.id)
    return { indexed: true, pages: result.indexedPages }
  } catch (error) {
    await window.electronAPI.cancelSearchIndex(document.id).catch(() => undefined)
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return { indexed: false, pages: 0 }
    }
    throw error
  }
}

async function extractMetadata(pdf: PDFDocumentProxy) {
  const { info, metadata } = await pdf.getMetadata()
  const values = info as Record<string, unknown>
  return {
    title: metadataValue(values.Title, metadata?.get('dc:title')),
    author: metadataValue(values.Author, metadata?.get('dc:creator')),
    subject: metadataValue(values.Subject, metadata?.get('dc:description')),
    keywords: metadataValue(values.Keywords, metadata?.get('pdf:keywords')),
  }
}

async function extractBookmarks(pdf: PDFDocumentProxy, signal: AbortSignal) {
  const root = (await pdf.getOutline()) as OutlineItem[] | null
  const flattened: OutlineItem[] = []
  const visit = (items: OutlineItem[]) => {
    for (const item of items) {
      if (item.title) flattened.push(item)
      if (item.items?.length) visit(item.items)
      if (flattened.length >= 10_000) return
    }
  }
  visit(root ?? [])

  const bookmarks: Array<{ title: string; pageNumber: number }> = []
  for (let start = 0; start < flattened.length; start += 20) {
    if (signal.aborted) break
    const batch = flattened.slice(start, start + 20)
    const resolved = await Promise.all(batch.map(async (item) => ({
      title: String(item.title ?? '').trim(),
      pageNumber: await resolveDestinationPage(pdf, item.dest),
    })))
    bookmarks.push(...resolved.filter((item) => item.title && item.pageNumber > 0))
    await yieldToBrowser()
  }
  return bookmarks
}

async function resolveDestinationPage(pdf: PDFDocumentProxy, requested: OutlineItem['dest']) {
  if (!requested) return 1
  try {
    const destination = typeof requested === 'string' ? await pdf.getDestination(requested) : requested
    const reference = destination?.[0]
    if (typeof reference === 'number') return reference + 1
    if (reference && typeof reference === 'object') return (await pdf.getPageIndex(reference as never)) + 1
  } catch {
    return 1
  }
  return 1
}

function metadataValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value)) {
      const text = value.filter((item) => typeof item === 'string').join(', ').trim()
      if (text) return text
    }
  }
  return ''
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}
