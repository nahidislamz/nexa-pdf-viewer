import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const INDEX_VERSION = 1
const RESULT_LIMIT = 5000
const TYPE_WEIGHTS = {
  note: 100,
  highlight: 90,
  bookmark: 80,
  'ocr-text': 62,
  'pdf-text': 60,
  metadata: 50,
  reference: 55,
  file: 40,
}

export class GlobalSearchIndex {
  constructor(rootPath) {
    this.rootPath = rootPath
    this.manifestPath = path.join(rootPath, 'manifest.json')
    this.documentsPath = path.join(rootPath, 'documents')
    this.loaded = false
    this.loadPromise = null
    this.manifest = emptyManifest()
    this.documents = new Map()
    this.records = new Map()
    this.documentRecordIds = new Map()
    this.postings = new Map()
    this.tokenBuckets = new Map()
    this.fuzzyCache = new Map()
    this.sessions = new Map()
    this.operation = Promise.resolve()
  }

  ensureLoaded() {
    if (!this.loadPromise) this.loadPromise = this.load()
    return this.loadPromise
  }

  async load() {
    await fs.mkdir(this.documentsPath, { recursive: true })
    try {
      const parsed = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'))
      this.manifest = parsed?.version === INDEX_VERSION
        ? {
            ...emptyManifest(),
            ...parsed,
            documents: parsed.documents && typeof parsed.documents === 'object' ? parsed.documents : {},
            recentSearches: Array.isArray(parsed.recentSearches) ? parsed.recentSearches.slice(0, 20) : [],
            savedSearches: Array.isArray(parsed.savedSearches) ? parsed.savedSearches.slice(0, 100) : [],
          }
        : emptyManifest()
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error
      this.manifest = emptyManifest()
    }

    const ids = Object.keys(this.manifest.documents)
    for (let start = 0; start < ids.length; start += 16) {
      const batch = ids.slice(start, start + 16)
      const loaded = await Promise.all(batch.map(async (documentId) => {
        try {
          const document = JSON.parse(await fs.readFile(this.documentPath(documentId), 'utf8'))
          return document?.documentId === documentId ? document : null
        } catch {
          return null
        }
      }))
      for (const document of loaded) {
        if (!document) continue
        this.documents.set(document.documentId, sanitizeSearchDocument(document))
      }
    }
    for (const document of this.documents.values()) this.rebuildDocumentRecords(document)
    this.loaded = true
  }

  enqueue(operation) {
    const result = this.operation.then(async () => {
      await this.ensureLoaded()
      return operation()
    })
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }

  syncLibrarySources(documentRecords, highlightDocuments) {
    return this.enqueue(async () => {
      const highlightsByDocument = new Map()
      const availableRecords = Object.values(documentRecords ?? {}).filter(
        (record) => record && record.missing !== true,
      )
      const validDocumentIds = new Set(availableRecords.map((record) => record.id))
      const documentIdsByPath = new Map(
        availableRecords.map((record) => [
          normalizePath(record?.path),
          record?.id,
        ]),
      )
      for (const [documentKey, source] of Object.entries(highlightDocuments ?? {})) {
        const documentId = source?.filePath ? documentIdsByPath.get(normalizePath(source.filePath)) : null
        if (!documentId) continue
        const record = documentRecords[documentId]
        if (
          Number(source.fileSize) !== Number(record?.fileSize) ||
          Number(source.modifiedAt) !== Number(record?.modifiedAt)
        ) continue
        highlightsByDocument.set(documentId, {
          documentKey,
          highlights: Array.isArray(source.highlights) ? source.highlights : [],
        })
      }

      const changed = []
      for (const record of availableRecords) {
        if (!record?.id || !record?.path) continue
        const existing = this.documents.get(record.id)
        const identityChanged = existing && (
          existing.fileSize !== Number(record.fileSize) ||
          existing.modifiedAt !== Number(record.modifiedAt)
        )
        const sourceHighlights = highlightsByDocument.get(record.id)
        const next = sanitizeSearchDocument({
          ...(identityChanged ? {} : existing),
          documentId: record.id,
          documentKey: sourceHighlights?.documentKey ?? existing?.documentKey ?? null,
          name: record.name,
          filePath: record.path,
          fileSize: Number(record.fileSize) || 0,
          modifiedAt: Number(record.modifiedAt) || 0,
          indexedAt: identityChanged ? null : existing?.indexedAt ?? null,
          status: identityChanged ? 'pending' : existing?.status ?? 'pending',
          totalPages: identityChanged ? 0 : existing?.totalPages ?? 0,
          pages: identityChanged ? [] : existing?.pages ?? [],
          ocrPages: identityChanged ? [] : existing?.ocrPages ?? [],
          bookmarks: identityChanged ? [] : existing?.bookmarks ?? [],
          metadata: identityChanged ? {} : existing?.metadata ?? {},
          highlights: sourceHighlights?.highlights ?? existing?.highlights ?? [],
        })
        const sourceChanged =
          !existing ||
          identityChanged ||
          existing.name !== next.name ||
          existing.filePath !== next.filePath ||
          existing.documentKey !== next.documentKey ||
          JSON.stringify(existing.highlights) !== JSON.stringify(next.highlights)
        if (sourceChanged) changed.push(next)
      }

      for (const document of changed) {
        this.documents.set(document.documentId, document)
        this.rebuildDocumentRecords(document)
        await this.persistDocument(document)
      }
      const removedIds = [...this.documents.keys()].filter((documentId) => !validDocumentIds.has(documentId))
      for (const documentId of removedIds) {
        this.removeDocumentRecords(documentId)
        this.documents.delete(documentId)
        delete this.manifest.documents[documentId]
        await fs.rm(this.documentPath(documentId), { force: true })
      }
      if (changed.length || removedIds.length) await this.persistManifest()
    })
  }

