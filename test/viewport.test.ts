import { describe, expect, test } from 'bun:test'

import { buildGraph } from '../src/domain/graph'
import { MAX_VIEW_FRACTION, fit, maxViewWidthFt, viewWidthFt, worldSize, zoomCentre } from '../src/view/viewport'
import { msp } from './helpers'

describe('ground scope viewport', () => {
  const graph = buildGraph(msp.map)
  const base = { scale: 1, originX: 0, originY: 0, width: 0, height: 0, fitted: false }
  const zoomOutFully = (width: number, height: number) => {
    let view = fit(graph, { ...base, width, height })
    for (let i = 0; i < 40; i++) {
      view = zoomCentre(graph, view, 1.42)
    }
    return view
  }

  /** Whatever the pane's shape, fully zoomed out the field spans at most a third of the view each way. */
  test('zooming out stops where the field is a third of the view on its longer side, for any aspect', () => {
    const { w, h } = worldSize(graph)
    for (const [width, height] of [[1600, 800], [500, 1400], [900, 900]] as const) {
      const view = zoomOutFully(width, height)
      expect(viewWidthFt(view)).toBeCloseTo(maxViewWidthFt(graph, view), 3)
      expect(viewWidthFt(view)).toBeGreaterThanOrEqual(w * MAX_VIEW_FRACTION - 1e-6)
      expect(view.height / view.scale).toBeGreaterThanOrEqual(h * MAX_VIEW_FRACTION - 1e-6)
      const limitedBy = viewWidthFt(view) - w * MAX_VIEW_FRACTION < 1e-6 ? 'width' : 'height'
      expect(limitedBy).toBe(w >= h * (width / height) ? 'width' : 'height')
    }
  })

  test('the old width-only clamp would have cut a wide pane short of the field height', () => {
    const view = zoomOutFully(1600, 800)
    expect(viewWidthFt(view)).toBeGreaterThan(worldSize(graph).w * MAX_VIEW_FRACTION)
  })
})
