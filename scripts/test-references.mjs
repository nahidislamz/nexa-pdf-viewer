import assert from 'node:assert/strict'
import {
  buildBibliography,
  buildBibliographyBibtex,
  buildBibliographyDocx,
  buildBibliographyRis,
  citationQuality,
  citationsFor,
  detectReferenceType,
  effectiveReference,
  findDuplicateGroups,
  generateCitation,
  isExportableReference,
  sanitizeReference,
  sanitizeSourceDocument,
  validateReference,
} from '../electron/references.js'

const record = { id: 'doc-a', name: 'paper.pdf', path: 'C:\\Library\\paper.pdf' }
const reference = sanitizeReference({
  sourceMetadata: {
    title: 'Cyber Security Management',
    authors: ['Jane Smith', 'Alan Jones'],
    year: '2024',
    journal: 'IEEE Transactions on Security',
    volume: '8',
    issue: '2',
    pages: '12-30',
    doi: 'https://doi.org/10.1109/XYZ.2025.123456.',
    keywords: ['Zero Trust', 'Risk Management'],
  },
}, record)

assert.equal(reference.metadata.doi, '10.1109/XYZ.2025.123456')
assert.equal(effectiveReference(reference).title, 'Cyber Security Management')
assert.equal(effectiveReference(reference).referenceType, 'Journal')
assert.deepEqual(citationQuality(reference), { score: 5, label: 'Complete', missingFields: [] })
const citations = citationsFor(reference)
assert.match(citations.apa, /Smith, J\./)
assert.match(citations.ieee, /^J\. Smith/)
assert.match(citations.mla, /Cyber Security Management/)
assert.match(citations.chicago, /2024/)
assert.match(citations.harvard, /Smith/)
assert.equal(citations.apa, generateCitation(reference, 'apa'))

const overridden = sanitizeReference({
  ...reference,
  userOverrides: { title: 'Corrected Security Title', authors: ['Maria Ahmed'], year: '2025' },
}, record)
assert.equal(effectiveReference(overridden).title, 'Corrected Security Title')
assert.match(generateCitation(overridden, 'apa'), /^Ahmed, M\. \(2025\)\. Corrected Security Title\./)

const detected = sanitizeReference({
  detectedMetadata: { title: 'Detected First Page Title', year: '2022' },
}, { id: 'doc-c', name: 'fallback_file.pdf', path: 'C:\\Library\\fallback_file.pdf' })
assert.equal(effectiveReference(detected).title, 'Detected First Page Title')
assert.equal(effectiveReference(detected).year, '2022')
assert.match(generateCitation(detected, 'apa'), /^Unknown Author \(2022\)/)

const filenameFallback = sanitizeReference({}, { id: 'doc-d', name: 'clean_file-name.pdf', path: 'C:\\Library\\clean_file-name.pdf' })
assert.equal(effectiveReference(filenameFallback).title, 'clean file name')
assert.equal(effectiveReference(filenameFallback).year, '')
assert.match(generateCitation(filenameFallback, 'apa'), /^Unknown Author \(n\.d\.\)\. clean file name\./)
assert.deepEqual(validateReference(filenameFallback), { missingTitle: true, missingAuthors: true, missingYear: true, missingDoiOrUrl: true, missingSource: true })
assert.equal(citationQuality(filenameFallback).label, 'Poor')
assert.ok(citationQuality(filenameFallback).missingFields.includes('DOI or URL'))
assert.equal(isExportableReference(filenameFallback), false)

const sourceDocument = sanitizeSourceDocument({ documentId: 'doc-d', fileName: 'clean_file-name.pdf', referenceSectionStatus: 'not_found' })
assert.equal(sourceDocument.hasReferenceSection, false)
assert.equal(sourceDocument.extractedReferenceIds.length, 0)

const badAuthor = sanitizeReference({ sourceMetadata: { title: 'Title Words Used As Author', authors: ['Title Words Used As Author'], year: '2024' } }, { id: 'doc-e', name: 'safe.pdf', path: 'safe.pdf' })
assert.match(generateCitation(badAuthor, 'apa'), /^Unknown Author/)

const extractedEntry = sanitizeReference({
  id: 'ref-1',
  documentId: 'doc-f',
  rawText: 'Smith, J. (2021). Cyber security governance in financial services. Journal of Security, 12(2), 1-15.',
  confidence: 0.8,
  extractionSource: 'reference_section',
  sourceMetadata: { authors: ['Jane Smith'], year: '2021' },
}, { id: 'doc-f', name: 'thesis.pdf', path: 'C:\\Library\\thesis.pdf' })
assert.equal(isExportableReference(extractedEntry), true)
assert.equal(effectiveReference(extractedEntry).referenceType, 'Journal')
assert.equal(citationQuality(extractedEntry).score, 4)
assert.ok(!generateCitation(extractedEntry, 'apa').includes('thesis'))
assert.match(generateCitation(extractedEntry, 'apa'), /Cyber security governance/)
assert.match(generateCitation(extractedEntry, 'harvard'), /^Smith, J\. \(2021\)/)

