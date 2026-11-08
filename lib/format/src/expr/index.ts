export { ExprError, type ExprErrorKind } from './errors';
export {
  compileExpression,
  expressionNames,
  renameInExpression,
  isReservedWord,
  RESERVED_WORDS,
  GRAMMAR,
  type CompiledExpression,
  type ExpressionJson,
  type ExprRef,
} from './expression';
export { checkTypes, evaluateExpression, type EvaluationContext, type TypeEnvironment } from './evaluate';
export { parseLookupTable, type LookupTable } from './lookup';
export { checkTargetType, toStored, fromStored, typeOfTarget, type ValueTarget, type ValueType } from './stored';
export { QUANTITIES, UNIT_NAMES, quantityNamed, quantityOf, type Dimension, type Quantity } from './units';
export type { ExprType, ExprValue, Vector3 } from './values';