  upsertFile(record) {
    return this.enqueue(async () => {
      const existing = this.documents.get(record.id)
      const identityChanged = existing && (
        existing.fileSize !== Number(record.fileSize) ||
        existing.modifiedAt !== Number(record.modifiedAt)
      )
      const document = sanitizeSearchDocument({
        ...(identityChanged ? {} : existing),
        documentId: record.id,
        name: record.name,
        filePath: record.path,
        fileSize: Number(record.fileSize) || 0,
        modifiedAt: Number(record.modifiedAt) || 0,
        indexedAt: identityChanged ? null : existing?.indexedAt ?? null,
        status: identityChanged ? 'pending' : existing?.status ?? 'pending',
        pages: identityChanged ? [] : existing?.pages ?? [],
        ocrPages: identityChanged ? [] : existing?.ocrPages ?? [],
        bookmarks: identityChanged ? [] : existing?.bookmarks ?? [],
        metadata: identityChanged ? {} : existing?.metadata ?? {},
        highlights: identityChanged ? [] : existing?.highlights ?? [],
      })
      this.documents.set(document.documentId, document)
      this.rebuildDocumentRecords(document)
      await this.persistDocument(document)
      await this.persistManifest()
    })
  }

  updateHighlights(record, documentKey, highlights) {
    return this.enqueue(async () => {
      const existing = this.documents.get(record.id)
      const document = sanitizeSearchDocument({
        ...existing,
        documentId: record.id,
        documentKey,
        name: record.name,
        filePath: record.path,
        fileSize: Number(record.fileSize) || 0,
        modifiedAt: Number(record.modifiedAt) || 0,
        status: existing?.status ?? 'pending',
        pages: existing?.pages ?? [],
        ocrPages: existing?.ocrPages ?? [],
        bookmarks: existing?.bookmarks ?? [],
        metadata: existing?.metadata ?? {},
        highlights,
      })
      this.documents.set(document.documentId, document)
      this.rebuildDocumentRecords(document)
      await this.persistDocument(document)
      await this.persistManifest()
    })
  }

  updateReferenceMetadata(record, reference, collectionNames = []) {
    return this.enqueue(async () => {
      const existing = this.documents.get(record.id)
      const document = sanitizeSearchDocument({
        ...existing,
        documentId: record.id,
        name: record.name,
        filePath: record.path,
        fileSize: Number(record.fileSize) || 0,
        modifiedAt: Number(record.modifiedAt) || 0,
        status: existing?.status ?? 'pending',
        pages: existing?.pages ?? [],
        ocrPages: existing?.ocrPages ?? [],
        bookmarks: existing?.bookmarks ?? [],
        highlights: existing?.highlights ?? [],
        metadata: {
          ...existing?.metadata,
          title: reference.title,
          author: reference.authors?.join(', '),
          keywords: reference.keywords?.join(', '),
          publisher: reference.publisher,
          journal: reference.journal,
          conference: reference.conference,
          doi: reference.doi,
          isbn: reference.isbn,
          collections: collectionNames.join(', '),
        },
      })
      this.documents.set(document.documentId, document)
      this.rebuildDocumentRecords(document)
      await this.persistDocument(document)
      await this.persistManifest()
    })
  }

