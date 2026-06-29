import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { ReferenceMetadata } from '../types/references'

type SourceDocument = { id: string; name: string; fileSize: number; modifiedAt: number }
type ExtractedReference = Partial<ReferenceMetadata> & {
  rawText: string
  url?: string
  confidence: number
}
type ReferenceExtractionResult = {
  sourceMetadata: Partial<ReferenceMetadata>
  detectedMetadata: Partial<ReferenceMetadata>
  hasReferenceSection: boolean
  referenceSectionStatus: 'found' | 'not_found' | 'error'
  referenceHeadingPage: number
  references: ExtractedReference[]
  candidateEntries: number
  rejectedEntries: number
  rejectedReasons: string[]
}

type TextItemLike = { str?: string; transform?: number[] }
type PageLines = { pageNumber: number; lines: string[] }

const completed = new Set<string>()
const pending = new Map<string, Promise<void>>()
const HEADING_PATTERN = /^(?:\d+\.?\s*)?(references|bibliography|works cited|reference list|literature cited|sources)$/i
const MAX_REFERENCE_SCAN_PAGES = 30

export function extractAndStoreReference(pdf: PDFDocumentProxy, document: SourceDocument) {
  const identity = `${document.id}:${document.fileSize}:${document.modifiedAt}`
  if (completed.has(identity)) return Promise.resolve()
  const existing = pending.get(identity)
  if (existing) return existing
  const task = extractReferenceMetadata(pdf, document.name)
    .then((extracted) => window.electronAPI.upsertExtractedReference({ documentId: document.id, ...extracted }))
    .then(() => { completed.add(identity) })
    .finally(() => pending.delete(identity))
  pending.set(identity, task)
  return task
}

async function extractReferenceMetadata(pdf: PDFDocumentProxy, fileName: string): Promise<ReferenceExtractionResult> {
  const [{ info, metadata }, firstPage] = await Promise.all([
    pdf.getMetadata(),
    getPageLines(pdf, 1),
  ])
  const values = info as Record<string, unknown>
  const firstPageText = firstPage.lines.join('\n')
  const metadataTitle = text(values.Title, metadata?.get('dc:title'))
  const metadataDate = text(values.CreationDate, metadata?.get('prism:publicationdate'), metadata?.get('xmp:createdate'))
  const sourceMetadata: Partial<ReferenceMetadata> = {
    title: metadataTitle,
    authors: splitAuthors(text(values.Author, metadata?.get('dc:creator')), metadataTitle),
    year: detectYear(metadataDate),
    publisher: text(values.Publisher, metadata?.get('dc:publisher'), metadata?.get('prism:publisher')),
    journal: text(values.Journal, metadata?.get('prism:publicationname')),
    conference: text(values.Conference, metadata?.get('prism:event')),
    volume: text(values.Volume, metadata?.get('prism:volume')),
    issue: text(values.Issue, metadata?.get('prism:number')),
    pages: text(values.Pages, metadata?.get('prism:pageRange')),
    doi: detectDoi(text(metadata?.get('prism:doi'), metadata?.get('dc:identifier'))),
    isbn: detectIsbn(text(values.ISBN, metadata?.get('prism:isbn'))),
    keywords: splitKeywords(text(values.Keywords, metadata?.get('pdf:keywords'), metadata?.get('dc:subject'))),
  }
  const detectedMetadata: Partial<ReferenceMetadata> = {
    title: titleHeuristic(firstPage.lines, fileName),
    authors: [],
    year: detectYear(firstPageText),
    doi: detectDoi(firstPageText),
    isbn: detectIsbn(firstPageText),
    keywords: [],
  }

  try {
    const pages = await getReferenceScanPages(pdf)
    const section = findReferenceSection(pages, pdf.numPages)
    if (!section) {
      return {
        sourceMetadata,
        detectedMetadata,
        hasReferenceSection: false,
        referenceSectionStatus: 'not_found',
        referenceHeadingPage: 0,
        references: [],
        candidateEntries: 0,
        rejectedEntries: 0,
        rejectedReasons: ['No valid reference heading found near document end.'],
      }
    }

    const candidates = splitReferenceEntries(section.lines)
    const rejectedReasons: string[] = []
    const references = candidates.flatMap((rawText) => {
      const evidence = citationEvidence(rawText)
      if (evidence.score < 2) {
        rejectedReasons.push(`${evidence.reason}: ${rawText.slice(0, 120)}`)
        return []
      }
      return [parseReferenceEntry(rawText, evidence.score)]
    })
    const found = references.length >= 2
    return {
      sourceMetadata,
      detectedMetadata,
      hasReferenceSection: found,
      referenceSectionStatus: found ? 'found' : 'not_found',
      referenceHeadingPage: found ? section.pageNumber : 0,
      references: found ? references : [],
      candidateEntries: candidates.length,
      rejectedEntries: candidates.length - references.length,
      rejectedReasons,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      sourceMetadata,
      detectedMetadata,
      hasReferenceSection: false,
      referenceSectionStatus: 'error',
      referenceHeadingPage: 0,
      references: [],
      candidateEntries: 0,
      rejectedEntries: 0,
      rejectedReasons: [reason],
    }
  }
}

