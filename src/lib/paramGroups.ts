import type { DashboardCard, ParamGroup, ParamValues, WidgetDef } from "./types";

/**
 * Parameter groups: one value shared by several cards.
 *
 * The rules live here as pure functions rather than inside WidgetCard, because
 * the interesting behaviour — which parameter wins, which cards a change
 * propagates to — is exactly what needs testing without a DOM.
 */

/** The groups a card belongs to that actually exist on its dashboard. */
export function groupsForCard(
  card: DashboardCard,
  groups: ParamGroup[] | undefined
): ParamGroup[] {
  if (!groups || groups.length === 0 || !card.groups || card.groups.length === 0) return [];
  const ids = new Set(card.groups);
  return groups.filter((g) => ids.has(g.id));
}

/**
 * Which of a widget's parameters are supplied by a group.
 *
 * Membership alone is not enough: a card can belong to a group whose parameter
 * its widget does not declare — Workspace allows that, and an imported layout
 * often has it. Binding regardless would append a query parameter the endpoint
 * never asked for.
 */
export function groupedParamNames(
  widget: WidgetDef | undefined,
  card: DashboardCard,
  groups: ParamGroup[] | undefined
): Set<string> {
  const out = new Set<string>();
  if (!widget) return out;
  const declared = new Set((widget.params ?? []).map((p) => p.paramName));
  for (const g of groupsForCard(card, groups)) {
    if (declared.has(g.paramName)) out.add(g.paramName);
  }
  return out;
}

/**
 * The parameter values a card should actually fetch with: its own, with any
 * group-bound parameter overridden by the group's shared value.
 *
 * The group wins deliberately. A card's stored value for a grouped parameter is
 * stale by definition — it is whatever the card held before it joined, or what
 * the widget seeded at import — and letting it win would make the group visibly
 * do nothing.
 */
export function effectiveParams(
  widget: WidgetDef | undefined,
  card: DashboardCard,
  groups: ParamGroup[] | undefined
): ParamValues {
  const bound = groupedParamNames(widget, card, groups);
  if (bound.size === 0) return card.params;

  const merged: ParamValues = { ...card.params };
  for (const g of groupsForCard(card, groups)) {
    if (bound.has(g.paramName)) merged[g.paramName] = g.value;
  }
  return merged;
}

/**
 * Splits an edited parameter set into the group updates and the card-local
 * values, so applying an edit writes each to the right place.
 *
 * Without the split, editing a grouped parameter would persist onto the card
 * and be immediately masked by the group on the next render — the control would
 * snap back and the change would look lost.
 */
export function splitParamEdit(
  widget: WidgetDef | undefined,
  card: DashboardCard,
  groups: ParamGroup[] | undefined,
  edited: ParamValues
): { cardParams: ParamValues; groupUpdates: { id: string; value: ParamValues[string] }[] } {
  const bound = groupedParamNames(widget, card, groups);
  if (bound.size === 0) return { cardParams: edited, groupUpdates: [] };

  const cardParams: ParamValues = {};
  for (const [k, v] of Object.entries(edited)) {
    if (!bound.has(k)) cardParams[k] = v;
  }

  const groupUpdates: { id: string; value: ParamValues[string] }[] = [];
  for (const g of groupsForCard(card, groups)) {
    if (!bound.has(g.paramName)) continue;
    const next = edited[g.paramName];
    // Only report real changes: writing every group on every Apply would
    // refetch every member card whether or not anything moved.
    if (next !== undefined && next !== g.value) groupUpdates.push({ id: g.id, value: next });
  }

  return { cardParams, groupUpdates };
}
