import { useEffect, useRef } from 'react'
import type { PdfHighlight } from '../../types/highlights'
import { transformHighlightRectangle } from '../../utils/highlights'

const HIGHLIGHT_COLORS = {
  yellow: { fill: 'rgb(250 204 21 / 42%)', border: 'rgb(202 138 4 / 65%)' },
  green: { fill: 'rgb(74 222 128 / 38%)', border: 'rgb(22 163 74 / 65%)' },
  blue: { fill: 'rgb(96 165 250 / 38%)', border: 'rgb(37 99 235 / 65%)' },
} as const

export function HighlightOverlay({
  highlights,
  rotation,
  focusedHighlightId,
}: {
  highlights: PdfHighlight[]
  rotation: number
  focusedHighlightId: string | null
}) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    const container = overlay?.parentElement
    if (!overlay || !container) {
      return
    }
    const activeOverlay = overlay
    const activeContainer = container

    let page: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null

    function syncToPage() {
      const nextPage = activeContainer.querySelector<HTMLElement>('.react-pdf__Page')
      if (!nextPage) {
        return
      }

      if (page !== nextPage) {
        resizeObserver?.disconnect()
        page = nextPage
        resizeObserver = new ResizeObserver(syncToPage)
        resizeObserver.observe(page)
      }

      activeOverlay.style.width = `${page.offsetWidth}px`
      activeOverlay.style.height = `${page.offsetHeight}px`
    }

    const mutationObserver = new MutationObserver(syncToPage)
    mutationObserver.observe(activeContainer, { childList: true, subtree: true })
    syncToPage()

    return () => {
      mutationObserver.disconnect()
      resizeObserver?.disconnect()
    }
  }, [])

  return (
    <div
      ref={overlayRef}
      data-highlight-overlay=""
      className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 overflow-hidden"
    >
      {highlights.flatMap((highlight) =>
        highlight.rectangles.map((rectangle, index) => {
          const transformed = transformHighlightRectangle(
            rectangle,
            normalizeRotation(rotation - highlight.rotation),
          )
          const colors = HIGHLIGHT_COLORS[highlight.color]
          const focused = highlight.id === focusedHighlightId

          return (
            <div
              key={`${highlight.id}-${index}`}
              data-highlight-id={highlight.id}
              title={`${highlight.text}\nRight-click to remove`}
              className={`pointer-events-none absolute rounded-[2px] border transition-[box-shadow,opacity] duration-150 ${
                focused ? 'ring-2 ring-white ring-offset-1 ring-offset-blue-500' : ''
              }`}
              style={{
                left: `${transformed.x * 100}%`,
                top: `${transformed.y * 100}%`,
                width: `${transformed.width * 100}%`,
                height: `${transformed.height * 100}%`,
                backgroundColor: colors.fill,
                borderColor: colors.border,
                mixBlendMode: 'multiply',
              }}
            />
          )
        }),
      )}
    </div>
  )
}

function normalizeRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360
}