  removeDocument(documentId) {
    return this.enqueue(async () => {
      this.removeDocumentRecords(documentId)
      this.documents.delete(documentId)
      delete this.manifest.documents[documentId]
      this.sessions.delete(documentId)
      await fs.rm(this.documentPath(documentId), { force: true })
      await this.persistManifest()
    })
  }

  getDocumentStatus(identity) {
    return this.enqueue(async () => {
      const document = this.documents.get(String(identity?.id ?? ''))
      const session = this.sessions.get(String(identity?.id ?? ''))
      const current = Boolean(
        document &&
        document.fileSize === Number(identity?.fileSize) &&
        document.modifiedAt === Number(identity?.modifiedAt) &&
        document.status === 'complete',
      )
      return {
        current,
        status: current ? 'complete' : document?.status ?? 'pending',
        indexedPages: current ? document.pages.length : session?.pages.filter(Boolean).length ?? 0,
        totalPages: current ? document.totalPages : session?.totalPages ?? document?.totalPages ?? 0,
      }
    })
  }

  startDocument(payload) {
    return this.enqueue(async () => {
      const documentId = String(payload?.id ?? '')
      if (!documentId) throw new Error('Invalid document index identity.')
      if (this.sessions.has(documentId)) return { accepted: false }
      this.sessions.set(documentId, {
        documentId,
        documentKey: payload.documentKey ?? this.documents.get(documentId)?.documentKey ?? null,
        name: String(payload.name ?? ''),
        filePath: String(payload.filePath ?? ''),
        fileSize: Number(payload.fileSize) || 0,
        modifiedAt: Number(payload.modifiedAt) || 0,
        totalPages: Math.max(0, Math.trunc(Number(payload.totalPages) || 0)),
        metadata: sanitizeMetadata(payload.metadata),
        bookmarks: sanitizeBookmarks(payload.bookmarks),
        pages: [],
        ocrPages: this.documents.get(documentId)?.ocrPages ?? [],
      })
      return { accepted: true }
    })
  }

  appendPages(documentId, pages) {
    return this.enqueue(async () => {
      const session = this.sessions.get(String(documentId ?? ''))
      if (!session) return { accepted: false }
      for (const page of Array.isArray(pages) ? pages.slice(0, 32) : []) {
        const pageNumber = Math.max(1, Math.trunc(Number(page?.pageNumber) || 0))
        const text = typeof page?.text === 'string' ? page.text.slice(0, 1_000_000) : ''
        session.pages[pageNumber - 1] = { pageNumber, text }
      }
      return { accepted: true, indexedPages: session.pages.filter(Boolean).length }
    })
  }

  upsertOcrPages(documentId, pages) {
    return this.enqueue(async () => {
      const id = String(documentId ?? '')
      const existing = this.documents.get(id)
      if (!existing) return { accepted: false, indexedPages: 0 }

      const ocrPagesByKey = new Map((existing.ocrPages ?? []).map((page) => [`${page.pageNumber}:${page.language}`, page]))
      for (const page of Array.isArray(pages) ? pages.slice(0, 200) : []) {
        const pageNumber = Math.max(1, Math.trunc(Number(page?.pageNumber) || 0))
        const text = typeof page?.text === 'string' ? page.text.slice(0, 1_000_000).trim() : ''
        const language = String(page?.language ?? 'eng').slice(0, 12)
        const confidence = Math.min(100, Math.max(0, Number(page?.confidence) || 0))
        const lowConfidence = page?.lowConfidence === true || confidence < 55
        if (!pageNumber || !text) continue
        ocrPagesByKey.set(`${pageNumber}:${language}`, {
          pageNumber,
          language,
          text,
          confidence,
          lowConfidence,
          createdAt: page?.createdAt ? String(page.createdAt) : new Date().toISOString(),
          updatedAt: page?.updatedAt ? String(page.updatedAt) : new Date().toISOString(),
        })
      }

      const document = sanitizeSearchDocument({
        ...existing,
        status: existing.status === 'complete' ? 'complete' : 'pending',
        ocrPages: [...ocrPagesByKey.values()].sort((left, right) => left.pageNumber - right.pageNumber || left.language.localeCompare(right.language)),
        indexedAt: new Date().toISOString(),
      })
      this.documents.set(id, document)
      this.rebuildDocumentRecords(document)
      await this.persistDocument(document)
      await this.persistManifest()
      return { accepted: true, indexedPages: document.pages.length }
    })
  }

