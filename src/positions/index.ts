/**
 * The control positions. Each one contributes its rules to the World, the
 * hints the UI shows, and (from Phase 5) its prompt fragments. Ground has the
 * ASDE-X scope; Local adds the STARS pane (src/positions/local).
 */
import { GROUND_RULES, LOCAL_RULES, type PositionRules } from '../domain/rules'
import type { World } from '../domain/world'

export type PositionMode = 'ground' | 'tower'

export type Position = Readonly<{
  mode: PositionMode
  label: string
  rules: PositionRules
  placeholder: string
  tips: (world: World) => string
  hasRadar: boolean
}>

export const ground: Position = {
  mode: 'ground',
  label: 'Ground',
  rules: GROUND_RULES,
  placeholder: "DAL1234 PUSH · or type it the way you'd say it on frequency",
  tips: (world) => {
    const rw = Object.keys(world.graph.runwayEnds)[0] ?? '—'
    const tw = Object.keys(world.graph.taxiways).slice(0, 2).join(' ')
    return `PUSH · RWY ${rw} TAXI ${tw} · CROSS · LUAW · CTO`
  },
  hasRadar: false,
}

export const local: Position = {
  mode: 'tower',
  label: 'Local',
  rules: LOCAL_RULES,
  placeholder: "DAL1234 CTO · or type it the way you'd say it on frequency",
  tips: () => 'LUAW · CTO · TRACK · CD · CTL · GA · FH 090 · CM 5000 · switch on Arrivals',
  hasRadar: true,
}

export const positionFor = (mode: PositionMode): Position => (mode === 'tower' ? local : ground)
