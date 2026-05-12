function toComparable(value) {
  if (value === null || value === undefined || value === '') return Number.NEGATIVE_INFINITY;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsedDate = Date.parse(value);
  if (Number.isFinite(parsedDate)) return parsedDate;
  const parsedNumber = Number(value);
  if (Number.isFinite(parsedNumber)) return parsedNumber;
  return Number.NEGATIVE_INFINITY;
}

export function sortNewestFirst(items = [], keys = ['created_at', 'id']) {
  return [...items].sort((left, right) => {
    for (const key of keys) {
      const leftValue = toComparable(left?.[key]);
      const rightValue = toComparable(right?.[key]);
      if (leftValue !== rightValue) return rightValue - leftValue;
    }
    return 0;
  });
}