  completeDocument(documentId) {
    return this.enqueue(async () => {
      const session = this.sessions.get(String(documentId ?? ''))
      if (!session) throw new Error('Document indexing session expired.')
      const existing = this.documents.get(session.documentId)
      const document = sanitizeSearchDocument({
        ...session,
        status: 'complete',
        indexedAt: new Date().toISOString(),
        pages: session.pages.filter(Boolean),
        ocrPages: existing?.ocrPages ?? [],
        highlights: existing?.highlights ?? [],
        metadata: { ...existing?.metadata, ...session.metadata },
      })
      this.sessions.delete(session.documentId)
      this.documents.set(document.documentId, document)
      this.rebuildDocumentRecords(document)
      await this.persistDocument(document)
      await this.persistManifest()
      return { indexedPages: document.pages.length, totalPages: document.totalPages }
    })
  }

  cancelDocument(documentId) {
    return this.enqueue(async () => {
      this.sessions.delete(String(documentId ?? ''))
    })
  }

  search(request) {
    return this.enqueue(async () => {
      const started = performance.now()
      const parsedQuery = parseQuery(request?.query)
      if (!parsedQuery.terms.length && !parsedQuery.phrases.length) return emptySearchResponse()
      const filters = sanitizeFilters(request?.filters)
      const candidateSets = parsedQuery.terms.map((term) => this.recordsForTerm(term))
      for (const phrase of parsedQuery.phrases) {
        const phraseTokens = tokenize(phrase)
        if (phraseTokens.length) candidateSets.push(...phraseTokens.map((term) => this.recordsForTerm(term)))
      }
      let candidateIds = intersectSets(candidateSets)
      if (!candidateIds) candidateIds = new Set(this.records.keys())

      const results = []
      const counts = { total: 0, highlights: 0, notes: 0, documents: 0, types: {} }
      const resultDocuments = new Set()
      for (const recordId of candidateIds) {
        const record = this.records.get(recordId)
        if (!record || !matchesFilters(record, filters)) continue
        const normalizedText = normalizeText(record.text)
        const words = normalizedText.match(/[\p{L}\p{N}]+/gu) ?? []
        if (parsedQuery.phrases.some((phrase) => !normalizedText.includes(normalizeText(phrase)))) continue
        if (!parsedQuery.terms.every((term) => wordsMatchTerm(words, term))) continue
        const score = scoreRecord(record, parsedQuery, normalizedText, words)
        results.push({
          ...record,
          score,
          preview: createPreview(record.text, parsedQuery),
          matchText: findMatchText(record.text, parsedQuery, words),
        })
        counts.total += 1
        counts.types[record.type] = (counts.types[record.type] ?? 0) + 1
        if (record.type === 'highlight') counts.highlights += 1
        if (record.type === 'note') counts.notes += 1
        resultDocuments.add(record.documentId)
      }
      counts.documents = resultDocuments.size
      results.sort((left, right) => right.score - left.score || Date.parse(right.modifiedDate ?? right.createdDate ?? 0) - Date.parse(left.modifiedDate ?? left.createdDate ?? 0))
      return {
        query: parsedQuery.raw,
        results: results.slice(0, RESULT_LIMIT),
        total: counts.total,
        counts,
        truncated: results.length > RESULT_LIMIT,
        durationMs: Math.round(performance.now() - started),
      }
    })
  }

  getLibraryInfo() {
    return this.enqueue(async () => ({
      documents: [...this.documents.values()].map((document) => {
        const session = this.sessions.get(document.documentId)
        return {
          documentId: document.documentId,
          name: document.name,
          filePath: document.filePath,
          status: session ? 'pending' : document.status,
          indexedPages: session ? session.pages.filter(Boolean).length : document.pages.length,
          totalPages: session?.totalPages ?? document.totalPages,
          indexedAt: document.indexedAt,
        }
      }).sort((left, right) => left.name.localeCompare(right.name)),
      recentSearches: this.manifest.recentSearches,
      savedSearches: this.manifest.savedSearches,
    }))
  }

