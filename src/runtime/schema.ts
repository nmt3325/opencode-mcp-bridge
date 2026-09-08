import { Schema } from "effect"
export const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
