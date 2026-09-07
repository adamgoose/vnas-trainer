/**
 * The control positions. Each one contributes its rules to the World, the
 * hints the UI shows, and (from Phase 5) its prompt fragments. Ground has the
 * ASDE-X scope; Local adds the STARS pane (src/positions/local); Center works
 * the ARTCC on ERAM (src/positions/center).
 */
import { CENTER_RULES, GROUND_RULES, LOCAL_RULES, TRACON_RULES, type PositionRules } from '../domain/rules'
import type { World } from '../domain/world'

export type PositionMode = 'ground' | 'tower' | 'tracon' | 'center'

export type Position = Readonly<{
  mode: PositionMode
  label: string
  rules: PositionRules
  placeholder: string
  tips: (world: World) => string
  hasRadar: boolean
  /** the ERAM display (Center) */
  hasEram: boolean
  /** the ASDE-X ground scope is useful here (Approach shows only STARS) */
  groundScope: boolean
  /** STARS pane range when the position is taken up, nm */
  scopeRangeNm: number
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
  hasEram: false,
  groundScope: true,
  scopeRangeNm: 15,
}

export const local: Position = {
  mode: 'tower',
  label: 'Local',
  rules: LOCAL_RULES,
  placeholder: "DAL1234 CTO · or type it the way you'd say it on frequency",
  tips: () => 'LUAW · CTO · TRACK · CD · CTL · GA · FH 090 · CM 5000 · switch on Arrivals',
  hasRadar: true,
  hasEram: false,
  groundScope: true,
  scopeRangeNm: 15,
}

export const tracon: Position = {
  mode: 'tracon',
  label: 'Approach',
  rules: TRACON_RULES,
  placeholder: "DAL1234 DM 4000 · or type it the way you'd say it on frequency",
  tips: (world) => {
    const star = Object.values(world.nav.stars)[0]
    const fix = star?.common[star.common.length - 1] ?? Object.keys(world.nav.fixes)[0] ?? 'FIX'
    const rw = Object.keys(world.graph.runwayEnds)[0] ?? '—'
    return `DM 4000 · SPD 210 · DCT ${fix} · FH 240 · CAPP ${rw} · CT · CD · switch on Arrivals`
  },
  hasRadar: true,
  hasEram: false,
  groundScope: false,
  scopeRangeNm: 40,
}

export const center: Position = {
  mode: 'center',
  label: 'Center',
  rules: CENTER_RULES,
  placeholder: 'DAL1234 DM FL240 · QZ 240 DAL1234 · or type it the way you\'d say it on frequency',
  tips: (world) => {
    const fix = Object.keys(world.nav.fixes).find((f) => /^[A-Z]{5}$/.test(f)) ?? 'FIX'
    const sector = world.airport.sectors[0]?.sector ?? '01'
    return `DM FL240 · SPD 280 · DCT ${fix} · QZ 240 · QQ 110 · QS 270 · ${sector} (handoff) · CA · CD`
  },
  hasRadar: false,
  hasEram: true,
  groundScope: false,
  scopeRangeNm: 150,
}

export const positionFor = (mode: PositionMode): Position => (mode === 'tower' ? local : mode === 'tracon' ? tracon : mode === 'center' ? center : ground)