  getWorkspaceStats(documentIds, workspaceId) {
    return this.enqueue(async () => {
      const ids = new Set(Array.isArray(documentIds) ? documentIds : [])
      let bookmarks = 0
      let totalPages = 0
      const totalPagesByDocument = {}
      for (const documentId of ids) {
        const document = this.documents.get(documentId)
        bookmarks += document?.bookmarks.length ?? 0
        totalPages += document?.totalPages ?? 0
        totalPagesByDocument[documentId] = document?.totalPages ?? 0
      }
      return {
        bookmarks,
        totalPages,
        totalPagesByDocument,
        savedSearches: this.manifest.savedSearches.filter(
          (search) => search.workspaceId === workspaceId,
        ).length,
      }
    })
  }

  getWorkspaceSavedSearches(workspaceId) {
    return this.enqueue(async () =>
      this.manifest.savedSearches.filter((search) => search.workspaceId === workspaceId),
    )
  }

  recordSearch(query) {
    return this.enqueue(async () => {
      const normalized = String(query ?? '').trim().slice(0, 500)
      if (!normalized) return this.manifest.recentSearches
      this.manifest.recentSearches = [normalized, ...this.manifest.recentSearches.filter((item) => item !== normalized)].slice(0, 20)
      await this.persistManifest()
      return this.manifest.recentSearches
    })
  }

  clearHistory() {
    return this.enqueue(async () => {
      this.manifest.recentSearches = []
      await this.persistManifest()
      return []
    })
  }

  saveSearch(search) {
    return this.enqueue(async () => {
      const query = String(search?.query ?? '').trim().slice(0, 500)
      const name = String(search?.name ?? query).trim().slice(0, 120)
      if (!query || !name) throw new Error('A saved search needs a name and query.')
      const item = {
        id: typeof search?.id === 'string' && search.id ? search.id : randomUUID(),
        name,
        query,
        filters: sanitizeFilters(search?.filters),
        workspaceId: typeof search?.workspaceId === 'string' ? search.workspaceId : null,
        createdAt: new Date().toISOString(),
      }
      this.manifest.savedSearches = [item, ...this.manifest.savedSearches.filter((candidate) => candidate.id !== item.id)].slice(0, 100)
      await this.persistManifest()
      return this.manifest.savedSearches
    })
  }

  deleteSavedSearch(id) {
    return this.enqueue(async () => {
      this.manifest.savedSearches = this.manifest.savedSearches.filter((item) => item.id !== id)
      await this.persistManifest()
      return this.manifest.savedSearches
    })
  }

  rebuildDocumentRecords(document) {
    this.removeDocumentRecords(document.documentId)
    const records = buildRecords(document)
    const recordIds = new Set()
    for (const record of records) {
      this.records.set(record.id, record)
      recordIds.add(record.id)
      for (const token of new Set(tokenize(record.text))) {
        const posting = this.postings.get(token) ?? new Set()
        posting.add(record.id)
        this.postings.set(token, posting)
        const bucketKey = token.slice(0, 2)
        const bucket = this.tokenBuckets.get(bucketKey) ?? new Set()
        bucket.add(token)
        this.tokenBuckets.set(bucketKey, bucket)
      }
    }
    this.documentRecordIds.set(document.documentId, recordIds)
    this.manifest.documents[document.documentId] = documentSummary(document)
    this.fuzzyCache.clear()
  }

  removeDocumentRecords(documentId) {
    const recordIds = this.documentRecordIds.get(documentId)
    if (!recordIds) return
    for (const recordId of recordIds) {
      const record = this.records.get(recordId)
      if (!record) continue
      for (const token of new Set(tokenize(record.text))) {
        const posting = this.postings.get(token)
        posting?.delete(recordId)
        if (posting?.size === 0) {
          this.postings.delete(token)
          const bucketKey = token.slice(0, 2)
          const bucket = this.tokenBuckets.get(bucketKey)
          bucket?.delete(token)
          if (bucket?.size === 0) this.tokenBuckets.delete(bucketKey)
        }
      }
      this.records.delete(recordId)
    }
    this.documentRecordIds.delete(documentId)
    this.fuzzyCache.clear()
  }

  recordsForTerm(term) {
    const normalized = normalizeText(term)
    const matchingTokens = this.expandTerm(normalized)
    const records = new Set()
    for (const token of matchingTokens) {
      for (const recordId of this.postings.get(token) ?? []) records.add(recordId)
    }
    return records
  }

