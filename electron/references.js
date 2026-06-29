const STYLES = ['apa', 'harvard', 'ieee', 'mla', 'chicago']
const SCALAR_FIELDS = ['title', 'year', 'publisher', 'journal', 'conference', 'volume', 'issue', 'pages', 'doi', 'url', 'isbn']
const EXTRACTION_SOURCES = ['reference_section', 'manual', 'metadata']
const REFERENCE_TYPES = ['Journal', 'Conference', 'Book', 'Thesis', 'Report', 'Website', 'Unknown']

export function sanitizeReference(reference, record = {}) {
  const now = new Date().toISOString()
  const sourceMetadata = sanitizeMetadata(reference?.sourceMetadata ?? reference?.metadata)
  const detectedMetadata = sanitizeMetadata(reference?.detectedMetadata ?? reference?.detected)
  const userOverrides = sanitizeMetadata(reference?.userOverrides ?? reference?.overrides)
  const sourceFileName = String(reference?.sourceFileName ?? reference?.documentName ?? record.name ?? 'Untitled.pdf').slice(0, 260)
  const sourceFilePath = String(reference?.sourceFilePath ?? reference?.filePath ?? record.path ?? '')
  if (!reference?.sourceMetadata && normalize(sourceMetadata.title) === normalize(cleanFileName(sourceFileName))) {
    sourceMetadata.title = ''
  }
  const normalized = {}
  for (const field of SCALAR_FIELDS) normalized[field] = userOverrides[field] || sourceMetadata[field] || detectedMetadata[field] || ''
  normalized.title = normalized.title || (reference?.extractionSource ? clean(reference?.rawText, 300) : cleanFileName(sourceFileName)) || 'Untitled'
  normalized.authors = firstValidAuthors(userOverrides.authors, sourceMetadata.authors, detectedMetadata.authors, normalized.title)
  normalized.keywords = uniqueStrings([...sourceMetadata.keywords, ...detectedMetadata.keywords, ...userOverrides.keywords], 500, 300)
  normalized.referenceType = userOverrides.referenceType
    || sourceMetadata.referenceType
    || detectedMetadata.referenceType
    || detectReferenceType({ ...normalized, rawText: reference?.rawText, keywords: normalized.keywords })
  return {
    id: String(reference?.id ?? record.id ?? '').slice(0, 128),
    documentId: String(reference?.documentId ?? reference?.sourceDocumentId ?? record.id ?? '').slice(0, 128),
    sourceDocumentId: String(reference?.sourceDocumentId ?? reference?.documentId ?? record.id ?? '').slice(0, 128),
    sourceFileName,
    sourceFilePath,
    documentName: sourceFileName,
    filePath: sourceFilePath,
    rawText: clean(reference?.rawText, 12000),
    confidence: Math.min(1, Math.max(0, Number(reference?.confidence) || 0)),
    extractionSource: EXTRACTION_SOURCES.includes(reference?.extractionSource) ? reference.extractionSource : null,
    doiLookupSource: clean(reference?.doiLookupSource, 200),
    doiLookupAt: validDate(reference?.doiLookupAt) ?? '',
    sourceMetadata,
    detectedMetadata,
    userOverrides,
    // Compatibility aliases for existing V2.8 stores and callers.
    metadata: sourceMetadata,
    detected: detectedMetadata,
    overrides: userOverrides,
    ...normalized,
    collectionIds: uniqueStrings(reference?.collectionIds, 500, 100),
    createdAt: validDate(reference?.createdAt) ?? now,
    updatedAt: validDate(reference?.updatedAt) ?? now,
    lastUsedAt: validDate(reference?.lastUsedAt) ?? now,
    usageCount: Math.max(0, Math.trunc(Number(reference?.usageCount) || 0)),
    duplicateDecision: reference?.duplicateDecision === 'keep' ? 'keep' : null,
    mergedInto: typeof reference?.mergedInto === 'string' ? reference.mergedInto.slice(0, 128) : null,
  }
}

export function sanitizeSourceDocument(document, record = {}) {
  const now = new Date().toISOString()
  const documentId = String(document?.documentId ?? document?.id ?? record.id ?? '').slice(0, 128)
  return {
    documentId,
    id: documentId,
    fileName: String(document?.fileName ?? document?.name ?? record.name ?? 'Untitled.pdf').slice(0, 260),
    filePath: String(document?.filePath ?? document?.path ?? record.path ?? ''),
    metadata: sanitizeMetadata(document?.metadata),
    hasReferenceSection: document?.hasReferenceSection === true,
    referenceSectionStatus: ['not_checked', 'found', 'not_found', 'error'].includes(document?.referenceSectionStatus)
      ? document.referenceSectionStatus
      : 'not_checked',
    referenceHeadingPage: Math.max(0, Math.trunc(Number(document?.referenceHeadingPage) || 0)),
    extractedReferenceIds: uniqueStrings(document?.extractedReferenceIds, 10000, 128),
    checkedAt: validDate(document?.checkedAt) ?? now,
    error: clean(document?.error, 1000),
  }
}

