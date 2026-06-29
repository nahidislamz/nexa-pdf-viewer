import type { HighlightCategory, HighlightColor } from './highlights'

export type HighlightLibraryEntry = {
  key: string
  documentKey: string
  documentId: string
  documentName: string
  filePath: string
  fileSize: number
  fileModifiedAt: number
  highlightId: string
  pageNumber: number
  text: string
  note: string
  color: HighlightColor
  category: HighlightCategory
  createdDate: string
  modifiedDate: string
  searchText?: string
}

export type HighlightLibrary = {
  entries: HighlightLibraryEntry[]
  stats: {
    totalDocuments: number
    totalHighlights: number
    categories: Record<HighlightCategory, number>
  }
}
