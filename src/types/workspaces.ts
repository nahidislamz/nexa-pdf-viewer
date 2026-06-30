import type { GlobalSearchLibraryInfo } from './globalSearch'
import type { HighlightCategory } from './highlights'
import type { HighlightLibraryEntry } from './highlightLibrary'
import type { ReferenceItem } from './references'

export type WorkspaceTemplate = 'research' | 'dissertation' | 'coursework' | 'legal' | 'blank'

export type WorkspaceSummary = {
  id: string
  name: string
  description: string
  color: string
  icon: string
  template: WorkspaceTemplate
  createdAt: string
  updatedAt: string
  documentCount: number
  referenceCount: number
  highlightCount: number
  noteCount: number
}

export type WorkspaceDocument = {
  documentId: string
  name: string
  filePath: string
  fileSize: number
  modifiedAt: number
  missing: boolean
}

export type WorkspaceActivity = {
  id: string
  type: string
  label: string
  createdAt: string
  documentId?: string
  count?: number
}

export type WorkspaceDetails = WorkspaceSummary & {
  documents: WorkspaceDocument[]
  references: ReferenceItem[]
  highlights: HighlightLibraryEntry[]
  notes: HighlightLibraryEntry[]
  savedSearches: GlobalSearchLibraryInfo['savedSearches']
  activities: WorkspaceActivity[]
  stats: {
    documents: number
    references: number
    highlights: number
    notes: number
    bookmarks: number
    savedSearches: number
    ocrCompletedPages: number
    ocrPendingPages: number
    ocrFailedPages: number
    categories: Record<HighlightCategory, number>
  }
}

export type WorkspaceList = {
  activeWorkspaceId: string
  workspaces: WorkspaceSummary[]
}

export type WorkspaceCreateInput = {
  name: string
  description: string
  color: string
  icon: string
  template: WorkspaceTemplate
}
