/** A benchmark's class set cannot contain human edits without losing blindness. */
export function assertNoBenchmarkReviewEdits(record: {
  class_review?: { edits?: unknown[] } | null
}): void {
  const review = record.class_review
  // Older records predate review. When review is recorded, its audit must be
  // explicit; a malformed/missing edits array cannot stand for an empty one.
  if (review != null && (!Array.isArray(review.edits) || review.edits.length !== 0)) {
    throw new Error('A benchmark run must have class_review.edits == []')
  }
}