export function isExportableReference(reference) {
  return ['reference_section', 'manual', 'metadata'].includes(reference?.extractionSource)
}

export function sanitizeMetadata(value) {
  const result = Object.fromEntries(SCALAR_FIELDS.map((field) => [field, clean(value?.[field], field === 'title' ? 2000 : 1000)]))
  result.authors = uniqueStrings(value?.authors, 100, 500)
  result.keywords = uniqueStrings(value?.keywords, 500, 300)
  result.referenceType = sanitizeReferenceType(value?.referenceType)
  result.doi = normalizeDoi(result.doi)
  result.isbn = result.isbn.replace(/[^0-9Xx-]/g, '').slice(0, 32)
  result.year = /^\d{4}$/.test(result.year) ? result.year : ''
  return result
}

export function effectiveReference(referenceRecord) {
  const reference = sanitizeReference(referenceRecord)
  const effective = {}
  for (const field of SCALAR_FIELDS) {
    effective[field] = reference.userOverrides[field]
      || reference.sourceMetadata[field]
      || reference.detectedMetadata[field]
      || ''
  }
  effective.title = effective.title || (reference.extractionSource ? clean(reference.rawText, 300) : cleanFileName(reference.sourceFileName))
  effective.authors = firstValidAuthors(
    reference.userOverrides.authors,
    reference.sourceMetadata.authors,
    reference.detectedMetadata.authors,
    effective.title,
  )
  effective.keywords = uniqueStrings([
    ...reference.sourceMetadata.keywords,
    ...reference.detectedMetadata.keywords,
    ...reference.userOverrides.keywords,
  ], 500, 300)
  effective.referenceType = reference.userOverrides.referenceType
    || reference.sourceMetadata.referenceType
    || reference.detectedMetadata.referenceType
    || detectReferenceType({ ...effective, rawText: reference.rawText })
  return {
    ...reference,
    ...effective,
    title: effective.title || 'Untitled',
    sourceFileName: reference.sourceFileName,
    sourceFilePath: reference.sourceFilePath,
    userOverrides: reference.userOverrides,
  }
}