const ieeeEntry = sanitizeReference({
  id: 'ref-ieee',
  documentId: 'doc-ieee',
  rawText: '[1] J. Smith and A. Jones, "Zero trust architecture," IEEE Security & Privacy, vol. 21, no. 3, pp. 10-20, 2023.',
  confidence: 0.9,
  extractionSource: 'reference_section',
  sourceMetadata: {
    title: 'Zero trust architecture',
    authors: ['Jane Smith', 'Alan Jones'],
    year: '2023',
    journal: 'IEEE Security & Privacy',
    volume: '21',
    issue: '3',
    pages: '10-20',
  },
}, { id: 'doc-ieee', name: 'ieee.pdf', path: 'C:\\Library\\ieee.pdf' })
assert.equal(effectiveReference(ieeeEntry).referenceType, 'Journal')
assert.match(generateCitation(ieeeEntry, 'ieee'), /^J\. Smith, A\. Jones "Zero trust architecture," IEEE Security & Privacy/)

const websiteEntry = sanitizeReference({ extractionSource: 'manual', sourceMetadata: { title: 'Security Guidance', authors: ['Web Team'], year: '2024', url: 'https://example.com/security-guidance', publisher: 'Example Org' } }, { id: 'web-a', name: 'manual.pdf', path: '' })
assert.equal(effectiveReference(websiteEntry).referenceType, 'Website')
assert.equal(citationQuality(websiteEntry).score, 5)
assert.equal(isExportableReference(websiteEntry), true)
const lookupStamped = sanitizeReference({ ...websiteEntry, doiLookupSource: 'doi.org CSL JSON', doiLookupAt: '2026-01-02T03:04:05.000Z' })
assert.equal(lookupStamped.doiLookupSource, 'doi.org CSL JSON')
assert.equal(lookupStamped.doiLookupAt, '2026-01-02T03:04:05.000Z')
assert.equal(detectReferenceType({ rawText: 'Proceedings of the ACM Conference on Security, pp. 12-18.' }), 'Conference')
assert.equal(detectReferenceType({ rawText: 'Doctoral dissertation, University of Example, 2022.' }), 'Thesis')
assert.equal(detectReferenceType({ rawText: 'Example Book Title. ISBN 978-1-234-56789-7.' }), 'Book')
assert.equal(detectReferenceType({ rawText: 'Technical report, National Institute of Standards and Technology.' }), 'Report')
assert.equal(detectReferenceType({ rawText: 'https://example.com/security-guidance' }), 'Website')

const duplicate = sanitizeReference({ ...reference, id: 'doc-b', documentId: 'doc-b' }, { id: 'doc-b', name: 'copy.pdf', path: 'C:\\Library\\copy.pdf' })
const groups = findDuplicateGroups([reference, duplicate])
assert.ok(groups.some((group) => group.referenceIds.includes('doc-a') && group.referenceIds.includes('doc-b')))

const markdown = buildBibliography([reference], 'apa', 'markdown', 'Research Bibliography')
assert.match(markdown, /^# Research Bibliography/)
assert.match(markdown, /Cyber Security Management/)
for (const style of ['apa', 'harvard', 'ieee', 'mla', 'chicago']) {
  const preview = citationsFor(overridden)[style]
  for (const format of ['markdown', 'text']) {
    const exported = buildBibliography([overridden], style, format, 'Exact Citation Test')
    assert.ok(exported.includes(preview), `${style} ${format} export must contain the exact preview citation`)
  }
  const docxXml = decodeXml(readStoredZipEntry(buildBibliographyDocx([overridden], style, 'Exact Citation Test'), 'word/document.xml'))
  assert.ok(docxXml.includes(preview), `${style} DOCX XML must contain the exact preview citation`)
}
const bibtex = buildBibliography([reference, ieeeEntry], 'apa', 'bibtex', 'Structured Export Test')
assert.equal(bibtex, buildBibliographyBibtex([reference, ieeeEntry]))
assert.match(bibtex, /@article\{smith2024cyber/)
assert.match(bibtex, /doi = \{10\.1109\/XYZ\.2025\.123456\}/)
const ris = buildBibliography([reference, ieeeEntry], 'apa', 'ris', 'Structured Export Test')
assert.equal(ris, buildBibliographyRis([reference, ieeeEntry]))
assert.match(ris, /TY  - JOUR/)
assert.match(ris, /TI  - Cyber Security Management/)
assert.match(ris, /ER  -/)

function readStoredZipEntry(buffer, requestedName) {
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const contentStart = nameStart + nameLength + extraLength
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')
    if (name === requestedName) return buffer.subarray(contentStart, contentStart + size).toString('utf8')
    offset = contentStart + size
  }
  throw new Error(`Missing ZIP entry: ${requestedName}`)
}
function decodeXml(value) { return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&') }

console.log('Reference and citation regression tests passed.')
