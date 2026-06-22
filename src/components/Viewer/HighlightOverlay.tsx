import { memo, useEffect, useRef } from 'react'
import type { PdfHighlight } from '../../types/highlights'
import { transformHighlightRectangle } from '../../utils/highlights'

const HIGHLIGHT_COLORS = {
  yellow: { fill: 'rgb(251 191 36 / 30%)', border: 'rgb(245 158 11 / 46%)' },
  green: { fill: 'rgb(110 231 183 / 28%)', border: 'rgb(52 211 153 / 44%)' },
  blue: { fill: 'rgb(125 211 252 / 28%)', border: 'rgb(56 189 248 / 44%)' },
  purple: { fill: 'rgb(196 181 253 / 30%)', border: 'rgb(167 139 250 / 48%)' },
} as const

export const HighlightOverlay = memo(function HighlightOverlay({
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
              title={`${highlight.text}${highlight.note ? '\nNote Attached' : ''}\nRight-click for options`}
              className={`pointer-events-none absolute rounded-[2px] border transition-[box-shadow,opacity] duration-150 ${
                focused ? 'highlight-pulse ring-2 ring-white/80' : ''
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
})

function normalizeRotation(rotation: number) {
  return ((rotation % 360) + 360) % 360
}