  expandTerm(term) {
    const cached = this.fuzzyCache.get(term)
    if (cached) return cached
    const tokens = new Set()
    if (this.postings.has(term)) tokens.add(term)
    const bucket = this.tokenBuckets.get(term.slice(0, 2)) ?? new Set()
    for (const token of bucket) {
      if (token.startsWith(term) || term.startsWith(token)) tokens.add(token)
    }
    if (tokens.size === 0 && term.length >= 4) {
      const threshold = term.length >= 8 ? 2 : 1
      const fuzzyPool = new Set([
        ...(this.tokenBuckets.get(term.slice(0, 2)) ?? []),
        ...(this.tokenBuckets.get(term.slice(0, 1)) ?? []),
      ])
      const candidates = fuzzyPool.size ? fuzzyPool : this.postings.keys()
      for (const token of candidates) {
        if (Math.abs(token.length - term.length) <= threshold && levenshtein(token, term, threshold) <= threshold) tokens.add(token)
        if (tokens.size >= 100) break
      }
    }
    this.fuzzyCache.set(term, tokens)
    return tokens
  }

  documentPath(documentId) {
    return path.join(this.documentsPath, `${documentId}.json`)
  }

  async persistDocument(document) {
    await atomicWrite(this.documentPath(document.documentId), document)
  }

  async persistManifest() {
    await atomicWrite(this.manifestPath, this.manifest)
  }
}

function emptyManifest() {
  return { version: INDEX_VERSION, documents: {}, recentSearches: [], savedSearches: [] }
}

function sanitizeSearchDocument(document) {
  return {
    documentId: String(document.documentId ?? ''),
    documentKey: document.documentKey ? String(document.documentKey) : null,
    name: path.basename(String(document.name ?? 'Untitled.pdf')),
    filePath: String(document.filePath ?? ''),
    fileSize: Number(document.fileSize) || 0,
    modifiedAt: Number(document.modifiedAt) || 0,
    indexedAt: document.indexedAt ? String(document.indexedAt) : null,
    status: document.status === 'complete' ? 'complete' : 'pending',
    totalPages: Math.max(0, Math.trunc(Number(document.totalPages) || 0)),
    pages: Array.isArray(document.pages) ? document.pages.flatMap((page) => {
      const pageNumber = Math.max(1, Math.trunc(Number(page?.pageNumber) || 0))
      return typeof page?.text === 'string' ? [{ pageNumber, text: page.text }] : []
    }) : [],
    ocrPages: Array.isArray(document.ocrPages) ? document.ocrPages.flatMap((page) => {
      const pageNumber = Math.max(1, Math.trunc(Number(page?.pageNumber) || 0))
      const text = typeof page?.text === 'string' ? page.text.slice(0, 1_000_000) : ''
      if (!pageNumber || !text.trim()) return []
      const confidence = Math.min(100, Math.max(0, Number(page?.confidence) || 0))
      return [{
        pageNumber,
        language: String(page?.language ?? 'eng').slice(0, 12),
        text,
        confidence,
        lowConfidence: page?.lowConfidence === true || confidence < 55,
        createdAt: page?.createdAt ? String(page.createdAt) : document.indexedAt,
        updatedAt: page?.updatedAt ? String(page.updatedAt) : document.indexedAt,
      }]
    }) : [],
    bookmarks: sanitizeBookmarks(document.bookmarks),
    metadata: sanitizeMetadata(document.metadata),
    highlights: Array.isArray(document.highlights) ? document.highlights.flatMap((highlight) => {
      if (!highlight?.id || !highlight?.text) return []
      return [{
        id: String(highlight.id),
        pageNumber: Math.max(1, Math.trunc(Number(highlight.pageNumber) || 1)),
        text: String(highlight.text),
        note: typeof highlight.note === 'string' ? highlight.note : '',
        category: String(highlight.category ?? 'important'),
        color: String(highlight.color ?? 'yellow'),
        createdDate: String(highlight.createdDate ?? new Date(0).toISOString()),
        modifiedDate: String(highlight.modifiedDate ?? highlight.createdDate ?? new Date(0).toISOString()),
      }]
    }) : [],
  }
}

function sanitizeMetadata(metadata) {
  return {
    title: String(metadata?.title ?? '').slice(0, 2000),
    author: String(metadata?.author ?? '').slice(0, 2000),
    subject: String(metadata?.subject ?? '').slice(0, 5000),
    keywords: String(metadata?.keywords ?? '').slice(0, 5000),
    publisher: String(metadata?.publisher ?? '').slice(0, 2000),
    journal: String(metadata?.journal ?? '').slice(0, 2000),
    conference: String(metadata?.conference ?? '').slice(0, 2000),
    doi: String(metadata?.doi ?? '').slice(0, 500),
    isbn: String(metadata?.isbn ?? '').slice(0, 100),
    collections: String(metadata?.collections ?? '').slice(0, 5000),
  }
}

