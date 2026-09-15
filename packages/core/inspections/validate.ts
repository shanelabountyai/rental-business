// The closed vocabularies for the inspection engine (INSP-01, R-068), and
// the checklist-template input shape.
//
// A TYPE-only import for the two Prisma enums, deliberately - importing
// either as a VALUE drags the whole client into any client component that
// touches this file, the same bundle crash categories.ts's own header
// documents for NotificationChannel.
import type { InspectionType, ItemCondition } from '@rental/db'

export const INSPECTION_TYPES = [
  'MOVE_IN',
  'MOVE_OUT',
  'PRE_MOVE_OUT',
  'PERIODIC',
  'SEASONAL',
  'DRIVE_BY',
] as const satisfies readonly InspectionType[]
export type InspectionTypeValue = (typeof INSPECTION_TYPES)[number]

/// Which types a checklist may be designated the default FOR
/// (`InspectionTemplate.defaultForType`) - the types something other than a
/// person picking a template creates.
///
/// Was PERIODIC_TYPES until R-208. The column's question has never been "is
/// this on a calendar clock", it has been "when this type gets created
/// without anybody choosing a checklist, which checklist". MOVE_IN joined
/// the moment lease activation started opening one (move-in-consumer.ts);
/// `isPeriodicType` stays exactly what it was, because the periodic
/// scheduling job really does mean the calendar-driven three and nothing
/// else.
///
/// MOVE_OUT and PRE_MOVE_OUT are deliberately NOT here: both build their
/// checklist by copying the lease's own move-in walk (`itemsFromMoveIn`),
/// which is a better answer than any template, and neither has a fallback
/// worth configuring.
export const DEFAULTABLE_TYPES = [
  'MOVE_IN',
  'PERIODIC',
  'SEASONAL',
  'DRIVE_BY',
] as const satisfies readonly InspectionType[]
export type DefaultableTypeValue = (typeof DEFAULTABLE_TYPES)[number]

export function isDefaultableType(value: string): value is DefaultableTypeValue {
  return (DEFAULTABLE_TYPES as readonly string[]).includes(value)
}

export const ITEM_CONDITIONS = [
  'NEW',
  'GOOD',
  'FAIR',
  'POOR',
  'DAMAGED',
  'MISSING',
] as const satisfies readonly ItemCondition[]
export type ItemConditionValue = (typeof ITEM_CONDITIONS)[number]

interface Violation {
  field: string
  message: string
}

export function isInspectionType(value: string): value is InspectionTypeValue {
  return (INSPECTION_TYPES as readonly string[]).includes(value)
}

export function isItemCondition(value: string): value is ItemConditionValue {
  return (ITEM_CONDITIONS as readonly string[]).includes(value)
}

/// One row of a checklist template - `InspectionTemplate.items`' own shape,
/// and what an `Inspection`'s items get copied from at creation (R-068).
export interface TemplateChecklistItem {
  room: string
  item: string
}

/**
 * A template's checklist, validated as a whole - it is stored and read as
 * one JSON column (the model's own comment on why), so the shape has to be
 * checked here rather than by a database constraint.
 */
export function validateTemplateItems(
  items: readonly TemplateChecklistItem[],
): Violation[] {
  if (items.length === 0) {
    return [{ field: 'items', message: 'Add at least one checklist item.' }]
  }
  const violations: Violation[] = []
  items.forEach((row, index) => {
    if (!row.room?.trim()) {
      violations.push({ field: `items.${index}.room`, message: 'Every item needs a room.' })
    }
    if (!row.item?.trim()) {
      violations.push({ field: `items.${index}.item`, message: 'Every item needs a name.' })
    }
  })
  return violations
}

export interface InspectionTemplateInput {
  name: string
  items: readonly TemplateChecklistItem[]
}

export function validateInspectionTemplate(
  input: InspectionTemplateInput,
): Violation[] {
  const violations: Violation[] = []
  if (!input.name?.trim()) {
    violations.push({ field: 'name', message: 'Name this checklist.' })
  }
  violations.push(...validateTemplateItems(input.items))
  return violations
}

/// One item's own recorded condition + notes - what the walk actually
/// writes, as opposed to the template row it started from.
export function validateItemRecord(input: {
  condition: string
  notes?: string | null
}): Violation[] {
  if (!isItemCondition(input.condition)) {
    return [{ field: 'condition', message: 'Choose a condition.' }]
  }
  return []
}
