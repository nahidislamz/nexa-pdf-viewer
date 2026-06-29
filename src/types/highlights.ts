export type HighlightColor = 'yellow' | 'green' | 'blue' | 'purple'
export type HighlightCategory = 'important' | 'research' | 'reference' | 'question'

export type HighlightRectangle = {
  x: number
  y: number
  width: number
  height: number
}

export type PdfHighlight = {
  id: string
  pageNumber: number
  text: string
  color: HighlightColor
  category: HighlightCategory
  note: string
  rectangles: HighlightRectangle[]
  rotation: number
  createdDate: string
  modifiedDate?: string
}

export type PendingHighlightSelection = {
  pageNumber: number
  text: string
  rectangles: HighlightRectangle[]
  rotation: number
  toolbarX: number
  toolbarY: number
}