async function getReferenceScanPages(pdf: PDFDocumentProxy) {
  const startPage = Math.max(1, pdf.numPages - MAX_REFERENCE_SCAN_PAGES + 1)
  const pages: PageLines[] = []
  for (let pageNumber = startPage; pageNumber <= pdf.numPages; pageNumber += 1) {
    pages.push(await getPageLines(pdf, pageNumber))
  }
  return pages
}

async function getPageLines(pdf: PDFDocumentProxy, pageNumber: number): Promise<PageLines> {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  const rows = new Map<number, Array<{ x: number; text: string }>>()
  for (const item of content.items as TextItemLike[]) {
    const value = String(item.str ?? '').replace(/\s+/g, ' ').trim()
    if (!value) continue
    const y = Math.round(Number(item.transform?.[5]) || 0)
    const x = Number(item.transform?.[4]) || 0
    rows.set(y, [...(rows.get(y) ?? []), { x, text: value }])
  }
  const lines = [...rows.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([, row]) => row.sort((left, right) => left.x - right.x).map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return { pageNumber, lines }
}

function findReferenceSection(pages: PageLines[], totalPages: number) {
  const earliestAllowedPage = Math.max(1, Math.floor(totalPages * 0.45))
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]
    if (page.pageNumber < earliestAllowedPage) continue
    for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
      const line = page.lines[lineIndex].replace(/[:.]+$/, '').trim()
      if (!HEADING_PATTERN.test(line)) continue
      const sectionLines = [
        ...page.lines.slice(lineIndex + 1),
        ...pages.slice(pageIndex + 1).flatMap((candidate) => candidate.lines),
      ].filter((candidate) => !/^(appendix|appendices|acknowledg(e)?ments?|index)$/i.test(candidate.trim()))
      return { pageNumber: page.pageNumber, lines: sectionLines }
    }
  }
  return null
}

function splitReferenceEntries(lines: string[]) {
  const entries: string[] = []
  let current: string[] = []
  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    if (isLikelyNewReferenceStart(line) && current.join(' ').length > 40) {
      entries.push(current.join(' ').replace(/\s+/g, ' ').trim())
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.join(' ').length > 40) entries.push(current.join(' ').replace(/\s+/g, ' ').trim())
  return entries
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length >= 45 && entry.length <= 5000)
    .slice(0, 2000)
}

function isLikelyNewReferenceStart(line: string) {
  return /^\s*(?:\[\d+\]|\d+[.)])\s+/.test(line)
    || /^[\p{Lu}][\p{L}'-]+,\s+(?:[\p{Lu}]\.|[\p{Lu}][\p{L}'-]+).{0,120}(?:\(\d{4}\)|\d{4})/u.test(line)
    || /^[\p{Lu}][\p{L}'-]+\s+(?:&|and)\s+[\p{Lu}][\p{L}'-]+.{0,120}(?:\(\d{4}\)|\d{4})/u.test(line)
}

function citationEvidence(rawText: string) {
  const checks = [
    [/(?:\(\s*(?:19|20)\d{2}[a-z]?\s*\)|\b(?:19|20)\d{2}[a-z]?\b)/i.test(rawText), 'year'],
    [/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i.test(rawText), 'doi'],
    [/https?:\/\/|www\./i.test(rawText), 'url'],
    [/^\s*(?:\[\d+\]|\d+[.)])/.test(rawText), 'numbered marker'],
    [/^[\p{Lu}][\p{L}'-]+,\s+(?:[\p{Lu}]\.|[\p{Lu}][\p{L}'-]+)/u.test(rawText) || /\b(?:et al\.|and|&)\b/i.test(rawText), 'author pattern'],
    [/[“"].{8,200}[”"]/.test(rawText) || rawText.split(/[.!?]/).some((part) => part.trim().split(/\s+/).length >= 5), 'title-like text'],
    [/\b(journal|proceedings|conference|press|publisher|transactions|review|vol\.|volume|pp\.|pages)\b/i.test(rawText), 'source clue'],
  ] as const
  const matched = checks.filter(([ok]) => ok).map(([, label]) => label)
  return { score: matched.length, reason: matched.length ? `evidence ${matched.join(', ')}` : 'not citation-like' }
}

