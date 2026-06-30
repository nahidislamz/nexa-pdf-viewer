import { useEffect, useMemo, useRef } from 'react'
import { transformHighlightRectangle } from '../../utils/highlights'

type OcrLanguage = 'eng' | 'ben' | 'ara' | 'hin' | 'urd' | 'fra' | 'deu' | 'spa'

export type OcrTextLayerResult = {
  pageNumber: number
  text: string
  confidence: number
  imageWidth: number
  imageHeight: number
  pageRotation: number
  words: Array<{ text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }>
  lines: Array<{ text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }>
  language: OcrLanguage
  updatedAt: string
  status: 'complete' | 'failed'
  lowConfidence: boolean
}

export type OcrTextLayerMatch = {
  index: number
  start: number
  end: number
  source?: 'pdf' | 'ocr'
  language?: OcrLanguage
}

type OcrLayerItem = {
  text: string
  confidence: number
  x: number
  y: number
  width: number
  height: number
  start: number
  end: number
  kind: 'word' | 'line'
}

export function OcrTextLayer({
  result,
  rotation,
  matches,
  showConfidence,
  searchMatchAttribute = 'data-search-match',
}: {
  result: OcrTextLayerResult
  rotation: number
  matches: OcrTextLayerMatch[]
  showConfidence: boolean
  searchMatchAttribute?: 'data-search-match' | 'data-split-search-match'
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => buildOcrLayerItems(result, rotation), [result, rotation])

  useEffect(() => {
    const layer = layerRef.current
    const container = layer?.parentElement
    if (!layer || !container) return

    let page: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null

    function syncToPage() {
      if (!container || !layer) return
      const nextPage = container.querySelector<HTMLElement>('.react-pdf__Page')
      if (!nextPage) return
      if (page !== nextPage) {
        resizeObserver?.disconnect()
        page = nextPage
        resizeObserver = new ResizeObserver(syncToPage)
        resizeObserver.observe(nextPage)
      }
      layer.style.width = `${nextPage.offsetWidth}px`
      layer.style.height = `${nextPage.offsetHeight}px`
    }

    const mutationObserver = new MutationObserver(syncToPage)
    mutationObserver.observe(container, { childList: true, subtree: true })
    syncToPage()
    return () => {
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
    }
  }, [])

  if (items.length === 0) return null

  return (
    <div
      ref={layerRef}
      data-ocr-text-layer=""
      data-page-number={result.pageNumber}
      className="react-pdf__Page__textContent absolute left-1/2 top-0 z-[12] -translate-x-1/2 overflow-hidden"
      aria-label={`OCR text layer for page ${result.pageNumber}`}
      style={{ userSelect: 'text', pointerEvents: 'none' }}
    >
      {items.map((item, index) => {
        const matched = matches.find(
          (match) =>
            match.source === 'ocr' &&
            match.language === result.language &&
            match.start < item.end &&
            match.end > item.start,
        )
        const lowConfidence = item.confidence < 55 || result.lowConfidence
        const searchAttributes = matched ? { [searchMatchAttribute]: String(matched.index) } : {}
        return (
          <span
            key={`${item.start}-${item.end}-${index}`}
            data-ocr-text=""
            {...searchAttributes}
            className={`absolute block whitespace-pre text-transparent selection:bg-blue-400/35 ${
              showConfidence && lowConfidence ? 'border-b border-dotted border-amber-400/65' : ''
            }`}
            style={{
              pointerEvents: 'auto',
              left: `${item.x * 100}%`,
              top: `${item.y * 100}%`,
              width: `${item.width * 100}%`,
              height: `${item.height * 100}%`,
              fontSize: `${Math.max(8, item.height * 100)}%`,
              lineHeight: 1,
              transformOrigin: 'left top',
            }}
            title={showConfidence ? `OCR confidence ${Math.round(item.confidence)}%` : undefined}
          >
            {item.text}
            {item.kind === 'word' ? ' ' : ''}
          </span>
        )
      })}
    </div>
  )
}

export function selectOcrLayerResult<T extends OcrTextLayerResult>(
  results: T[],
  language: OcrLanguage,
) {
  const completed = results.filter((result) => result.status === 'complete' && result.text.trim())
  return (
    completed.find((result) => result.language === language) ??
    [...completed].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ??
    null
  )
}

function buildOcrLayerItems(result: OcrTextLayerResult, rotation: number): OcrLayerItem[] {
  const sourceItems = result.words.length > 0
    ? result.words.map((item) => ({ ...item, kind: 'word' as const }))
    : result.lines.map((item) => ({ ...item, kind: 'line' as const }))
  if (sourceItems.length === 0) return []

  const fallbackWidth = Math.max(...sourceItems.map((item) => item.x1), 1)
  const fallbackHeight = Math.max(...sourceItems.map((item) => item.y1), 1)
  const imageWidth = result.imageWidth > 0 ? result.imageWidth : fallbackWidth
  const imageHeight = result.imageHeight > 0 ? result.imageHeight : fallbackHeight
  let cursor = 0

  return sourceItems.flatMap((item) => {
    const text = item.text.trim()
    if (!text) return []
    const foundAt = result.text.indexOf(text, cursor)
    const start = foundAt >= 0 ? foundAt : cursor
    const end = start + text.length
    cursor = end
    const rectangle = transformHighlightRectangle(
      {
        x: clampUnit(item.x0 / imageWidth),
        y: clampUnit(item.y0 / imageHeight),
        width: clampUnit((item.x1 - item.x0) / imageWidth),
        height: clampUnit((item.y1 - item.y0) / imageHeight),
      },
      normalizeRotation(rotation - result.pageRotation),
    )
    return [{
      text,
      confidence: item.confidence,
      x: rectangle.x,
      y: rectangle.y,
      width: rectangle.width,
      height: rectangle.height,
      start,
      end,
      kind: item.kind,
    }]
  })
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value))
}

function normalizeRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360
}