export function generateCitation(referenceRecord, style) {
  const item = effectiveReference(referenceRecord)
  const citationStyle = STYLES.includes(style) ? style : 'apa'
  const title = item.title || 'Untitled'
  const year = item.year || 'n.d.'
  const authors = item.authors.length ? item.authors : ['Unknown Author']
  const source = item.journal || item.conference || item.publisher
  const details = [
    item.volume && `vol. ${item.volume}`,
    item.issue && `no. ${item.issue}`,
    item.pages && `pp. ${item.pages}`,
  ].filter(Boolean).join(', ')
  const doi = item.doi ? `https://doi.org/${item.doi}` : ''

  if (citationStyle === 'ieee') {
    return [ieeeAuthors(authors), `"${title},"`, source, details, year, doi]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }
  if (citationStyle === 'mla') {
    return [`${mlaAuthors(authors)}.`, `"${title}."`, source ? `${source},` : '', item.volume ? `vol. ${item.volume},` : '', item.issue ? `no. ${item.issue},` : '', `${year},`, item.pages ? `pp. ${item.pages}.` : '', doi]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }
  if (citationStyle === 'chicago') {
    return [`${chicagoAuthors(authors)}.`, `"${title}."`, source, details ? `${details}.` : '', `(${year}).`, doi]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }
  if (citationStyle === 'harvard') {
    return [`${harvardAuthors(authors)} (${year})`, `'${title}'`, source ? `${source},` : '', details, doi]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }
  return [`${apaAuthors(authors)} (${year}).`, `${title}.`, source ? `${source}${details ? `, ${details}` : ''}.` : '', doi]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

export function citationsFor(referenceRecord) {
  return Object.fromEntries(STYLES.map((style) => [style, generateCitation(referenceRecord, style)]))
}

export function validateReference(referenceRecord) {
  const reference = sanitizeReference(referenceRecord)
  const effective = effectiveReference(reference)
  const quality = citationQuality(reference)
  return {
    missingTitle: quality.missingFields.includes('Title'),
    missingAuthors: effective.authors.length === 0,
    missingYear: quality.missingFields.includes('Year'),
    missingDoiOrUrl: quality.missingFields.includes('DOI or URL'),
    missingSource: quality.missingFields.includes('Journal/Publisher/Conference'),
  }
}

export function citationQuality(referenceRecord) {
  const reference = sanitizeReference(referenceRecord)
  const item = effectiveReference(reference)
  const missingFields = []
  const hasAuthors = item.authors.length > 0
  const hasTitle = Boolean(reference.userOverrides.title || reference.sourceMetadata.title || reference.detectedMetadata.title || (reference.extractionSource && reference.rawText))
  const hasYear = Boolean(item.year)
  const hasDoiOrUrl = Boolean(item.doi || item.url || findUrl(reference.rawText))
  const hasSource = Boolean(item.journal || item.publisher || item.conference || /\b(journal|proceedings|conference|transactions|review|press|publisher|university|institute|department|ministry|agency)\b/i.test(reference.rawText))
  if (!hasAuthors) missingFields.push('Author')
  if (!hasTitle) missingFields.push('Title')
  if (!hasYear) missingFields.push('Year')
  if (!hasDoiOrUrl) missingFields.push('DOI or URL')
  if (!hasSource) missingFields.push('Journal/Publisher/Conference')
  const score = [hasAuthors, hasTitle, hasYear, hasDoiOrUrl, hasSource].filter(Boolean).length
  return {
    score,
    label: score === 5 ? 'Complete' : score >= 4 ? 'Good' : score >= 2 ? 'Incomplete' : 'Poor',
    missingFields,
  }
}

export function referenceStatusLabel(reference) {
  if (reference.confidence >= 0.75) return 'High'
  if (reference.confidence >= 0.45) return 'Medium'
  return 'Low'
}

export function sanitizeReferenceType(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return REFERENCE_TYPES.find((type) => type.toLowerCase() === normalized) ?? ''
}

export function detectReferenceType(reference) {
  const rawText = String(reference?.rawText ?? '')
  const text = [
    reference?.title,
    reference?.journal,
    reference?.conference,
    reference?.publisher,
    reference?.volume,
    reference?.issue,
    reference?.pages,
    reference?.doi,
    reference?.url,
    reference?.isbn,
    rawText,
    Array.isArray(reference?.keywords) ? reference.keywords.join(' ') : '',
  ].filter(Boolean).join(' ').toLowerCase()
  const hasUrl = /https?:\/\/|www\./i.test(rawText) || /https?:\/\/|www\./i.test(text)
  const hasJournalShape = Boolean(reference?.journal)
    || (Boolean(reference?.volume || reference?.issue || reference?.pages) && /\b(journal|review|transactions|vol\.|volume|issue|no\.|pp\.|pages)\b/i.test(text))
    || (/\b(journal|review|transactions)\b/i.test(text) && /\b\d+\s*(?:\(\d+\))?\s*,?\s*\d+[-–]\d+\b|\bpp\.\s*\d+/i.test(text))
  if (/\b(thesis|dissertation|doctoral|phd|master'?s thesis|msc thesis)\b/i.test(text)) return 'Thesis'
  if (hasJournalShape) return 'Journal'
  if (/\b(conference|proceedings|symposium|workshop|ieee|acm)\b/i.test(text) || reference?.conference) return 'Conference'
  if (reference?.isbn || /\bisbn(?:-1[03])?\b/i.test(text)) return 'Book'
  if (/\b(report|white paper|technical report|working paper|institution|institute|department|ministry|agency)\b/i.test(text)) return 'Report'
  if (hasUrl && !/\b(journal|conference|proceedings|report|thesis|dissertation|isbn)\b/i.test(text)) return 'Website'
  return 'Unknown'
}

export function findDuplicateGroups(references) {
  const buckets = new Map()
  for (const reference of references) {
    if (reference.duplicateDecision === 'keep' || reference.mergedInto) continue
    const item = effectiveReference(reference)
    const keys = [
      item.doi && `doi:${item.doi.toLowerCase()}`,
      item.isbn && `isbn:${item.isbn.replace(/-/g, '').toLowerCase()}`,
      item.title && `title:${normalize(item.title)}:${normalize(item.authors[0] ?? '')}`,
    ].filter(Boolean)
    for (const key of keys) {
      const values = buckets.get(key) ?? []
      values.push(reference.id)
      buckets.set(key, values)
    }
  }
  const seen = new Set()
  const groups = []
  for (const [key, ids] of buckets) {
    const unique = [...new Set(ids)]
    const signature = [...unique].sort().join('|')
    if (unique.length > 1 && !seen.has(signature)) {
      seen.add(signature)
      groups.push({ key, referenceIds: unique })
    }
  }
  return groups
}

export function referenceSearchText(reference, collectionNames = []) {
  const item = effectiveReference(reference)
  const quality = citationQuality(reference)
  return [item.title, item.authors.join(' '), item.year, item.referenceType, quality.label, quality.missingFields.join(' '), item.publisher, item.journal, item.conference, item.doi, item.url, item.isbn, item.keywords.join(' '), collectionNames.join(' ')]
    .join('\n').toLocaleLowerCase()
}

export function buildBibliography(references, style, format, documentName = 'Reference Library') {
  const citationStyle = STYLES.includes(style) ? style : 'apa'
  const sorted = [...references].sort((left, right) => {
    const a = effectiveReference(left)
    const b = effectiveReference(right)
    return (a.authors[0] || a.title).localeCompare(b.authors[0] || b.title)
  })
  if (format === 'bibtex') return buildBibliographyBibtex(sorted)
  if (format === 'ris') return buildBibliographyRis(sorted)
  const citations = sorted.map((reference) => generateCitation(reference, citationStyle))
  if (format === 'markdown') {
    return `# ${documentName}\n\nCitation style: ${citationStyle.toUpperCase()}\n\n${citations.map((citation) => `- ${citation}`).join('\n\n')}\n`
  }
  return `${documentName}\nCitation style: ${citationStyle.toUpperCase()}\nGenerated: ${new Date().toLocaleString()}\n\n${citations.join('\n\n')}`
}

export function buildBibliographyDocx(references, style, documentName = 'Reference Library') {
  const content = buildBibliography(references, style, 'docx', documentName)
  const paragraphs = content.split(/\r?\n/).map((line, index) =>
    `<w:p>${index === 0 ? '<w:pPr><w:pStyle w:val="Title"/></w:pPr>' : ''}<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
  )
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  return createStoredZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', documentXml],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`],
  ])
}

export function buildBibliographyBibtex(references) {
  return references.map((reference, index) => {
    const item = effectiveReference(reference)
    const type = bibtexType(item.referenceType)
    const key = bibtexKey(item, index)
    const fields = [
      ['title', item.title],
      ['author', item.authors.join(' and ')],
      ['year', item.year],
      ['journal', item.journal || item.conference],
      ['publisher', item.publisher],
      ['volume', item.volume],
      ['number', item.issue],
      ['pages', item.pages],
      ['doi', item.doi],
      ['url', item.url],
      ['isbn', item.isbn],
    ].filter(([, value]) => value)
    return `@${type}{${key},\n${fields.map(([name, value]) => `  ${name} = {${escapeBibtex(value)}},`).join('\n')}\n}`
  }).join('\n\n')
}

export function buildBibliographyRis(references) {
  return references.map((reference) => {
    const item = effectiveReference(reference)
    return [
      `TY  - ${risType(item.referenceType)}`,
      item.title && `TI  - ${item.title}`,
      ...item.authors.map((author) => `AU  - ${author}`),
      item.year && `PY  - ${item.year}`,
      item.journal && `JO  - ${item.journal}`,
      item.conference && `T2  - ${item.conference}`,
      item.publisher && `PB  - ${item.publisher}`,
      item.volume && `VL  - ${item.volume}`,
      item.issue && `IS  - ${item.issue}`,
      item.pages && `SP  - ${item.pages}`,
      item.doi && `DO  - ${item.doi}`,
      item.url && `UR  - ${item.url}`,
      item.isbn && `SN  - ${item.isbn}`,
      'ER  -',
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

export const citationStyles = STYLES
export const referenceTypes = REFERENCE_TYPES

function clean(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : '' }
function uniqueStrings(values, limit, itemLimit) { return [...new Set((Array.isArray(values) ? values : typeof values === 'string' ? values.split(/[,;\n]/) : []).map((value) => String(value).trim().slice(0, itemLimit)).filter(Boolean))].slice(0, limit) }
function validDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString() }
function normalizeDoi(value) { return String(value ?? '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').replace(/[.,;)]*$/, '').slice(0, 300) }
function findUrl(value) { return String(value ?? '').match(/https?:\/\/\S+|www\.\S+/i)?.[0]?.replace(/[.,;)]*$/, '') ?? '' }
function normalize(value) { return String(value).toLocaleLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }
function cleanFileName(value) { return String(value ?? '').replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() }
function firstValidAuthors(overrideAuthors, metadataAuthors, detectedAuthors, title) {
  for (const candidates of [overrideAuthors, metadataAuthors, detectedAuthors]) {
    const authors = candidates.filter((author) => isValidAuthor(author, title))
    if (authors.length) return authors
  }
  return []
}
function isValidAuthor(value, title) {
  const author = String(value ?? '').trim()
  if (!author || normalize(author) === normalize(title)) return false
  if (/^(unknown|anonymous|untitled|author)$/i.test(author) || /^microsoft word\b/i.test(author)) return false
  if (/\.(pdf|docx?)$/i.test(author) || /^https?:|doi:/i.test(author)) return false
  return author.split(/\s+/).length <= 10
}
function splitName(name) {
  const trimmed = name.trim()
  if (trimmed.includes(',')) {
    const [last, ...first] = trimmed.split(',')
    return { first: first.join(' ').trim(), last: last.trim() }
  }
  const parts = trimmed.split(/\s+/)
  return { first: parts.slice(0, -1).join(' '), last: parts.at(-1) || trimmed }
}
function initials(value) { return value.split(/\s+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase()}.`).join(' ') }
function apaAuthors(authors) { if (authors[0] === 'Unknown Author') return 'Unknown Author'; return authors.map((name) => { const { first, last } = splitName(name); return `${last}${first ? `, ${initials(first)}` : ''}` }).join(authors.length > 2 ? ', ' : ' & ') }
function harvardAuthors(authors) { if (authors[0] === 'Unknown Author') return 'Unknown Author'; return authors.map((name) => { const { first, last } = splitName(name); return `${last}${first ? `, ${initials(first)}` : ''}` }).join(', ') }
function ieeeAuthors(authors) { if (authors[0] === 'Unknown Author') return 'Unknown Author'; return authors.map((name) => { const { first, last } = splitName(name); return `${initials(first)} ${last}`.trim() }).join(', ') }
function mlaAuthors(authors) { if (authors[0] === 'Unknown Author') return 'Unknown Author'; if (authors.length > 2) return `${authors[0]}, et al`; const first = splitName(authors[0]); return [`${first.last}${first.first ? `, ${first.first}` : ''}`, ...authors.slice(1)].join(', and ') }
function chicagoAuthors(authors) { return mlaAuthors(authors) }
function escapeXml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;') }
function escapeBibtex(value) { return String(value).replace(/[{}\\]/g, (match) => `\\${match}`) }
function bibtexType(type) {
  if (type === 'Conference') return 'inproceedings'
  if (type === 'Book') return 'book'
  if (type === 'Thesis') return 'phdthesis'
  if (type === 'Report') return 'techreport'
  if (type === 'Website') return 'misc'
  return 'article'
}
function risType(type) {
  if (type === 'Conference') return 'CONF'
  if (type === 'Book') return 'BOOK'
  if (type === 'Thesis') return 'THES'
  if (type === 'Report') return 'RPRT'
  if (type === 'Website') return 'ELEC'
  if (type === 'Journal') return 'JOUR'
  return 'GEN'
}
function bibtexKey(item, index) {
  const author = normalize(item.authors[0] ?? 'unknown').split(' ').at(-1) || 'unknown'
  const title = normalize(item.title).split(' ').find(Boolean) || 'reference'
  return `${author}${item.year || 'nd'}${title}${index ? index + 1 : ''}`.replace(/[^a-z0-9]/gi, '')
}
function createStoredZip(files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name)
    const contentBuffer = Buffer.from(content)
    const crc = crc32(contentBuffer)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4); localHeader.writeUInt16LE(0x0800, 6); localHeader.writeUInt32LE(crc, 14); localHeader.writeUInt32LE(contentBuffer.length, 18); localHeader.writeUInt32LE(contentBuffer.length, 22); localHeader.writeUInt16LE(nameBuffer.length, 26)
    localParts.push(localHeader, nameBuffer, contentBuffer)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0); centralHeader.writeUInt16LE(20, 4); centralHeader.writeUInt16LE(20, 6); centralHeader.writeUInt16LE(0x0800, 8); centralHeader.writeUInt32LE(crc, 16); centralHeader.writeUInt32LE(contentBuffer.length, 20); centralHeader.writeUInt32LE(contentBuffer.length, 24); centralHeader.writeUInt16LE(nameBuffer.length, 28); centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuffer)
    offset += localHeader.length + nameBuffer.length + contentBuffer.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) } return (crc ^ 0xffffffff) >>> 0 }