function parseReferenceEntry(rawText: string, evidenceScore: number): ExtractedReference {
  const year = detectYear(rawText)
  const doi = detectDoi(rawText)
  const url = rawText.match(/https?:\/\/\S+|www\.\S+/i)?.[0]?.replace(/[.,;)]*$/, '') ?? ''
  const authors = parseReferenceAuthors(rawText)
  const title = parseReferenceTitle(rawText, year)
  return {
    rawText,
    title,
    authors,
    year,
    journal: detectSource(rawText),
    doi,
    url,
    confidence: Math.min(0.95, Math.max(0.35, evidenceScore / 6)),
  }
}

function parseReferenceAuthors(rawText: string) {
  const withoutMarker = rawText.replace(/^\s*(?:\[\d+\]|\d+[.)])\s+/, '')
  const beforeYear = withoutMarker.split(/(?:\(\s*(?:19|20)\d{2}[a-z]?\s*\)|\b(?:19|20)\d{2}[a-z]?\b)/i)[0]?.replace(/[. ]+$/, '') ?? ''
  if (!beforeYear || beforeYear.length > 220) return []
  return splitAuthors(beforeYear, '')
}

function parseReferenceTitle(rawText: string, year: string) {
  const quoted = rawText.match(/[“"]([^”"]{8,240})[”"]/)
  if (quoted?.[1]) return quoted[1].trim()
  const afterYear = year ? rawText.split(year).slice(1).join(year).replace(/^[).,\s]+/, '') : ''
  const candidate = (afterYear || rawText)
    .replace(/^\s*(?:\[\d+\]|\d+[.)])\s+/, '')
    .split(/(?:\.|,)\s+(?:Journal|Proceedings|In |IEEE|ACM|Springer|Elsevier|Wiley|Oxford|Cambridge)\b/i)[0]
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
  return candidate.length >= 8 && candidate.length <= 300 ? candidate : ''
}

function detectSource(rawText: string) {
  const match = rawText.match(/\b(?:Journal|Proceedings|Transactions|Review|Conference|Press|Publisher|IEEE|ACM|Springer|Elsevier|Wiley|Oxford|Cambridge)[^.,;)]{0,120}/i)
  return match?.[0]?.trim() ?? ''
}

function text(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value)) {
      const result = value.filter((item) => typeof item === 'string').join(', ').trim()
      if (result) return result
    }
  }
  return ''
}

function titleHeuristic(lines: string[], fileName: string) {
  const fileTitle = normalize(fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '))
  return lines.find((line) => {
    const normalized = normalize(line)
    return line.length >= 12
      && line.length <= 300
      && normalized !== fileTitle
      && !/^(abstract|introduction|doi|https?:|references|bibliography)/i.test(line)
  }) ?? ''
}

function splitAuthors(value: string, title: string) {
  const normalizedTitle = normalize(title)
  return [...new Set(value
    .split(/\s*(?:;|\band\b|&)\s*|,(?=\s*[\p{Lu}][\p{L}'-]+\s+[\p{Lu}])/iu)
    .map((author) => author.trim().replace(/^by\s+/i, '').replace(/[. ]+$/, ''))
    .filter((author) => {
      if (author.length < 2 || normalize(author) === normalizedTitle) return false
      if (/^(unknown|anonymous|author)$/i.test(author) || /^microsoft word\b/i.test(author)) return false
      if (/\.(pdf|docx?)$/i.test(author) || /^https?:|doi:/i.test(author)) return false
      return author.split(/\s+/).length <= 10
    }))].slice(0, 100)
}
function splitKeywords(value: string) { return [...new Set(value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 500) }
function detectDoi(value: string) { return value.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]?.replace(/[.,;)]*$/, '') ?? '' }
function detectIsbn(value: string) { return value.match(/(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][ -]?)?\d[\d -]{8,16}[\dX])/i)?.[1]?.replace(/\s+/g, '-') ?? '' }
function detectYear(value: string) { return value.match(/(?:19|20)\d{2}/)?.[0] ?? '' }
function normalize(value: string) { return value.toLocaleLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() }