function sanitizeBookmarks(bookmarks) {
  return Array.isArray(bookmarks) ? bookmarks.slice(0, 10000).flatMap((bookmark) => {
    const title = String(bookmark?.title ?? '').trim().slice(0, 2000)
    if (!title) return []
    return [{ title, pageNumber: Math.max(1, Math.trunc(Number(bookmark?.pageNumber) || 1)) }]
  }) : []
}

function documentSummary(document) {
  return {
    documentId: document.documentId,
    name: document.name,
    filePath: document.filePath,
    fileSize: document.fileSize,
    modifiedAt: document.modifiedAt,
    indexedAt: document.indexedAt,
    status: document.status,
    totalPages: document.totalPages,
  }
}

function buildRecords(document) {
  const base = {
    documentId: document.documentId,
    documentKey: document.documentKey,
    documentName: document.name,
    filePath: document.filePath,
  }
  const records = [{
    ...base,
    id: `${document.documentId}:file`,
    type: 'file',
    pageNumber: 1,
    text: document.name,
    createdDate: document.indexedAt,
    modifiedDate: document.indexedAt,
  }]
  const metadataText = [document.metadata.title, document.metadata.author, document.metadata.subject, document.metadata.keywords, document.metadata.publisher, document.metadata.journal, document.metadata.conference, document.metadata.doi, document.metadata.isbn, document.metadata.collections].filter(Boolean).join('\n')
  if (metadataText) records.push({ ...base, id: `${document.documentId}:metadata`, type: 'metadata', pageNumber: 1, text: metadataText, createdDate: document.indexedAt, modifiedDate: document.indexedAt })
  const referenceText = [document.metadata.title, document.metadata.author, document.metadata.keywords, document.metadata.publisher, document.metadata.journal, document.metadata.conference, document.metadata.doi, document.metadata.isbn, document.metadata.collections].filter(Boolean).join('\n')
  if (referenceText) records.push({ ...base, id: `${document.documentId}:reference`, type: 'reference', pageNumber: 1, text: referenceText, createdDate: document.indexedAt, modifiedDate: document.indexedAt })
  for (const page of document.pages) records.push({ ...base, id: `${document.documentId}:page:${page.pageNumber}`, type: 'pdf-text', pageNumber: page.pageNumber, text: page.text, createdDate: document.indexedAt, modifiedDate: document.indexedAt })
  for (const page of document.ocrPages ?? []) {
    records.push({
      ...base,
      id: `${document.documentId}:ocr:${page.pageNumber}:${page.language}`,
      type: 'ocr-text',
      pageNumber: page.pageNumber,
      text: page.text,
      language: page.language,
      confidence: page.confidence,
      lowConfidence: page.lowConfidence,
      createdDate: page.createdAt ?? document.indexedAt,
      modifiedDate: page.updatedAt ?? document.indexedAt,
    })
  }
  document.bookmarks.forEach((bookmark, index) => records.push({ ...base, id: `${document.documentId}:bookmark:${index}`, type: 'bookmark', pageNumber: bookmark.pageNumber, text: bookmark.title, createdDate: document.indexedAt, modifiedDate: document.indexedAt }))
  for (const highlight of document.highlights) {
    records.push({ ...base, id: `${document.documentId}:highlight:${highlight.id}`, type: 'highlight', pageNumber: highlight.pageNumber, text: highlight.text, highlightId: highlight.id, category: highlight.category, color: highlight.color, createdDate: highlight.createdDate, modifiedDate: highlight.modifiedDate })
    if (highlight.note.trim()) records.push({ ...base, id: `${document.documentId}:note:${highlight.id}`, type: 'note', pageNumber: highlight.pageNumber, text: highlight.note, highlightId: highlight.id, category: highlight.category, color: highlight.color, createdDate: highlight.createdDate, modifiedDate: highlight.modifiedDate })
  }
  return records
}

function parseQuery(value) {
  const raw = String(value ?? '').trim().slice(0, 500)
  const phrases = []
  const remainder = raw.replace(/"([^"]+)"/g, (_match, phrase) => {
    if (phrase.trim()) phrases.push(phrase.trim())
    return ' '
  })
  return { raw, phrases, terms: tokenize(remainder) }
}

