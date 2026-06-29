export type CitationStyle = 'apa' | 'harvard' | 'ieee' | 'mla' | 'chicago'
export type ReferenceType = 'Journal' | 'Conference' | 'Book' | 'Thesis' | 'Report' | 'Website' | 'Unknown'
export type ReferenceQualityLabel = 'Complete' | 'Good' | 'Incomplete' | 'Poor'
export type ReferenceMetadata = {
  title: string
  authors: string[]
  year: string
  publisher: string
  journal: string
  conference: string
  volume: string
  issue: string
  pages: string
  doi: string
  url: string
  isbn: string
  keywords: string[]
  referenceType: ReferenceType | ''
}
export type ReferenceSectionStatus = 'not_checked' | 'found' | 'not_found' | 'error'
export type SourceDocumentReferenceStatus = {
  documentId: string
  fileName: string
  filePath: string
  metadata: ReferenceMetadata
  hasReferenceSection: boolean
  referenceSectionStatus: ReferenceSectionStatus
  referenceHeadingPage: number
  extractedReferenceIds: string[]
  checkedAt: string
  error: string
}
export type ReferenceCollection = { id: string; name: string; description: string; color: string; createdAt: string; count?: number }
export type ReferenceItem = ReferenceMetadata & {
  id: string
  documentId: string
  sourceDocumentId: string
  documentName: string
  filePath: string
  sourceFileName: string
  sourceFilePath: string
  rawText: string
  confidence: number
  doiLookupSource: string
  doiLookupAt: string
  qualityScore: number
  qualityLabel: ReferenceQualityLabel
  missingFields: string[]
  referenceType: ReferenceType
  extractionSource: 'reference_section' | 'manual' | 'metadata' | null
  sourceMetadata: ReferenceMetadata
  detectedMetadata: ReferenceMetadata
  userOverrides: ReferenceMetadata
  metadata: ReferenceMetadata
  overrides: ReferenceMetadata
  collectionIds: string[]
  collections: ReferenceCollection[]
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  usageCount: number
  citations: Record<CitationStyle, string>
  highlightCount: number
  noteCount: number
  workspaceIds: string[]
  missing: boolean
}
export type ReferenceFilters = { author: string; year: string; publisher: string; keyword: string; workspaceId: string; collectionId: string; missingMetadata: boolean; referenceType?: ReferenceType | 'all'; hasDoi?: boolean; duplicateCandidates?: boolean }
export type ReferenceQueryResponse = {
  references: ReferenceItem[]
  total: number
  offset: number
  facets: { authors: string[]; publishers: string[]; years: string[]; keywords: string[] }
  collections: ReferenceCollection[]
  workspaces: Array<{ id: string; name: string; count: number }>
  activeWorkspaceId: string
  stats: { references: number; authors: number; publishers: number; recent: number; missingMetadata: number; filtered: number; journals?: number; conferences?: number; books?: number; reports?: number; withDoi?: number; duplicateCandidates?: number }
  sourceDocuments: SourceDocumentReferenceStatus[]
  mostUsed: Array<{ id: string; title: string; usageCount: number }>
}
export type ReferenceDuplicateGroup = { key: string; referenceIds: string[]; references: ReferenceItem[] }
export type ExtractedReferenceUpsertResult = { sourceDocument: SourceDocumentReferenceStatus; references: ReferenceItem[] }
