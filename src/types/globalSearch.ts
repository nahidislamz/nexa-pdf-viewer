import type { HighlightCategory, HighlightColor } from './highlights'

export type GlobalSearchResultType =
  | 'pdf-text'
  | 'highlight'
  | 'note'
  | 'bookmark'
  | 'file'
  | 'metadata'
  | 'reference'

export type GlobalSearchFilters = {
  type: GlobalSearchResultType | 'all'
  category: HighlightCategory | 'all'
  documentId: string
  dateStart: string
  dateEnd: string
  scope: 'workspace' | 'all'
}

export type GlobalSearchResult = {
  id: string
  type: GlobalSearchResultType
  documentId: string
  documentKey: string | null
  documentName: string
  filePath: string
  pageNumber: number
  text: string
  preview: string
  matchText?: string
  highlightId?: string
  category?: HighlightCategory
  color?: HighlightColor
  createdDate?: string | null
  modifiedDate?: string | null
  score: number
}

export type GlobalSearchResponse = {
  query: string
  results: GlobalSearchResult[]
  total: number
  counts: {
    total: number
    highlights: number
    notes: number
    documents: number
    types: Partial<Record<GlobalSearchResultType, number>>
  }
  truncated: boolean
  durationMs: number
}

export type SavedGlobalSearch = {
  id: string
  name: string
  query: string
  filters: GlobalSearchFilters
  createdAt: string
  workspaceId?: string | null
}

export type GlobalSearchLibraryInfo = {
  documents: Array<{
    documentId: string
    name: string
    filePath: string
    status: 'pending' | 'complete'
    indexedPages: number
    totalPages: number
    indexedAt: string | null
  }>
  recentSearches: string[]
  savedSearches: SavedGlobalSearch[]
  activeWorkspace?: { id: string; name: string; documentIds: string[] }
}

export const EMPTY_GLOBAL_SEARCH_RESPONSE: GlobalSearchResponse = {
  query: '',
  results: [],
  total: 0,
  counts: { total: 0, highlights: 0, notes: 0, documents: 0, types: {} },
  truncated: false,
  durationMs: 0,
}