function sanitizeFilters(filters) {
  const type = ['all', 'pdf-text', 'ocr-text', 'highlight', 'note', 'bookmark', 'file', 'metadata', 'reference'].includes(filters?.type) ? filters.type : 'all'
  const category = ['all', 'important', 'research', 'reference', 'question'].includes(filters?.category) ? filters.category : 'all'
  return {
    type,
    category,
    documentId: typeof filters?.documentId === 'string' ? filters.documentId : 'all',
    dateStart: typeof filters?.dateStart === 'string' ? filters.dateStart : '',
    dateEnd: typeof filters?.dateEnd === 'string' ? filters.dateEnd : '',
    scope: filters?.scope === 'all' ? 'all' : 'workspace',
    documentIds: Array.isArray(filters?.documentIds)
      ? filters.documentIds.filter((value) => typeof value === 'string').slice(0, 5000)
      : null,
  }
}

function matchesFilters(record, filters) {
  if (filters.type !== 'all' && record.type !== filters.type) return false
  if (filters.category !== 'all' && record.category !== filters.category) return false
  if (filters.documentId !== 'all' && record.documentId !== filters.documentId) return false
  if (filters.documentIds && !filters.documentIds.includes(record.documentId)) return false
  const timestamp = Date.parse(record.modifiedDate ?? record.createdDate ?? 0)
  if (filters.dateStart && timestamp < Date.parse(`${filters.dateStart}T00:00:00`)) return false
  if (filters.dateEnd && timestamp > Date.parse(`${filters.dateEnd}T23:59:59.999`)) return false
  return true
}

function scoreRecord(record, query, normalizedText, words) {
  let score = TYPE_WEIGHTS[record.type] ?? 0
  const normalizedQuery = normalizeText(query.raw.replaceAll('"', ''))
  if (normalizedText.includes(normalizedQuery)) score += 40
  for (const phrase of query.phrases) if (normalizedText.includes(normalizeText(phrase))) score += 50
  for (const term of query.terms) {
    if (words.includes(term)) score += 15
    else if (words.some((word) => word.startsWith(term))) score += 8
    else score += 3
  }
  return score
}

function wordsMatchTerm(words, term) {
  if (words.includes(term)) return true
  const threshold = term.length >= 8 ? 2 : 1
  return words.some((word) => word.startsWith(term) || (term.length >= 4 && Math.abs(word.length - term.length) <= threshold && levenshtein(word, term, threshold) <= threshold))
}

function createPreview(text, query) {
  const normalized = normalizeText(text)
  const needles = [...query.phrases, ...query.terms].map(normalizeText).filter(Boolean)
  let index = -1
  for (const needle of needles) {
    index = normalized.indexOf(needle)
    if (index >= 0) break
  }
  if (index < 0) return text.slice(0, 320)
  const start = Math.max(0, index - 100)
  const end = Math.min(text.length, index + 220)
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`
}

function findMatchText(text, query, words) {
  const normalized = normalizeText(text)
  for (const phrase of query.phrases) {
    if (normalized.includes(normalizeText(phrase))) return phrase
  }
  for (const term of query.terms) {
    const exact = words.find((word) => word === term || word.startsWith(term))
    if (exact) return exact
    const threshold = term.length >= 8 ? 2 : 1
    const fuzzy = words.find((word) => term.length >= 4 && Math.abs(word.length - term.length) <= threshold && levenshtein(word, term, threshold) <= threshold)
    if (fuzzy) return fuzzy
  }
  return query.phrases[0] ?? query.terms[0] ?? ''
}

function tokenize(value) {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? []
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
}

function intersectSets(sets) {
  if (!sets.length) return null
  const sorted = sets.sort((left, right) => left.size - right.size)
  const result = new Set(sorted[0])
  for (const set of sorted.slice(1)) {
    for (const value of result) if (!set.has(value)) result.delete(value)
    if (!result.size) break
  }
  return result
}

function levenshtein(left, right, maxDistance) {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    let minimum = current[0]
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
      current[column] = value
      minimum = Math.min(minimum, value)
    }
    if (minimum > maxDistance) return maxDistance + 1
    previous = current
  }
  return previous[right.length]
}

function normalizePath(filePath) {
  const value = String(filePath ?? '')
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value
}

async function atomicWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  await fs.writeFile(temporaryPath, JSON.stringify(value), 'utf8')
  await fs.rename(temporaryPath, filePath)
}

function emptySearchResponse() {
  return { query: '', results: [], total: 0, counts: { total: 0, highlights: 0, notes: 0, documents: 0, types: {} }, truncated: false, durationMs: 0 }
}
