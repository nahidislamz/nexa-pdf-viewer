export type SavedSignature = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  type: 'drawn' | 'uploaded' | 'typed'
  isDefault: boolean
  imageDataUrl: string
  width: number
  height: number
}

export type SignaturePlacement = {
  id: string
  signatureId: string
  documentId: string
  pageNumber: number
  x: number
  y: number
  width: number
  height: number
  xRatio?: number
  yRatio?: number
  widthRatio?: number
  heightRatio?: number
  pageRotation?: number
  rotation: number
  opacity: number
  createdAt: string
}

export type FillSignTool = 'text' | 'date' | 'initials' | 'checkbox'
export type FillSignColor = 'black' | 'blue' | 'dark-gray'
export type FillSignDateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD'

export type FillSignField = {
  id: string
  documentId: string
  pageNumber: number
  type: FillSignTool
  text: string
  checked?: boolean
  x: number
  y: number
  width: number
  height: number
  xRatio?: number
  yRatio?: number
  widthRatio?: number
  heightRatio?: number
  pageRotation?: number
  fontSize: number
  color: FillSignColor
  dateFormat?: FillSignDateFormat
  createdAt: string
}
