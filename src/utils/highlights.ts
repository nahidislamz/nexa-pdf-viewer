import type { HighlightRectangle } from '../types/highlights'

export function transformHighlightRectangle(
  rectangle: HighlightRectangle,
  rotation: number,
): HighlightRectangle {
  if (rotation === 90) {
    return {
      x: 1 - rectangle.y - rectangle.height,
      y: rectangle.x,
      width: rectangle.height,
      height: rectangle.width,
    }
  }

  if (rotation === 180) {
    return {
      x: 1 - rectangle.x - rectangle.width,
      y: 1 - rectangle.y - rectangle.height,
      width: rectangle.width,
      height: rectangle.height,
    }
  }

  if (rotation === 270) {
    return {
      x: rectangle.y,
      y: 1 - rectangle.x - rectangle.width,
      width: rectangle.height,
      height: rectangle.width,
    }
  }

  return rectangle
}
