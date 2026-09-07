import type { Html, HtmlBuilder } from 'foldkit/html'

import { Message } from '../app/message'
import { type Model, worldOf } from '../app/model'
import type { Aircraft, AircraftState } from '../domain/aircraft'
import { STATE_COLOUR, STATE_TEXT } from './scope'

const RANK: Readonly<Record<AircraftState, number>> = {
  AIRB: 0, TKOF: 0, FINAL: 0, LUAW: 1, ROLLOUT: 1, SHORT: 2, HOLD: 2, TAXI: 3, PUSH: 3, PUSHED: 4, PARKED: 6,
}
const rank = (a: Aircraft): number => (a.delay > 0 ? 8 : RANK[a.state])

const flightPlanView = (a: Aircraft, h: HtmlBuilder<Message>): Html => {
  const fp = a.flightPlan
  if (fp.route === null && fp.cruiseAltitude === null && fp.remarks === null && a.departure === null) {
    return h.div([h.Class('fp')], [h.span([h.Class('k')], ['no flight plan'])])
  }
  const altitude = fp.cruiseAltitude === null ? null : fp.cruiseAltitude >= 18000 ? `FL${Math.round(fp.cruiseAltitude / 100)}` : `${fp.cruiseAltitude} ft`
  const head = [fp.rules === 'V' ? 'VFR' : 'IFR', fp.fullType ?? a.type, `${a.departure ?? '—'} → ${a.destination ?? '—'}`, altitude, fp.cruiseSpeed === null ? null : `${fp.cruiseSpeed} kt`]
    .filter((x): x is string => x !== null)
    .join(' · ')
  const tags = [fp.sid === null ? null : `SID ${fp.sid}`, fp.star === null ? null : `STAR ${fp.star}`, fp.approach === null ? null : `APP ${fp.approach}`]
    .filter((x): x is string => x !== null)
    .join(' · ')
  return h.div(
    [h.Class('fp')],
    [
      h.div([], [head]),
      tags === '' ? h.empty : h.div([h.Class('tags')], [tags]),
      fp.route === null ? h.div([h.Class('k')], ['no route']) : h.div([h.Class('rte')], [fp.route]),
      fp.remarks === null ? h.empty : h.div([h.Class('k')], [`rmk ${fp.remarks}`]),
      h.div([h.Class('k')], [`squawk ${a.squawk}`]),
    ],
  )
}

export const stripView = (model: Model, airportId: string, a: Aircraft, h: HtmlBuilder<Message>): Html => {
  const pending = a.delay > 0
  const colour = pending ? '#55646c' : STATE_COLOUR[a.state]
  const selected = a.callsign === model.selected
  const fp = a.flightPlan
  const procedure =
    fp.sid !== null
      ? h.b([h.Class('sid')], [fp.sid])
      : fp.star !== null && !(a.departure ?? '').endsWith(airportId)
        ? h.b([h.Class('sid star')], [fp.star])
        : fp.rules === 'V'
          ? h.b([h.Class('sid vfr')], ['VFR'])
          : fp.route !== null
            ? h.b([h.Class('sid none')], ['no SID'])
            : h.empty
  const altitude =
    a.state === 'AIRB' || a.state === 'FINAL'
      ? h.b([], [`${Math.round(a.altitude / 100) * 100} ft${a.state === 'AIRB' && Math.abs(a.targetAltitude - a.altitude) >= 100 ? ` ${a.targetAltitude > a.altitude ? '↑' : '↓'}${Math.round(a.targetAltitude / 100) * 100}` : ''}`])
      : h.empty
  const navigation =
    a.state === 'AIRB'
      ? h.b([h.Class('accent')], [a.established ? `on final ${a.approach}` : a.approach !== null ? `app ${a.approach}` : a.fixes[0] !== undefined ? `→ ${a.fixes[0]}` : `hdg ${String(Math.round(a.targetHeading)).padStart(3, '0')}`])
      : h.empty
  const speed = a.state === 'AIRB' && a.assignedSpeed !== null ? h.b([], [`${a.assignedSpeed} kt`]) : h.empty
  const needsClearance = a.state === 'FINAL' && !a.clearedToLand && model.settings.mode === 'tower'
  return h.keyed('div')(
    a.callsign,
    [
      h.Class('strip'),
      h.AriaSelected(selected),
      h.Role('button'),
      h.Tabindex(0),
      h.Style(pending ? { opacity: '.55' } : {}),
      h.OnClick(Message.ClickedStrip({ callsign: a.callsign })),
    ],
    [
      h.span([h.Class('cs')], [a.callsign]),
      h.span([h.Class('st'), h.Style({ color: colour })], [pending ? 'pending' : STATE_TEXT[a.state]]),
      h.span(
        [h.Class('sub')],
        [
          procedure,
          h.b([], [a.type]),
          a.gate !== null ? h.b([], [a.gate]) : h.empty,
          a.runway !== null ? h.b([], [`rwy ${a.runway}${a.intersection !== null ? ` at ${a.intersection}` : ''}`]) : h.empty,
          altitude,
          navigation,
          speed,
          needsClearance ? h.b([h.Style({ color: '#e0a63a' })], ['no CTL']) : h.empty,
          a.handoff ? h.b([h.Class('accent')], ['H/O']) : a.radar !== null && !a.tracked ? h.b([], ['untracked']) : h.empty,
          a.destination !== null ? h.span([], [`→ ${a.destination}`]) : h.empty,
          pending ? h.b([], [`+${Math.ceil(a.delay)}s`]) : h.empty,
          a.blockedBy !== null ? h.b([], [`behind ${a.blockedBy}`]) : h.empty,
        ],
      ),
      selected ? flightPlanView(a, h) : h.empty,
    ],
  )
}

/** The selected aircraft's strip, details open, for the top-left corner of the ground scope. */
export const selectedStripView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const a = model.selected === null || world === null ? undefined : world.aircraft.find((x) => x.callsign === model.selected)
  return a === undefined ? h.empty : h.div([h.Class('scope-strip')], [stripView(model, world?.airport.id ?? '', a, h)])
}

export const stripsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const world = worldOf(model)
  const list = [...(world?.aircraft ?? [])].sort((a, b) => rank(a) - rank(b) || a.callsign.localeCompare(b.callsign))
  const pending = list.filter((a) => a.delay > 0).length
  return h.aside(
    [],
    [
      h.div(
        [h.Class('aside-h')],
        [h.span([], ['Aircraft']), h.b([], [world === null ? '' : `${list.length - pending} on frequency${pending > 0 ? ` · ${pending} pending` : ''}`])],
      ),
      h.div([h.Class('strips')], list.map((a) => stripView(model, world?.airport.id ?? '', a, h))),
    ],
  )
}
