export function mergeRefreshedHistory(currentItems, refreshedItems, total) {
  const refreshedIds = new Set(refreshedItems.map((item) => item.id));
  const merged = [
    ...refreshedItems,
    ...currentItems.filter((item) => !refreshedIds.has(item.id)),
  ];
  const limit = Number.isFinite(total) && total >= 0 ? total : merged.length;
  return merged.slice(0, limit);
}
