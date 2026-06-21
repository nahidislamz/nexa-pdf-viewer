export type HighlightColor = 'yellow' | 'green' | 'blue'

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
  rectangles: HighlightRectangle[]
  rotation: number
  createdDate: string
}

export type PendingHighlightSelection = {
  pageNumber: number
  text: string
  rectangles: HighlightRectangle[]
  rotation: number
  toolbarX: number
  toolbarY: number
}
