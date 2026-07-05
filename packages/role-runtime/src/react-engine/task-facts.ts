// Stage 8 engine cleanup — TaskFacts react-engine wrapper.
//
// The implementation lives in a neutral role-runtime module so both the inline
// reference path and react-engine policies can share the same task-fact logic
// without making shared helpers import react-engine internals.
export * from "../task-facts-shared";
